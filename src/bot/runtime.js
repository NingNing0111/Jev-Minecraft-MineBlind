const { WorkingMemory, RunMemory, WorldModel, KnowledgeMemory } = require('../memory/state');
const { GoalManager } = require('../goal/manager');
const { SaveSystem } = require('../save/save_system');
const { evaluate } = require('../escalation/gate');
const { decide } = require('../jev/client');
const { createPlanner } = require('../agent/planner');
const { SkillExecutor } = require('../skills/executor');
const { ActionArbiter, reflex } = require('./arbiter');
const { extractState } = require('../perception');
const { EventQueue } = require('./events');
class Runtime {
  constructor(bot, config, broadcast = () => {}) {
    this.bot = bot; this.config = config; this.broadcast = broadcast;
    this.saveSystem = new SaveSystem(config.saveRoot, { world: config.worldId, mode: config.mode });
    const saved = config.restore ? this.saveSystem.restore(config.restore) : {};
    this.run = new RunMemory(saved.run_memory); this.world = new WorldModel(saved.world_model);
    this.working = new WorkingMemory(); this.manager = new GoalManager(config.stagnationMs, saved.goal_manager);
    this.plan = saved.agent_plan || null; this.events = new EventQueue(); this.events.push('startup');
    this.epoch = 0; this.stopped = false; this.paused = false; this.started = false; this.runningTick = false;
    this.structures = new Set(this.world.data.structures);
    this.planner = config.agent ? createPlanner(config, new KnowledgeMemory(config.knowledgeRoot, config.memory)) : null;
    this.executor = new SkillExecutor(bot, event => this.skillResult(event));
    this.arbiter = new ActionArbiter(this.executor); this.log = [];
    this.lastSave = Date.now(); this.nextAgent = 0; this.controller = new AbortController();
    this.onPhysics = () => this.physics();
    this.onHealth = () => { this.physics(); this.wake(); };
    this.onInventory = () => this.wake();
    this.onDeath = () => { this.run.data.deaths++; this.invalidate('death'); };
    this.onRespawn = () => this.invalidate('dimension_change');
    this.onVictory = entity => {
      if (entity.name === 'ender_dragon' && String(bot.game.dimension).includes('end')) {
        this.run.data.victory = true; this.invalidate('victory');
      }
    };
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.bot.on('health', this.onHealth);
    this.bot.inventory?.on('updateSlot', this.onInventory);
    this.bot.on('physicsTick', this.onPhysics); this.bot.on('death', this.onDeath);
    this.bot.on('respawn', this.onRespawn); this.bot.on('entityDead', this.onVictory);
    this.schedule();
  }
  observe() {
    const o = extractState(this.bot); o.structures = [...this.structures]; o.dragonDefeated = this.run.data.victory;
    return o;
  }
  physics() {
    if (this.stopped || this.paused || !this.bot.entity || this.bot.health <= 0) return;
    try {
      const o = this.observe(); const r = reflex(this.bot, o);
      if (r) this.arbiter.submit(r.skill, r.params, r.priority);
      this.arbiter.tick();
    } catch (error) { this.saveSystem.log('reflex_error', { error: error.message }); }
  }
  invalidate(reason) {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();
    this.executor.cancel(reason); this.arbiter.pending = null; this.arbiter.suspended = null;
    // Lifecycle changes supersede pending planning requests from the old state.
    this.events.clear();
    this.events.push(reason, { priority: 0, source: 'lifecycle' });
    this.save(reason); this.wake();
  }
  skillResult(event) {
    this.working.add(event); this.saveSystem.log(event.type, event);
    if (event.result?.structure) {
      this.structures.add(event.result.structure); this.world.data.structures = [...this.structures];
      this.world.data.locations[event.result.structure] = event.result.position;
    }
    if (event.type === 'skill_failed' && !['EAT','WATER','FLEE'].includes(event.skill)) {
      this.lastFailure = event;
      this.epoch++; this.controller.abort(); this.controller = new AbortController();
      this.events.push('goal_failed', { priority: 1, source: 'skill' });
      this.save('goal_failed');
    }
    this.wake();
  }
  save(reason) {
    try {
      this.lastSave = Date.now();
      return this.saveSystem.save({ run_memory: this.run.data, world_model: this.world.snapshot(),
        goal_manager: this.manager.snapshot(), agent_plan: this.plan, metrics: this.run.metrics() }, reason);
    } catch (error) { console.error('[Save]', error.message); this.saveError = error.message; }
  }
  pause() { this.paused = true; this.epoch++; this.controller.abort(); this.arbiter.pause(); }
  resume() {
    if (!this.paused || this.stopped) return;
    this.controller = new AbortController(); this.paused = false; this.arbiter.resume(); this.wake();
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer); this.pause();
    this.bot.removeListener('health', this.onHealth);
    this.bot.inventory?.removeListener('updateSlot', this.onInventory);
    this.bot.removeListener('physicsTick', this.onPhysics); this.bot.removeListener('death', this.onDeath);
    this.bot.removeListener('respawn', this.onRespawn); this.bot.removeListener('entityDead', this.onVictory);
    this.save('shutdown');
  }
  wake() {
    if (!this.started || this.stopped || this.paused) return;
    this.wakePending = true;
    if (!this.runningTick) this.schedule(50);
  }
  schedule(delay = this.config.decisionMs) {
    if (this.stopped) return;
    // Keep the earliest deadline: noisy inventory events must not starve a tick.
    const due = Date.now() + delay;
    if (this.timer && this.timerDue <= due) return;
    clearTimeout(this.timer); this.timerDue = due;
    this.timer = setTimeout(async () => {
      this.timer = null; this.wakePending = false; this.runningTick = true;
      try { await this.tick(); }
      finally {
        this.runningTick = false;
        this.schedule(this.wakePending ? 50 : this.config.decisionMs);
      }
    }, delay);
  }
  async replan(reason, o, epoch, help = null) {
    if (!this.planner || (this.config.gate && Date.now() < this.nextAgent)) return false;
    const stalled = Math.min(1, (Date.now() - this.manager.lastProgress) / this.config.stagnationMs);
    const scores = { stagnation: reason === 'stagnation' ? 1 : stalled, uncertainty: help ? 1 : .6,
      invalid: ['startup','goal_complete','goal_failed','death','dimension_change'].includes(reason) || help ? 1 : .7, value: 1 };
    // System lifecycle events must get a plan; utility gates optional Jev help/stagnation.
    const gated = this.config.gate && (help || reason === 'stagnation');
    const gate = evaluate(scores); this.saveSystem.log('gate', { reason, ...gate, bypass: !gated });
    if (gated && gate.verdict !== 'approve') return false;
    this.nextAgent = Date.now() + this.config.agentCooldownMs;
    this.run.agentCalled();
    const context = { reason, observation: o, help, failure: this.lastFailure, run: this.run.data,
      world: this.world.snapshot(), currentGoal: this.manager.current(),
      capabilities: 'Explore, navigate with explicit coordinates, mine visible blocks with existing tools, craft from existing ingredients, melee, flee, local structure markers, chest loot. Nether portal construction needs 14 obsidian, flint_and_steel and a clear flat site. Smelting, End portal activation and full dragon mechanics are unavailable.' };
    this.saveSystem.log('agent_input', { context });
    try {
      const { plan, usage } = await this.planner.plan(context, AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]));
      if (epoch !== this.epoch || this.stopped || this.paused) return false;
      this.executor.cancel('replan'); this.arbiter.pending = null; this.arbiter.suspended = null;
      this.plan = plan; this.manager.setPlan(plan); this.pendingAgentResolution = true;
      this.run.data.tokens += Number(usage?.totalTokens || 0);
      this.saveSystem.log('agent_output', { plan, usage }); this.save('replan'); return true;
    } catch (error) {
      if (epoch === this.epoch && !this.stopped && !this.paused) {
        this.run.data.agentErrors++; this.saveSystem.log('agent_error', { error: error.message });
      }
      return false;
    }
  }
  async tick() {
    if (this.stopped || this.paused || !this.bot.entity || this.bot.health <= 0) return;
    const epoch = this.epoch;
    try {
      const o = this.observe(); this.run.update(o); const evidence = this.world.update(o);
      if (this.lastDimension && this.lastDimension !== o.dimension) {
        this.lastDimension = o.dimension; this.invalidate('dimension_change'); return;
      }
      this.lastDimension = o.dimension;
      const progress = this.manager.evaluate(o, evidence);
      if (progress?.type) {
        if (!this.events.has(progress.type)) {
          this.events.push(progress.type, { priority: progress.type === 'goal_complete' ? 1 : 3 }); this.run.data.keyDecisions++;
          if (progress.type === 'goal_complete') {
            this.run.data.completedGoals.push(progress.goal);
            if (this.pendingAgentResolution) { this.run.data.agentResolved++; this.pendingAgentResolution = false; }
          }
          this.save(progress.type);
        }
      }
      if (this.run.data.victory) { await this.stop(); return; }
      const event = this.events.peek();
      if (event) {
        this.saveSystem.log('decision_event', event);
        const planned = await this.replan(event.type, o, epoch);
        if (planned || !this.config.agent) this.events.acknowledge(event);
      }
      if (epoch !== this.epoch || this.paused || this.stopped) return;
      if (!this.executor.busy) {
        const tactical = this.manager.tactical(o, this.bot);
        // A has no planner: the same skill selector sees the terminal objective, not a hidden strategy agent.
        if (!this.config.agent) tactical.objective = 'Defeat the Ender Dragon autonomously';
        const decision = await decide({ observation: o, goal: tactical, workingMemory: this.working.snapshot(), worldModel: this.world.snapshot() }, this.controller.signal);
        if (epoch !== this.epoch || this.paused || this.stopped) return;
        if (decision.action === 'REQUEST_AGENT') {
          this.run.data.keyDecisions++;
          const planned = await this.replan(decision.reason, o, epoch, decision);
          if (!planned && epoch === this.epoch && !this.paused && !this.stopped)
            this.arbiter.submit(tactical.skill, { target: tactical.target, amount: tactical.amount }, 3);
        } else this.arbiter.submit(decision.skill, decision.params, decision.skill === 'FIGHT_MOB' ? 2 : 3);
        this.working.add(decision); this.log.unshift({ timestamp: Date.now(), intent: decision.skill || decision.action, ...decision });
        this.log = this.log.slice(0, 50);
      }
      this.broadcast('state_update', { state: o, decision: { intent: this.executor.current?.skill || 'Idle', reason: this.manager.current()?.description || '自主探索' },
        log: this.log.slice(0, 10), ai_paused: this.paused,
        experiment: { mode: this.config.mode, goal: this.manager.current(), metrics: this.run.metrics(), evidence, saveError: this.saveError } });
      if (Date.now() - this.lastSave >= this.config.saveMs) this.save('periodic');
    } catch (error) { if (!this.controller.signal.aborted) this.saveSystem.log('runtime_error', { error: error.message }); }
  }
}
module.exports = { Runtime };
