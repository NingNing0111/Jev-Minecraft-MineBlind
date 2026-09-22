const { z } = require('zod');
const goalSchema = z.object({
  id: z.string().min(1).max(80), description: z.string().min(1),
  objective: z.enum(['SURVIVE', 'ACQUIRE', 'ENTER_DIMENSION', 'FIND_STRUCTURE', 'DEFEAT_DRAGON']),
  target: z.string(), amount: z.number().int().positive(), constraints: z.array(z.string()),
});
const planSchema = z.object({ rationale: z.string(), goals: z.array(goalSchema).min(1).max(8) });
class GoalManager {
  constructor(stagnationMs = 120000, saved = {}) {
    this.stagnationMs = stagnationMs;
    this.goals = saved.goals || [];
    this.index = saved.index || 0;
    this.lastProgress = Date.now(); this.best = 0; this.chunks = 0;
    this.pending = 'startup';
  }
  setPlan(plan) {
    planSchema.parse(plan);
    this.goals = plan.goals; this.index = 0; this.reset(); this.pending = null;
  }
  reset() { this.lastProgress = Date.now(); this.best = 0; this.chunks = null; }
  current() { return this.goals[this.index] || null; }
  tactical(o, bot) {
    const g = this.current();
    const survival = require('../survival').survivalGoal(o);
    if (survival) return { goalId: g?.id, ...survival };
    if (!g) return { skill: 'EXPLORE_AREA', target: '', amount: 1 };
    const skills = { SURVIVE: 'EXPLORE_AREA', ACQUIRE: 'MINE_RESOURCE', ENTER_DIMENSION: 'BUILD_PORTAL',
      FIND_STRUCTURE: 'SEARCH_STRUCTURE', DEFEAT_DRAGON: 'FIGHT_MOB' };
    let action = { skill: skills[g.objective], target: g.target, amount: g.amount };
    if (g.objective === 'ACQUIRE' && bot) action = this.acquire(g.target, g.amount, o.inventory, bot);
    return { goalId: g.id, ...action, constraints: g.constraints, inventory: o.inventory };
  }
  acquire(target, amount, inventory, bot, seen = new Set()) {
    const explore = { skill: 'EXPLORE_AREA', target, amount };
    if (seen.has(target) || seen.size > 8) return explore;
    seen = new Set([...seen, target]);
    const item = bot.registry.itemsByName[target];
    if (!item) return explore;
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table?.id, maxDistance: 16 });
    if (bot.recipesFor(item.id, null, 1, table).length) return { skill: 'CRAFT_ITEM', target, amount };
    // Prefer observable acquisition over reversible packing/unpacking recipes.
    // Otherwise raw_iron -> raw_iron_block -> raw_iron becomes a dead-end.
    const drops = { cobblestone: 'stone', raw_iron: 'iron_ore', raw_gold: 'gold_ore', raw_copper: 'copper_ore', diamond: 'diamond_ore', coal: 'coal_ore' };
    const block = drops[target] || target;
    const candidates = drops[target] ? [block, `deepslate_${block}`] : [block];
    for (const name of candidates) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id !== undefined && bot.findBlock({ matching: id, maxDistance: 48 }))
        return { skill: 'MINE_RESOURCE', target: name, amount };
    }
    // Raw drops should be searched for, not manufactured from their storage block.
    if (drops[target]) return explore;
    // Recipe deltas supply local prerequisites; the strategic agent never emits these steps.
    const recipes = bot.recipesAll(item.id, null, true);
    const hasIngredients = recipe => recipe.delta.filter(d => d.count < 0).every(d =>
      (inventory[bot.registry.items[d.id]?.name] || 0) >= -d.count);
    // Prefer an already supplied recipe over another wood variant's missing ingredients.
    if (!table && recipes.some(recipe => recipe.requiresTable && hasIngredients(recipe))) {
      if (inventory.crafting_table > 0) return { skill: 'CRAFT_ITEM', target, amount };
      return this.acquire('crafting_table', 1, inventory, bot, seen);
    }
    for (const recipe of recipes) {
      const missing = recipe.delta.filter(d => d.count < 0 && (inventory[bot.registry.items[d.id]?.name] || 0) < -d.count);
      if (missing.length) {
        const ingredient = missing[0];
        const name = bot.registry.items[ingredient.id]?.name;
        if (name && !seen.has(name)) return this.acquire(name, -ingredient.count, inventory, bot, seen);
      }
    }
    const mobs = { blaze_rod: 'blaze', ender_pearl: 'enderman' };
    if (mobs[target]) return { skill: 'FIGHT_MOB', target: mobs[target], amount };
    return explore;
  }
  evaluate(o, evidence, now = Date.now()) {
    const g = this.current();
    if (!g) return this.pending;
    const count = o.inventory[g.target] || 0;
    let complete = false, progress = 0;
    if (g.objective === 'ACQUIRE') { progress = count; complete = count >= g.amount; }
    if (g.objective === 'ENTER_DIMENSION') complete = o.dimension === g.target;
    if (g.objective === 'SURVIVE') { progress = o.player.hp; complete = o.player.hp >= g.amount; }
    if (g.objective === 'FIND_STRUCTURE') complete = (o.structures || []).includes(g.target);
    if (g.objective === 'DEFEAT_DRAGON') complete = o.dragonDefeated === true;
    const exploring = ['FIND_STRUCTURE','ENTER_DIMENSION','ACQUIRE'].includes(g.objective);
    if (progress > this.best || (exploring && this.chunks !== null && evidence.new_chunks_visited > this.chunks)) this.lastProgress = now;
    this.best = Math.max(this.best, progress); this.chunks = evidence.new_chunks_visited;
    if (complete) { this.index++; this.reset(); return { type: 'goal_complete', goal: g.id }; }
    if (now - this.lastProgress >= this.stagnationMs) return { type: 'stagnation', goal: g.id };
    return null;
  }
  snapshot() { return { goals: this.goals, index: this.index }; }
}
module.exports = { GoalManager, goalSchema, planSchema };
