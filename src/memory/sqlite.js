const { Worker } = require('node:worker_threads');
const path = require('node:path');
class SQLiteMemory {
  constructor(file, identity, source = null) {
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.worker = new Worker(path.join(__dirname, 'sqlite-worker.js'), { workerData: { file, identity, source } });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker.on('message', message => {
      if (message.ready) return this.resolveReady();
      if (message.fatal) return this.fail(new Error(message.fatal));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => { if (!this.closed) this.fail(new Error(`SQLite worker exited (${code})`)); });
  }
  fail(error) {
    this.error = error; this.rejectReady(error);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  async request(operation, args = {}) {
    await this.ready;
    if (this.error) throw this.error;
    if (this.closed) throw new Error('SQLite memory is closed');
    if (this.pending.size >= 128) throw new Error('SQLite queue capacity exceeded');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, operation, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    if (this.closed) return;
    try { await this.request('close'); }
    finally { this.closed = true; await this.worker.terminate(); }
  }
}
module.exports = { SQLiteMemory };
