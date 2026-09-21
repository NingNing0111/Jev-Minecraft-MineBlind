const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
class SaveSystem {
  constructor(root, identity) { this.root = root; this.identity = identity; this.events = []; }
  log(type, data = {}) {
    // Snapshot mutable runtime objects at event time, not at the next save.
    try { this.events.push(JSON.parse(JSON.stringify({ timestamp: Date.now(), ...data, type }))); }
    catch (error) { this.events.push({ timestamp: Date.now(), type: 'log_error', error: error.message }); }
  }
  save(snapshot, reason) {
    const date = new Date();
    const day = String(snapshot.run_memory.gameDay || 0).padStart(3, '0');
    const dir = path.join(this.root, date.toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const name = `day${day}_t${date.toISOString().slice(11, 19).replaceAll(':', '')}_${randomUUID().slice(0, 8)}`;
    const temp = path.join(dir, `.${name}.tmp`), dest = path.join(dir, name);
    fs.mkdirSync(temp);
    const files = { ...snapshot, meta: { version: 1, identity: this.identity, reason, savedAt: date.toISOString() } };
    for (const [key, value] of Object.entries(files)) fs.writeFileSync(path.join(temp, `${key}.json`), JSON.stringify(value, null, 2));
    fs.writeFileSync(path.join(temp, 'experiment_log.jsonl'), this.events.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(temp, dest);
    // A portable atomic pointer avoids symlink permission differences on Windows.
    for (const pointer of [path.join(dir, 'latest.json'), path.join(this.root, 'latest.json')]) {
      fs.writeFileSync(`${pointer}.tmp`, JSON.stringify({ path: path.resolve(dest) }));
      fs.renameSync(`${pointer}.tmp`, pointer);
    }
    return dest;
  }
  restore(selection) {
    const read = file => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { throw new Error(`Cannot restore ${file}: ${error.message}`); }
    };
    const dir = selection === 'latest' ? read(path.join(this.root, 'latest.json')).path : selection;
    const meta = read(path.join(dir, 'meta.json'));
    if (meta.version !== 1 || JSON.stringify(meta.identity) !== JSON.stringify(this.identity)) throw new Error('Save version/world/mode mismatch');
    const result = {};
    for (const key of ['run_memory', 'world_model', 'goal_manager', 'agent_plan']) result[key] = read(path.join(dir, `${key}.json`));
    const logfile = path.join(dir, 'experiment_log.jsonl');
    try {
      if (fs.existsSync(logfile)) this.events = fs.readFileSync(logfile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) { throw new Error(`Cannot restore log ${logfile}: ${error.message}`); }
    return result;
  }
}
module.exports = { SaveSystem };
