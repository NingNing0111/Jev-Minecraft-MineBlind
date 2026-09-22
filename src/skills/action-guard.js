const { craftProbe } = require('./crafting');
function actionKey(skill, params = {}) {
  const p = params.position;
  // Requested quantity does not change reachability or missing prerequisites.
  return JSON.stringify([skill, params.target || '', p ? [p.x,p.y,p.z] : null]);
}
function fingerprint(bot) {
  const p = bot.entity?.position?.floored();
  if (!p) return 'unspawned';
  const blocks = [];
  for (let x = -2; x <= 2; x++) for (let y = -1; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const b = bot.blockAt?.(p.offset(x,y,z)); blocks.push(b?.stateId ?? b?.name ?? null);
  }
  return JSON.stringify([bot.game?.dimension, [p.x,p.y,p.z],
    bot.inventory.items().map(i => [i.name,i.count,i.metadata]).sort(), blocks]);
}
class ActionGuard {
  constructor(bot, now = Date.now) { this.bot = bot; this.now = now; this.failures = new Map(); }
  check(skill, params = {}) {
    const key = actionKey(skill, params), state = fingerprint(this.bot), previous = this.failures.get(key);
    if (previous && previous.state === state && previous.retryAt > this.now())
      return { ok: false, ...previous, cached: true };
    if (skill === 'CRAFT_ITEM') {
      const probe = craftProbe(this.bot, params.target);
      if (!probe.ok) return { ...probe, cached: false };
    }
    return { ok: true };
  }
  fail(skill, params, error) {
    const key = actionKey(skill, params), state = fingerprint(this.bot), previous = this.failures.get(key);
    const attempts = previous?.state === state ? previous.attempts + 1 : 1;
    const entry = { state, attempts, code: error.code, reason: error.reason || error.message || error.error,
      retryAt: this.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5)) };
    this.failures.delete(key); this.failures.set(key, entry);
    if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value);
    return entry;
  }
  success(skill, params) { this.failures.delete(actionKey(skill, params)); }
  context() { return [...this.failures].map(([action, { state: _state, ...failure }]) => ({ action, ...failure })); }
}
module.exports = { ActionGuard, actionKey, fingerprint };
