const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { SKILLS } = require('../jev/client');
class SkillError extends Error {
  constructor(message, code = 'GOAL_UNACTIONABLE') { super(message); this.code = code; }
}
class SkillExecutor {
  constructor(bot, report = () => {}) {
    this.bot = bot; this.report = report; this.current = null; this.sequence = 0;
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
    return this.step(t, () => this.bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, radius)));
  }
  async execute(t) {
    const b = this.bot, p = t.params, pos = b.entity.position;
    const inventory = name => b.inventory.items().find(i => i.name === name);
    switch (t.skill) {
      case 'NAVIGATE_TO': return this.navigate(t, p.position);
      case 'EXPLORE_AREA': {
        const angle = (this.sequence * 2.399963229728653);
        return this.navigate(t, { x: pos.x + Math.cos(angle)*24, y: pos.y, z: pos.z + Math.sin(angle)*24 }, 3);
      }
      case 'SEARCH_STRUCTURE': {
        // Local block evidence only: no privileged /locate or hidden world data.
        const markers = { nether_fortress: 'nether_bricks', stronghold: 'end_portal_frame', village: 'bell' };
        const name = markers[p.target];
        if (!name) throw new SkillError(`No observation detector for structure ${p.target}`, 'KNOWLEDGE_GAP');
        const id = b.registry.blocksByName[name]?.id;
        const block = id === undefined ? null : b.findBlock({ matching: id, maxDistance: 64 });
        if (block) { await this.navigate(t, block.position); return { structure: p.target, position: block.position }; }
        const angle = this.sequence * 2.399963229728653;
        await this.navigate(t, { x: pos.x+Math.cos(angle)*32, y: pos.y, z: pos.z+Math.sin(angle)*32 }, 3);
        return { searched: true }; // Never claim structure discovery from travel alone.
      }
      case 'MINE_RESOURCE': {
        const blockId = b.registry.blocksByName[p.target]?.id;
        if (blockId === undefined) throw new SkillError(`${p.target} is not a mineable block; crafting/smelting/loot may be required`, 'KNOWLEDGE_GAP');
        const block = b.findBlock({ matching: blockId, maxDistance: 48 });
        if (!block) throw new SkillError(`No visible ${p.target}; explore first`);
        await this.navigate(t, block.position, 2);
        const tool = b.pathfinder.bestHarvestTool(block);
        if (tool) await this.step(t, () => b.equip(tool, 'hand'));
        if (!block.canHarvest(b.heldItem?.type ?? null)) throw new SkillError('Required harvest tool missing');
        await this.step(t, () => b.dig(block));
        await this.navigate(t, block.position, 1);
        return { mined: block.name }; // Inventory observation, not this return, completes the goal.
      }
      case 'CRAFT_ITEM': {
        const item = b.registry.itemsByName[p.target];
        if (!item) throw new SkillError(`Unknown item ${p.target}`);
        const tableId = b.registry.blocksByName.crafting_table.id;
        const table = b.findBlock({ matching: tableId, maxDistance: 16 });
        if (table) await this.navigate(t, table.position);
        const recipe = b.recipesFor(item.id, null, 1, table)[0];
        if (!recipe) throw new SkillError(`Missing recipe ingredients or crafting table for ${p.target}`);
        await this.step(t, () => b.craft(recipe, 1, table));
        return { crafted: p.target };
      }
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
        const chestId = b.registry.blocksByName.chest.id;
        const chest = b.findBlock({ matching: chestId, maxDistance: 24 });
        if (!chest) throw new SkillError('No visible chest');
        await this.navigate(t, chest.position);
        this.check(t);
        const container = await b.openContainer(chest);
        try {
          this.check(t);
          for (const item of container.containerItems()) {
            if (!p.target || item.name === p.target) await this.step(t, () => container.withdraw(item.type, item.metadata, item.count));
          }
        } finally { container.close(); }
        return { looted: true };
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
        const food = b.inventory.items().find(i => b.registry.foodsByName?.[i.name]);
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
