// Shared survival policy: starvation cannot be fixed by waiting or mining ores.
const foods = require('minecraft-data')('1.20.1').foodsByName;
const UNSAFE = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken']);
function safeFood(name) { return Boolean(foods[name]) && !UNSAFE.has(name); }
function needsFood(o) { return o.player?.hunger < 14 || (o.player?.hp < 8 && o.player?.hunger < 18); }
function survivalGoal(o) {
  if (!needsFood(o)) return null;
  const base = { survival: true, target: 'food', amount: 1,
    constraints: ['avoid_hostile_mobs', 'prevent_fall_damage', 'avoid_water_and_lava'] };
  const threat = (o.threat_scan || []).find(t => t.distance < 10);
  if (threat) return { ...base, skill: 'FLEE', position: threat.position };
  const food = Object.keys(o.inventory || {}).find(name => o.inventory[name] > 0 && safeFood(name));
  if (food) return { ...base, skill: 'EAT', target: food };
  const craft = (o.equipment?.immediately_craftable || []).find(c => safeFood(c.name));
  if (craft) return { ...base, skill: 'CRAFT_ITEM', target: craft.name };
  // Only direct edible drops. Sugar cane, wheat, seeds and pumpkins are not meals.
  const crop = (o.environment?.nearby_crops || []).find(c => c.can_harvest && safeFood(c.drop_item));
  if (crop) return { ...base, skill: 'MINE_RESOURCE', target: crop.type, position: crop.position };
  // Only containers known to contain safe food; never infer food from mere proximity.
  const container = (o.environment?.known_containers || []).find(c =>
    c.position && (c.contents || []).some(i => safeFood(i.name) && i.count > 0));
  if (container) return { ...base, skill: 'LOOT_CONTAINER', position: container.position,
    target: container.contents.find(i => safeFood(i.name) && i.count > 0).name };
  return { ...base, skill: 'EXPLORE_AREA' };
}
module.exports = { safeFood, needsFood, survivalGoal };
