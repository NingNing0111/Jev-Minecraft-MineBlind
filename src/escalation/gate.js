function evaluate(scores = {}) {
  const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
  const score = clamp(scores.stagnation) * .30 + clamp(scores.uncertainty) * .25
    + clamp(scores.invalid) * .25 + clamp(scores.value) * .20;
  return { score, verdict: score > .75 ? 'approve' : score < .5 ? 'reject' : 'defer' };
}
module.exports = { evaluate };
