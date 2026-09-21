const fs = require('node:fs');
const path = require('node:path');

class WorkingMemory {
  constructor() { this.entries = []; }
  add(entry, now = Date.now()) {
    this.entries.push({ ...entry, timestamp: now });
    this.entries = this.entries.filter(e => now - e.timestamp < 30000).slice(-40);
  }
  snapshot() { return this.entries; }
}
class RunMemory {
  constructor(data = {}) {
    this.data = { startedAt: Date.now(), deaths: 0, agentCalls: 0, agentErrors: 0,
      keyDecisions: 0, agentResolved: 0, autonomousIntervals: [], lastAgentAt: null,
      completedGoals: [], tokens: 0, victory: false, ...data };
  }
  update(observation) {
    this.data.inventory = observation.inventory;
    this.data.player = observation.player;
    this.data.dimension = observation.dimension;
    this.data.gameDay = observation.gameDay;
  }
  agentCalled(now = Date.now()) {
    this.data.agentCalls++;
    if (this.data.lastAgentAt !== null) this.data.autonomousIntervals.push(now - this.data.lastAgentAt);
    this.data.lastAgentAt = now;
  }
  metrics(now = Date.now()) {
    const d = this.data, xs = d.autonomousIntervals;
    return { elapsedMs: now - d.startedAt, deaths: d.deaths, agentCalls: d.agentCalls,
      agentErrors: d.agentErrors, tokens: d.tokens, completed: d.victory,
      agentDependencyRatio: d.keyDecisions ? d.agentResolved / d.keyDecisions : null,
      meanAutonomousHorizonMs: xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null };
  }
}
class WorldModel {
  constructor(data = {}) {
    this.data = { locations: {}, structures: [], danger_zones: [], resource_zones: [], chunks: [], ...data };
    this.chunks = new Set(this.data.chunks);
    this.previous = null;
    this.distance = 0;
  }
  update(o) {
    const p = o.player.position;
    const key = `${o.dimension}:${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
    const fresh = !this.chunks.has(key);
    this.chunks.add(key);
    if (this.previous?.dimension === o.dimension) {
      const q = this.previous.position;
      this.distance += Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z);
    }
    this.previous = { dimension: o.dimension, position: p };
    return { new_chunks_visited: this.chunks.size, distance_travelled: this.distance, fresh };
  }
  snapshot() { return { ...this.data, chunks: [...this.chunks] }; }
}
class KnowledgeMemory {
  constructor(root, enabled = true) { this.root = root; this.enabled = enabled; }
  file(topic) {
    if (!/^[a-z0-9_-]{1,80}$/.test(topic)) throw new Error('Invalid knowledge topic');
    return path.join(this.root, 'minecraft_mechanics', `${topic}.json`);
  }
  get(topic) {
    if (!this.enabled) return null;
    const file = this.file(topic);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`Invalid knowledge file ${file}: ${error.message}`); }
  }
  put(topic, data) {
    if (!this.enabled) return;
    const file = this.file(topic);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ savedAt: Date.now(), ...data }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
}
module.exports = { WorkingMemory, RunMemory, WorldModel, KnowledgeMemory };
