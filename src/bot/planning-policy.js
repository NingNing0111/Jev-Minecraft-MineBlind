// Stable planning evidence: omit clocks, action logs, cooldowns and sub-block jitter.
function planningKey(observation, goal) {
  const o = observation, p = o.player?.position || {};
  const sorted = entries => entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const objective = goal ? [goal.objective, goal.target, goal.amount, goal.constraints || []] : null;
  return JSON.stringify([o.dimension, objective, sorted(Object.entries(o.inventory || {})),
    [Math.floor((p.x || 0) / 8), Math.floor((p.y || 0) / 4), Math.floor((p.z || 0) / 8)],
    Math.floor((o.player?.hp || 0) / 4), Math.floor((o.player?.hunger || 0) / 4),
    sorted((o.environment?.nearby_resources || []).map(r => [r.type, r.position, r.can_harvest])),
    sorted(o.structures || []), !!o.dragonDefeated]);
}
const LOCAL_FAILURES = new Set(['STUCK', 'NO_PATH', 'PATH_BUDGET', 'UNREACHABLE_TARGET', 'TARGET_GONE', 'PICKUP_UNCONFIRMED']);
function failureClass(code) { return LOCAL_FAILURES.has(code) ? 'local_execution' : 'strategic_prerequisite'; }
module.exports = { planningKey, failureClass };
