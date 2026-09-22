const { SQLiteMemory } = require('../memory/sqlite');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WorkingMemory, RunMemory, WorldModel, KnowledgeMemory } = require('../memory/state');
const { ContainerMemory } = require('../memory/container_memory');
const { GoalManager } = require('../goal/manager');
const { SaveSystem } = require('../save/save_system');
const { evaluate } = require('../escalation/gate');
const { decide } = require('../jev/client');
const { actionOptions } = require('../jev/action-options');
const { createPlanner } = require('../agent/planner');
const { SkillExecutor } = require('../skills/executor');
const { ActionGuard } = require('../skills/action-guard');
const { ActionArbiter, reflex } = require('./arbiter');
const { extractState, extractLightState } = require('../perception');
const { EventQueue } = require('./events');
const { Exploration } = require('../exploration');
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
    this.exploration = new Exploration(this.world.data.exploration);
    this.containerMemory = new ContainerMemory(this.world.data.container_memory || {});
    this.executor = new SkillExecutor(bot, event => this.skillResult(event), this.exploration, this.containerMemory);
    this.actionGuard = new ActionGuard(bot); this.executor.guard = this.actionGuard;
    this.arbiter = new ActionArbiter(this.executor); this.log = [];
    this.lastSave = Date.now(); this.nextAgent = 0; this.controller = new AbortController();
    this.memory = new SQLiteMemory(path.resolve(config.saveRoot, 'memory', `${randomUUID()}.sqlite`),
      this.saveSystem.identity, this.saveSystem.restoredDatabase);
    this.saveSystem.attachStorage(this.memory);
    this.saveQueue = Promise.resolve();
    this.memoryReady = this.initializeMemory();
    this.memoryReady.catch(error => { this.saveError = error.message; });
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
  async initializeMemory() {
    await this.memory.ready;
    if (!this.saveSystem.restoredDatabase) {
      for (const key of this.world.chunks) {
        const split = key.lastIndexOf(':');
        const [x, z] = key.slice(split + 1).split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(z)) await this.memory.request('visit', { dimension: key.slice(0, split), x, z });
      }
      for (const entry of this.containerMemory.store.values()) await this.memory.request('record', {
        ...entry, dimension: entry.dimension || this.run.data.dimension || 'overworld' });
    }
    this.world.chunks.clear(); this.world.data.chunks = [];
    this.containerMemory.storage = this.memory;
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
    const o = extractState(this.bot, this.containerMemory);
    o.structures = [...this.structures]; o.dragonDefeated = this.run.data.victory;
    return o;
  }
  physics() {
    if (this.stopped || this.paused || !this.bot.entity || this.bot.health <= 0) return;
    try {
      const o = extractLightState(this.bot); const r = reflex(this.bot, o);
      if (r) this.arbiter.submit(r.skill, r.params, r.priority);
      this.arbiter.tick();
    } catch (error) { this.saveSystem.log('reflex_error', { error: error.message }); }
  }
  invalidate(reason) {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();
    this.executor.cancel(reason); this.arbiter.pending = null; this.arbiter.suspended = null;
    this.exploration.reset();
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
    if (event.type === 'skill_complete') this.actionGuard.success(event.skill, event.params);
    if (event.type === 'skill_failed' && !['EAT','WATER','FLEE'].includes(event.skill)) {
      const failure = this.actionGuard.fail(event.skill, event.params, event);
      this.lastFailure = { ...event, retryAt: failure.retryAt };
      this.epoch++; this.controller.abort(); this.controller = new AbortController();
      this.events.push('goal_failed', { priority: 1, source: 'skill' });
      // Checkpoint the first failure promptly, but coalesce subsequent failures.
      if (!this.lastFailureSave || Date.now() - this.lastFailureSave >= 30000) {
        this.lastFailureSave = Date.now(); this.save('goal_failed');
      }
    }
    this.wake();
  }
  save(reason) {
    this.lastSave = Date.now();
    // Capture at call time; serialize checkpoint work and handle fire-and-forget callers.
    this.world.data.exploration = this.exploration.snapshot();
    this.world.data.container_memory = { store: {} };
    let snapshot;
    try {
      snapshot = JSON.parse(JSON.stringify({ run_memory: this.run.data, world_model: this.world.snapshot(),
        goal_manager: this.manager.snapshot(), agent_plan: this.plan, metrics: this.run.metrics() }));
    } catch (error) {
      this.saveError = error.message;
      return Promise.resolve();
    }
    this.saveQueue = this.saveQueue.then(async () => {
      await this.memoryReady;
      await this.containerMemory.flush();
      return this.saveSystem.savePersistent(snapshot, reason);
    }).catch(error => { console.error('[Save]', error.message); this.saveError = error.message; });
    return this.saveQueue;
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
    await this.save('shutdown');
    await this.memory.close();
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
    if (!this.planner || Date.now() < this.nextAgent) return false;
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
      world: this.world.decisionContext(), currentGoal: this.manager.current(),
      actionFailures: this.actionGuard.context(),
      capabilities: 'Explore, navigate with explicit coordinates, mine visible blocks with existing tools, craft from existing ingredients (can place a carried table, including clearing one safe rock cell; feasibility uses live Mineflayer recipes and blocks), melee, flee, local structure markers, chest loot. Nether portal construction needs 14 obsidian, flint_and_steel and a clear flat site. Smelting, End portal activation and full dragon mechanics are unavailable.' };
    this.saveSystem.log('agent_input', { context });
    try {
      const { plan, usage } = await this.planner.plan(context, AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]));
      if (epoch !== this.epoch || this.stopped || this.paused) return false;
      this.executor.cancel('replan'); this.arbiter.pending = null; this.arbiter.suspended = null;
      this.plan = plan; this.manager.setPlan(plan); this.pendingAgentResolution = true;
      this.agentFailures = 0; this.agentError = null;
      this.nextAgent = Date.now() + this.config.agentCooldownMs;
      this.run.data.tokens += Number(usage?.totalTokens || 0);
      this.saveSystem.log('agent_output', { plan, usage }); this.save('replan'); return true;
    } catch (error) {
      if (epoch === this.epoch && !this.stopped && !this.paused) {
        this.agentFailures = (this.agentFailures || 0) + 1;
        this.nextAgent = Date.now() + Math.min(300000, this.config.agentCooldownMs * 2 ** Math.min(this.agentFailures - 1, 4));
        this.agentError = error.message;
        this.run.data.agentErrors++; this.saveSystem.log('agent_error', { error: error.message, retryAt: this.nextAgent });
      }
      return false;
    }
  }
  async tick() {
    if (this.stopped || this.paused || !this.bot.entity || this.bot.health <= 0) return;
    const epoch = this.epoch;
    try {
      await this.memoryReady;
      await this.containerMemory.refresh(this.memory, this.bot.entity.position, String(this.bot.game?.dimension || 'overworld'));
      if (epoch !== this.epoch || this.stopped || this.paused) return;
      const o = this.observe(); this.run.update(o); const evidence = await this.world.updatePersistent(o, this.memory);
      await this.saveSystem.flushEvents();
      if (epoch !== this.epoch || this.stopped || this.paused) return;
      // 将感知层的周围资源共享给 exploration，引导探索方向
      this.bot._perceptionResources = o.environment.nearby_resources || [];
      // Expensive terrain scans are cached and never run in the physics/reflex loop.
      o.environment.exploration = this.exploration.observe(this.bot, this.manager.tactical(o, this.bot).target || '');
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
      if (event && (!this.planner || Date.now() >= this.nextAgent)) {
        this.saveSystem.log('decision_event', event);
        const planned = await this.replan(event.type, o, epoch);
        if (planned || !this.config.agent) this.events.acknowledge(event);
      }
      if (epoch !== this.epoch || this.paused || this.stopped) return;
      if (!this.executor.busy) {
        const tactical = this.manager.tactical(o, this.bot);
        this.bot._perceptionResources = o.environment.nearby_resources || [];
        o.environment.exploration = this.exploration.observe(this.bot, tactical.target || '');
        // 若探索处于打转或卡住状态，上报 stagnation 事件触发 replan
        const expState = o.environment.exploration;
        if ((expState.stuck || expState.looping) && !this.events.has('stagnation')) {
          this.events.push('stagnation', { priority: 4, source: 'exploration' });
        }
        if (['EXPLORE_AREA', 'SEARCH_STRUCTURE'].includes(tactical.skill)) {
          tactical.position = o.environment.exploration.destination?.position;
          tactical.exploration = o.environment.exploration;
        }
        // A has no planner: the same skill selector sees the terminal objective, not a hidden strategy agent.
        if (!this.config.agent) tactical.objective = 'Defeat the Ender Dragon autonomously';
        const feasibility = this.actionGuard.check(tactical.skill, tactical);
        this.blockedAction = feasibility.ok ? null : { skill: tactical.skill, reason: feasibility.reason, retryAt: feasibility.retryAt };
        if (!feasibility.ok && !feasibility.cached) {
          this.skillResult({ type: 'skill_failed', skill: tactical.skill, params: tactical, code: feasibility.code, error: feasibility.reason });
          return;
        }
        // Do not repeatedly call the selector/model for an unchanged impossible action.
        const decision = feasibility.ok
          ? await decide({ observation: o, goal: tactical, workingMemory: this.working.snapshot(), worldModel: this.world.decisionContext() }, this.controller.signal)
          : null;
        if (epoch !== this.epoch || this.paused || this.stopped) return;
        if (decision?.action === 'REQUEST_AGENT') {
          this.run.data.keyDecisions++;
          const planned = await this.replan(decision.reason, o, epoch, decision);
          if (!planned && epoch === this.epoch && !this.paused && !this.stopped) {
            const options = actionOptions({ observation: o, goal: tactical, workingMemory: this.working.snapshot() });
            const skill = options[tactical.skill] ? tactical.skill : Object.keys(options)[0];
            if (skill) this.arbiter.submit(skill, options[skill], 3);
          }
        } else if (decision) this.arbiter.submit(decision.skill, decision.params, decision.skill === 'FIGHT_MOB' ? 2 : 3);
        if (decision) { this.working.add(decision); this.log.unshift({ timestamp: Date.now(), hp: o.player.hp, intent: decision.skill || decision.action, ...decision });
        this.log = this.log.slice(0, 50); }
      }
      const activeSkill = this.executor.current?.skill || 'Idle';
      const latestDecision = this.log[0];
      const matched = latestDecision?.skill === activeSkill;
      this.broadcast('state_update', { state: o, decision: { intent: activeSkill,
        reason: this.blockedAction?.reason || this.manager.current()?.description || '自主探索',
        source: matched ? latestDecision.source : 'runtime',
        latency: latestDecision?.latency ?? null,
        latencyScope: matched ? 'current' : 'latest' },
        log: this.log.slice(0, 10), ai_paused: this.paused,
        experiment: { mode: this.config.mode, agentEnabled: this.config.agent,
          plan: this.plan, goalManager: this.manager.snapshot(),
          agentError: this.agentError || null, nextAgentAt: this.nextAgent,
          blockedAction: this.blockedAction || null, actionFailures: this.actionGuard.context(),
          goal: this.manager.current(), metrics: this.run.metrics(), evidence, saveError: this.saveError } });
      if (Date.now() - this.lastSave >= this.config.saveMs) this.save('periodic');
    } catch (error) { if (!this.controller.signal.aborted) this.saveSystem.log('runtime_error', { error: error.message }); }
  }
}
module.exports = { Runtime };
