class ActionArbiter {
  constructor(executor) { this.executor = executor; this.priority = 4; this.paused = false; this.suspended = null; }
  submit(skill, params, priority = 3) {
    if (this.paused) return false;
    if (this.executor.busy) {
      if (priority >= (this.pending?.priority ?? this.priority)) return false;
      if (this.priority >= 2) this.suspended = { skill: this.executor.current.skill, params: this.executor.current.params, priority: this.priority };
      this.executor.cancel('reflex');
      // Wait for the previous asynchronous operation to settle before starting another writer.
      this.pending = { skill, params, priority };
      return true;
    }
    if (this.pending) {
      if (priority >= this.pending.priority) { this.tick(); return false; }
      this.pending = null;
    }
    this.priority = priority;
    return this.executor.start(skill, params);
  }
  tick() {
    if (this.paused || this.executor.busy) return;
    const next = this.pending || this.suspended;
    if (this.pending) this.pending = null; else this.suspended = null;
    if (next) this.submit(next.skill, next.params, next.priority);
    else this.priority = 4;
  }
  pause() { this.paused = true; this.pending = null; this.suspended = null; this.executor.cancel('paused'); }
  resume() { this.paused = false; }
}
function reflex(bot, observation) {
  const threat = observation.threat_scan.find(t => (t.type === 'creeper' && t.is_ignited && t.distance < 7) || (observation.player.hp < 6 && t.distance < 10));
  if (threat) return { skill: 'FLEE', params: { position: threat.position }, priority: 0 };
  if ((observation.player.is_on_fire || (observation.player.velocity.y < -0.8 && observation.environment.depth_below <= 4)) && observation.inventory.water_bucket && !observation.dimension.includes('nether')) return { skill: 'WATER', params: {}, priority: 1 };
  if ((observation.player.hunger < 14 || observation.player.hp < 8) && !observation.threat_scan.some(t => t.distance < 6)
      && observation.player.hunger < 20
      && bot.inventory.items().some(i => require('../survival').safeFood(i.name))) return { skill: 'EAT', params: {}, priority: 1 };
  return null;
}
module.exports = { ActionArbiter, reflex };
