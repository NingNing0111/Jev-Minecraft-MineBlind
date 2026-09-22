// All synchronous SQLite and checkpoint I/O runs off the game thread.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
let db;
try {
  fs.mkdirSync(path.dirname(workerData.file), { recursive: true });
  if (workerData.source) fs.copyFileSync(workerData.source, workerData.file);
  db = new DatabaseSync(workerData.file);
  if (db.prepare('PRAGMA user_version').get().user_version > 1) throw new Error('Unsupported SQLite schema version');
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks (dimension TEXT NOT NULL, x INTEGER NOT NULL, z INTEGER NOT NULL,
      visited_at INTEGER NOT NULL, PRIMARY KEY(dimension,x,z));
    CREATE TABLE IF NOT EXISTS containers (dimension TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
      z INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(dimension,x,y,z));
    CREATE INDEX IF NOT EXISTS containers_nearby ON containers(dimension,x,z);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const identity = JSON.stringify(workerData.identity);
  const existing = db.prepare("SELECT value FROM metadata WHERE key='identity'").get();
  if (existing && existing.value !== identity) throw new Error('SQLite world/mode mismatch');
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('identity',?)").run(identity);
  parentPort.postMessage({ ready: true });
} catch (error) {
  db?.close(); db = null; parentPort.postMessage({ fatal: error.message }); parentPort.close();
}
if (db && parentPort) parentPort.on('message', ({ id, operation, args }) => {
  try {
    let result;
    switch (operation) {
      case 'visit': {
        const inserted = db.prepare('INSERT OR IGNORE INTO chunks VALUES (?,?,?,?)').run(args.dimension,args.x,args.z,Date.now());
        result = { fresh: inserted.changes > 0, count: db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n };
        break;
      }
      case 'record': {
        const { position: p, dimension } = args;
        db.prepare('INSERT OR REPLACE INTO containers VALUES (?,?,?,?,?)').run(dimension,p.x,p.y,p.z,JSON.stringify(args));
        break;
      }
      case 'nearby': {
        const { dimension, position: p, radius } = args;
        // Indexed bounding box, exact 3D radius and bounded results in SQL.
        result = db.prepare(`SELECT data, ((x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?)) AS d2
          FROM containers WHERE dimension=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?
          AND ((x-?)*(x-?)+(y-?)*(y-?)+(z-?)*(z-?)) <= ? ORDER BY d2 LIMIT 8`)
          .all(p.x,p.x,p.y,p.y,p.z,p.z,dimension,p.x-radius,p.x+radius,p.z-radius,p.z+radius,
            p.x,p.x,p.y,p.y,p.z,p.z,radius*radius)
          .map(row => ({ ...JSON.parse(row.data), distance: Math.round(Math.sqrt(row.d2)*10)/10, historical: true }));
        break;
      }
      case 'events': {
        db.exec('BEGIN');
        try {
          const insert = db.prepare('INSERT INTO events(timestamp,type,data) VALUES (?,?,?)');
          for (const event of args) insert.run(event.timestamp,event.type,JSON.stringify(event));
          // Keep the latest 10,000 detailed events; checkpoints preserve older history.
          db.exec('DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM events); COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        break;
      }
      case 'checkpoint':
        fs.mkdirSync(path.dirname(args.file), { recursive: true });
        db.prepare('VACUUM INTO ?').run(args.file);
        result = args.file; break;
      case 'close': db.close(); break;
      default: throw new Error(`Unknown SQLite operation: ${operation}`);
    }
    parentPort.postMessage({ id, result });
    if (operation === 'close') parentPort.close();
  } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
