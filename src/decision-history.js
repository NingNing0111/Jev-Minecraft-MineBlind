const { randomUUID } = require('node:crypto');
// In-memory, session-scoped debug history. Never retain transport headers/config.
function snapshot(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null, (key, item) =>
      /^(authorization|api[_-]?key|token|access_token|password|secret)$/i.test(key) ? '[REDACTED]' : item));
  } catch { return { unavailable: '无法序列化此记录' }; }
}
class DecisionHistory {
  constructor(limit = 50) { this.limit = limit; this.records = new Map(); }
  add(record) {
    const copy = snapshot(record);
    const id = randomUUID();
    this.records.set(id, { ...copy, id });
    while (this.records.size > this.limit) this.records.delete(this.records.keys().next().value);
    return id;
  }
  get(id) { return this.records.get(id); }
}
module.exports = { DecisionHistory, snapshot };
