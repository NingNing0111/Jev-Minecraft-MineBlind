function providerFailure(error) {
  const status = error.response?.status ?? error.status ?? error.statusCode;
  const category = [401, 402, 403].includes(status) ? 'provider_configuration'
    : status === 429 ? 'provider_rate_limit'
    : /timeout|timed out/i.test(error.message || '') || ['ECONNABORTED','ETIMEDOUT'].includes(error.code)
      ? 'provider_timeout' : 'provider_error';
  return { category, status };
}
class CircuitBreaker {
  constructor(now = Date.now) { this.now = now; this.failures = 0; this.retryAt = 0; }
  allowed() { return this.now() >= this.retryAt; }
  success() { this.failures = 0; this.retryAt = 0; this.category = null; }
  fail(error) {
    const info = providerFailure(error); this.failures++; this.category = info.category;
    // Authentication/billing failures require operator intervention, not automatic paid retries.
    this.retryAt = info.category === 'provider_configuration' ? Infinity
      : this.now() + Math.min(300000, 10000 * 2 ** Math.min(this.failures - 1, 5));
    return this.snapshot();
  }
  snapshot() { return { category: this.category || null, failures: this.failures,
    retryAt: Number.isFinite(this.retryAt) ? this.retryAt : null, open: !this.allowed(),
    requiresIntervention: this.retryAt === Infinity }; }
}
module.exports = { CircuitBreaker, providerFailure };
