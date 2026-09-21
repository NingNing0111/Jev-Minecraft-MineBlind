// One pending record per event type. Revisions prevent an async consumer from
// acknowledging newer occurrences that arrived while it was awaiting a model.
class EventQueue {
  constructor(limit = 32) { this.limit = limit; this.items = new Map(); this.sequence = 0; }
  push(type, { priority = 3, source = 'runtime' } = {}) {
    const previous = this.items.get(type);
    const event = Object.freeze({ type, source, priority, timestamp: Date.now(),
      id: ++this.sequence, count: (previous?.count || 0) + 1 });
    if (!previous && this.items.size >= this.limit) {
      const worst = [...this.items.values()].sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
      if (worst.priority < priority) return null;
      this.items.delete(worst.type);
    }
    this.items.set(type, event);
    return event;
  }
  has(type) { return this.items.has(type); }
  peek() { return [...this.items.values()].sort((a, b) => a.priority - b.priority || a.id - b.id)[0]; }
  acknowledge(event) { if (this.items.get(event.type)?.id === event.id) this.items.delete(event.type); }
  clear() { this.items.clear(); }
}
module.exports = { EventQueue };
