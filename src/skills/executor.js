const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { SKILLS } = require('../jev/client');
const { collect } = require('./collect');
const { craft } = require('./crafting');
const { Exploration } = require('../exploration');
class SkillError extends Error {
  constructor(message, code = 'GOAL_UNACTIONABLE') { super(message); this.code = code; }
}
class SkillExecutor {
  constructor(bot, report = () => {}, exploration = new Exploration(), containerMemory = null) {
    this.bot = bot; this.report = report; this.current = null; this.sequence = 0;
    this.exploration = exploration; this.containerMemory = containerMemory;
  }
  get busy() { return this.current !== null; }
  cancel(reason = 'interrupted') {
    if (!this.current) return;
    this.current.cancelled = true; this.current.reason = reason;
    this.bot.pathfinder.setGoal(null);
    this.bot.stopDigging(); this.bot.clearControlStates(); this.bot.deactivateItem();
  }
  start(skill, params = {}) {
    if (this.busy) return false;
    if (this.guard && !['EAT','WATER','FLEE'].includes(skill)) {
      const verdict = this.guard.check(skill, params);
      if (!verdict.ok) {
        if (!verdict.cached) this.report({ type: 'skill_failed', skill, params, code: verdict.code, error: verdict.reason });
        return false;
      }
    }
    if (!SKILLS.includes(skill) && !['EAT','WATER'].includes(skill)) throw new SkillError(`Unknown skill ${skill}`);
    const task = { id: ++this.sequence, skill, params, cancelled: false, startedAt: Date.now() };
    this.current = task;
    const timeout = setTimeout(() => this.cancel('timeout'), 60000);
    task.promise = this.execute(task).then(result => {
      if (!task.cancelled) this.report({ type: 'skill_complete', skill, params, result });
    }).catch(error => {
      if (!task.cancelled) this.report({ type: 'skill_failed', skill, params, code: error.code || 'EXECUTION_FAILED', error: error.message });
    }).finally(() => {
      clearTimeout(timeout);
      this.bot.clearControlStates(); this.bot.deactivateItem();
      if (task.reason === 'timeout') this.report({ type: 'skill_failed', skill, params, error: 'Skill timeout', code: 'TIMEOUT' });
      if (this.current === task) this.current = null;
    });
    return true;
  }
  check(t) { if (t.cancelled) throw new SkillError('Interrupted', 'CANCELLED'); }
  async step(t, operation) { this.check(t); const result = await operation(); this.check(t); return result; }
  async navigate(t, position, radius = 2) {
    if (!position || !['x','y','z'].every(k => Number.isFinite(position[k]))) throw new SkillError('Missing navigation coordinates');
    return this.move(t, new goals.GoalNear(position.x, position.y, position.z, radius));
  }
  async move(t, goal) {
    this.check(t);
    const pf = this.bot.pathfinder;
    // A partial result means "continue this search", not "unreachable".
    // Bound both wall time and slices, yielding so physics/reflexes can still run.
    if (pf.getPathFromTo && pf.movements) {
      const budgetMs = 1000, maxSlices = 20;
      const deadline = performance.now() + budgetMs;
      const search = pf.getPathFromTo(pf.movements, this.bot.entity.position, goal,
        { timeout: budgetMs, tickTimeout: 50, searchRadius: 32 });
      let result;
      try {
        for (let slice = 0; slice < maxSlices && performance.now() < deadline; slice++) {
          this.check(t);
          const next = search.next();
          result = next.value?.result;
          this.check(t);
          if (next.done || result?.status !== 'partial') break;
          await new Promise(resolve => setImmediate(resolve));
        }
      } finally { search.return?.(); }
      this.check(t);
      if (result?.status !== 'success') throw new SkillError(
        result?.status === 'noPath' ? 'No path to target in local search area'
          : 'No proven path within local search budget',
        result?.status === 'noPath' ? 'NO_PATH' : 'PATH_BUDGET');
    }
    let last = this.bot.entity.position.clone();
    let timer, deadline;
    const bounded = new Promise((_, reject) => {
      deadline = setTimeout(() => {
        reject(new SkillError('Navigation exceeded 12 second budget', 'STUCK'));
        this.bot.pathfinder.setGoal(null);
      }, 12000);
    });
    const stalled = new Promise((_, reject) => {
      timer = setInterval(() => {
        const current = this.bot.entity.position;
        if (current.distanceTo(last) < 0.5) {
          reject(new SkillError('Navigation made no progress for 8 seconds', 'STUCK'));
          this.bot.pathfinder.setGoal(null);
        }
        last = current.clone();
      }, 8000);
    });
    try { return await this.step(t, () => Promise.race([this.bot.pathfinder.goto(goal), stalled, bounded])); }
    catch (error) {
      if (!error.code && /no path/i.test(error.message)) error.code = 'NO_PATH';
      throw error;
    }
    finally { clearInterval(timer); clearTimeout(deadline); }
  }
  async explore(t) {
    // Revalidate against live local observations, including resumed actions after a reflex.
    const info = this.exploration.observe(this.bot, t.params.target || '');
    const destination = info.destination;
    if (!destination) {
      if (t.params.localRecovery) {
        const result = await require('./local-recovery').localRecovery(this, t);
        if (result) return result;
      }
      throw new SkillError('No safe loaded frontier or conservative recovery passage', 'GOAL_UNACTIONABLE');
    }
    t.explorationPosition = destination.position;
    try {
      await this.navigate(t, destination.position, 3);
      this.exploration.finish(destination.position);
      return { explored: destination.position, purpose: info.purpose, reason: destination.reason };
    } catch (error) {
      this.exploration.finish(destination.position, !t.cancelled || t.reason === 'timeout');
      throw error;
    }
  }
  async execute(t) {
    const b = this.bot, p = t.params, pos = b.entity.position;
    const inventory = name => b.inventory.items().find(i => i.name === name);
    switch (t.skill) {
      case 'NAVIGATE_TO': return this.navigate(t, p.position);
      case 'EXPLORE_AREA': {
        return this.explore(t);
      }
      case 'SEARCH_STRUCTURE': {
        // Local block evidence only: no privileged /locate or hidden world data.
        const markers = { nether_fortress: 'nether_bricks', stronghold: 'end_portal_frame', village: 'bell' };
        const name = markers[p.target];
        if (!name) throw new SkillError(`No observation detector for structure ${p.target}`, 'KNOWLEDGE_GAP');
        const id = b.registry.blocksByName[name]?.id;
        const block = id === undefined ? null : b.findBlock({ matching: id, maxDistance: 64 });
        if (block) { await this.navigate(t, block.position); return { structure: p.target, position: block.position }; }
        await this.explore(t);
        return { searched: true }; // Never claim structure discovery from travel alone.
      }
      case 'MINE_RESOURCE': return collect(this, t);
      case 'CRAFT_ITEM': return craft(this, t);
      case 'FIGHT_MOB': {
        const target = Object.values(b.entities).filter(e => e !== b.entity && e.name === p.target)
          .sort((a,c) => pos.distanceTo(a.position)-pos.distanceTo(c.position))[0];
        if (!target) throw new SkillError(`No visible ${p.target}`);
        const weapon = b.inventory.items().find(i => i.name.endsWith('_sword'));
        if (weapon) await this.step(t, () => b.equip(weapon, 'hand'));
        for (let n = 0; n < 30 && b.entities[target.id]; n++) {
          await this.navigate(t, target.position, 2);
          await this.step(t, () => b.lookAt(target.position.offset(0, target.height / 2, 0)));
          this.check(t); b.attack(target);
          await this.step(t, () => new Promise(resolve => setTimeout(resolve, 650)));
        }
        return { attacked: target.id }; // Entity disappearance is not proof of a kill.
      }
      case 'FLEE': {
        const target = p.position ? new Vec3(p.position.x,p.position.y,p.position.z) : pos.offset(0,0,-1);
        const delta = pos.minus(target); if (delta.norm() < .1) delta.x = 1;
        const away = delta.normalize();
        return this.navigate(t, pos.offset(away.x*12,0,away.z*12), 2);
      }
      case 'LOOT_CONTAINER': {
        // 搜索所有容器类型：chest / trapped_chest / barrel
        const containerIds = ['chest', 'trapped_chest', 'barrel']
          .map(n => b.registry.blocksByName[n]?.id)
          .filter(id => id !== undefined);
        let chest = null;
        let closestDist = Infinity;
        for (const id of containerIds) {
          const found = b.findBlock({ matching: id, maxDistance: 24 });
          if (found) {
            const d = pos.distanceTo(found.position);
            if (d < closestDist) { closestDist = d; chest = found; }
          }
        }
        if (p.position) {
          const bound = b.blockAt(new Vec3(p.position.x, p.position.y, p.position.z));
          chest = bound && containerIds.includes(bound.type) ? bound : null;
        }
        if (!chest) throw new SkillError('No visible chest or barrel');
        await this.navigate(t, chest.position);
        this.check(t);
        const container = await b.openContainer(chest);
        let lootedItems = [];
        try {
          this.check(t);
          const items = container.containerItems();
          // 记录箱子内容快照（开箱前保存，内容不依赖取物成功与否）
          if (this.containerMemory) {
            this.containerMemory.record(chest.position, chest.name, items, String(b.game?.dimension || 'overworld'));
          }
          for (const item of items) {
            if (!p.target || item.name === p.target) {
              await this.step(t, () => container.withdraw(item.type, item.metadata, item.count));
              lootedItems.push({ name: item.name, count: item.count });
            }
          }
        } finally {
          try {
            if (this.containerMemory && !t.cancelled) this.containerMemory.record(chest.position, chest.name,
              container.containerItems(), String(b.game?.dimension || 'overworld'));
          } finally { container.close(); }
        }
        return { looted: true, items: lootedItems, container_pos: chest.position };
      }
      case 'BUILD_PORTAL': {
        if (!['nether', 'the_nether', 'minecraft:the_nether'].includes(p.target))
          throw new SkillError('Only Nether portal construction is supported', 'KNOWLEDGE_GAP');
        const existing = b.findBlock({ matching: b.registry.blocksByName.nether_portal.id, maxDistance: 48 });
        if (existing) return this.navigate(t, existing.position, 0);
        if (String(b.game.dimension).includes('nether')) return { inNether: true };
        if ((inventory('obsidian')?.count || 0) < 14 || !inventory('flint_and_steel'))
          throw new SkillError('Portal requires 14 obsidian and flint_and_steel');
        // Conservative flat-site builder: never excavate occupied cells or place over unsafe ground.
        const base = pos.floored().offset(3, 0, 0);
        const frame = [[0,0],[1,0],[2,0],[3,0],[0,1],[3,1],[0,2],[3,2],[0,3],[3,3],[0,4],[1,4],[2,4],[3,4]];
        for (let x = 0; x < 4; x++) {
          if (b.blockAt(base.offset(x,-1,0))?.boundingBox !== 'block') throw new SkillError('Portal needs a flat solid site');
          for (let y = 0; y < 5; y++) {
            const block = b.blockAt(base.offset(x,y,0));
            if (!block || !['air','cave_air'].includes(block.name)) throw new SkillError('Portal site is obstructed');
          }
        }
        for (const [x,y] of frame) {
          const cell = base.offset(x,y,0);
          const offsets = [new Vec3(0,-1,0),new Vec3(-1,0,0),new Vec3(1,0,0),new Vec3(0,1,0)];
          const support = offsets.map(d => ({ block: b.blockAt(cell.plus(d)), face: d.scaled(-1) }))
            .find(s => s.block?.boundingBox === 'block');
          if (!support) throw new SkillError('Portal placement has no support');
          await this.navigate(t, cell, 3);
          await this.step(t, () => b.equip(inventory('obsidian'), 'hand'));
          await this.step(t, () => b.placeBlock(support.block, support.face));
        }
        await this.step(t, () => b.equip(inventory('flint_and_steel'), 'hand'));
        await this.step(t, () => b.activateBlock(b.blockAt(base.offset(1,0,0)), new Vec3(0,1,0)));
        const portal = b.findBlock({ matching: b.registry.blocksByName.nether_portal.id, maxDistance: 16 });
        if (!portal) throw new SkillError('Portal activation not observed');
        return this.navigate(t, portal.position, 0);
      }
      case 'EAT': {
        const food = b.inventory.items().find(i => require('../survival').safeFood(i.name)
          && (!p.target || p.target === 'food' || i.name === p.target));
        if (!food) throw new SkillError('No edible food');
        await this.step(t, () => b.equip(food, 'hand'));
        return this.step(t, () => b.consume());
      }
      case 'WATER': {
        const bucket = inventory('water_bucket');
        if (!bucket || String(b.game.dimension).includes('nether')) throw new SkillError('Water unavailable in this state');
        await this.step(t, () => b.equip(bucket, 'hand'));
        await this.step(t, () => b.lookAt(pos.offset(0,-1,0)));
        this.check(t); b.activateItem(); return { attempted: true };
      }
    }
  }
}
module.exports = { SkillExecutor, SkillError };
