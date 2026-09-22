const { Vec3 } = require('vec3');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const ROCK = new Set(['stone','andesite','diorite','granite','deepslate','tuff','cobblestone','dirt']);
const HAZARD = new Set(['water','lava','gravel','sand','red_sand','fire','magma_block','cactus','powder_snow']);
// Only a one-block horizontal passage: never dig the floor, ceiling or valuables.
function recoveryCandidates(bot) {
  const origin = bot.entity.position.floored();
  const candidates = [];
  for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const feet = origin.offset(x,0,z), floor = bot.blockAt(feet.offset(0,-1,0));
    if (!floor || floor.boundingBox !== 'block' || HAZARD.has(floor.name)) continue;
    const cells = [feet.offset(0,1,0), feet]; // Head first, then feet.
    const blocks = cells.map(p => bot.blockAt(p));
    if (blocks.some(b => !b || (!AIR.has(b.name) && !ROCK.has(b.name)))) continue;
    const dig = blocks.filter(b => !AIR.has(b.name));
    if (!dig.length || dig.some(b => !bot.canDigBlock(b))) continue;
    // Unknown, fluid, falling blocks or unsupported roof adjacent to excavation: reject.
    const safe = dig.every(b => [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].every(([dx,dy,dz]) => {
      const n = bot.blockAt(b.position.offset(dx,dy,dz));
      return n && !HAZARD.has(n.name);
    }));
    if (safe) candidates.push({ position: feet.offset(.5,0,.5), blocks: dig });
  }
  return candidates;
}
async function localRecovery(executor, task) {
  const bot = executor.bot;
  const candidate = recoveryCandidates(bot).find(c => c.blocks.every(b => !executor.guard || executor.guard.checkBlock(b)));
  if (!candidate) return null;
  for (const block of candidate.blocks) {
    executor.check(task);
    // Revalidate after each asynchronous dig; never trust the initial terrain snapshot.
    const current = recoveryCandidates(bot).find(c => c.position.equals(candidate.position));
    const live = current?.blocks.find(b => b.position.equals(block.position));
    if (!live) throw Object.assign(new Error('Recovery terrain changed'), { code: 'TARGET_GONE' });
    const tool = bot.pathfinder.bestHarvestTool(live);
    if (tool) await executor.step(task, () => bot.equip(tool, 'hand'));
    try { await executor.step(task, () => bot.dig(live)); }
    catch (error) { executor.guard?.failBlock(live, error); throw error; }
  }
  await executor.navigate(task, new Vec3(candidate.position.x, candidate.position.y, candidate.position.z), 0);
  return { recovered: true, position: candidate.position, cleared: candidate.blocks.length };
}
module.exports = { recoveryCandidates, localRecovery };
