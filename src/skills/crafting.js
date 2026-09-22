const { Vec3 } = require('vec3');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const UNSAFE = /lava|water|magma|campfire|cactus|fire|sand|gravel|anvil|concrete_powder/;

// Loaded, reachable cells only. Never replace the player's floor or containers.
function tableSites(bot) {
  const origin = bot.entity.position.floored();
  const sites = [];
  for (const y of [0, 1, -1]) for (const [x, z] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[-2,0],[0,2],[0,-2]]) {
    const at = origin.offset(x, y, z), block = bot.blockAt(at), floor = bot.blockAt(at.offset(0,-1,0));
    if (!block || floor?.boundingBox !== 'block' || UNSAFE.test(floor.name)) continue;
    if (AIR.has(block.name)) { sites.push({ at, floor, clear: false }); continue; }
    // Clearing one ordinary rock cell makes room even in a narrow tunnel. No ores,
    // gravity blocks, block entities, player supports, or fluid-adjacent excavation.
    if (y !== 0 || Math.abs(x) + Math.abs(z) !== 1 ||
        !['stone','andesite','diorite','granite','deepslate','cobblestone','dirt','netherrack'].includes(block.name) ||
        !bot.canDigBlock?.(block)) continue;
    const neighbors = [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]].map(d => bot.blockAt(at.offset(...d)));
    if (neighbors.some(b => !b || UNSAFE.test(b.name))) continue;
    sites.push({ at, floor, block, clear: true });
  }
  return sites.sort((a,b) => Number(a.clear) - Number(b.clear));
}
function craftProbe(bot, target) {
  const item = bot.registry.itemsByName[target];
  if (!item) return { ok: false, code: 'UNKNOWN_ITEM', reason: `Unknown item ${target}` };
  const direct = bot.recipesFor(item.id, null, 1, null)[0];
  if (direct) return { ok: true, recipe: direct, table: null };
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 16 });
  if (table) {
    const recipe = bot.recipesFor(item.id, null, 1, table)[0];
    return recipe ? { ok: true, recipe, table } : { ok: false, code: 'MISSING_INGREDIENTS', reason: `Missing ingredients for ${target}` };
  }
  if (!bot.inventory.items().some(i => i.name === 'crafting_table'))
    return { ok: false, code: 'MISSING_TABLE', reason: `Place or acquire a crafting_table for ${target}` };
  const counts = new Map();
  for (const i of bot.inventory.items()) counts.set(i.type, (counts.get(i.type) || 0) + i.count);
  if (bot.recipesAll && !bot.recipesAll(item.id, null, true).some(r => r.delta.filter(d => d.count < 0).every(d => (counts.get(d.id) || 0) >= -d.count)))
    return { ok: false, code: 'MISSING_INGREDIENTS', reason: `Missing ingredients for ${target}` };
  const site = tableSites(bot)[0];
  if (!site) return { ok: false, code: 'NO_TABLE_SITE', reason: 'No safe reachable crafting-table site; move to an open supported area' };
  return { ok: true, site };
}
async function craft(executor, task) {
  const b = executor.bot, target = task.params.target;
  const fail = (message, code) => { const e = new Error(message); e.code = code; throw e; };
  const probe = craftProbe(b, target);
  if (!probe.ok) fail(probe.reason, probe.code);
  let { table, recipe } = probe;
  if (probe.site) {
    const { at, floor, clear, block } = probe.site;
    if (clear) await executor.step(task, () => b.dig(block));
    if (!AIR.has(b.blockAt(at)?.name)) fail('Table cell is no longer empty', 'NO_TABLE_SITE');
    await executor.step(task, () => b.equip(b.inventory.items().find(i => i.name === 'crafting_table'), 'hand'));
    await executor.step(task, () => b.placeBlock(floor, new Vec3(0,1,0)));
    table = b.blockAt(at);
    if (table?.name !== 'crafting_table') fail('Table placement was not observed', 'TABLE_NOT_OBSERVED');
  }
  if (table) await executor.navigate(task, table.position);
  recipe = b.recipesFor(b.registry.itemsByName[target].id, null, 1, table || null)[0];
  if (!recipe) fail(`Recipe no longer available for ${target}`, 'MISSING_INGREDIENTS');
  await executor.step(task, () => b.craft(recipe, 1, table || null));
  return { crafted: target };
}
module.exports = { craftProbe, tableSites, craft };
