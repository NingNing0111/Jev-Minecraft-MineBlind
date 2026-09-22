const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SQLiteMemory } = require('../src/memory/sqlite');
const { ContainerMemory } = require('../src/memory/container_memory');
const { WorldModel } = require('../src/memory/state');
const { SaveSystem } = require('../src/save/save_system');
const identity = { world: 'test', mode: 'E' };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineblind-sqlite-'));
  const stores = [];
  t.after(async () => { for (const db of stores) await db.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open(name, source, owner = identity) { const db = new SQLiteMemory(path.join(root,name), owner, source); stores.push(db); return db; } };
}
test('visited chunks persist, separate dimensions and avoid growing hot Set', async t => {
  const s = setup(t); const db = s.open('live.sqlite'); const w = new WorldModel();
  const o = { dimension:'overworld', player:{position:{x:-1,y:64,z:0}} };
  assert.equal((await w.updatePersistent(o,db)).fresh,true);
  assert.equal((await w.updatePersistent(o,db)).fresh,false);
  assert.equal((await w.updatePersistent({...o,dimension:'nether'},db)).new_chunks_visited,2);
  assert.equal(w.chunks.size,0); assert.equal(w.decisionContext().visited_chunk_count,2);
  await db.close(); const reopened = s.open('live.sqlite');
  assert.deepEqual(await reopened.request('visit',{dimension:'overworld',x:-1,z:0}),{fresh:false,count:2});
});
test('containers survive hot-cache eviction, isolate dimensions and respect height', async t => {
  const s = setup(t); const db = s.open('live.sqlite'); const memory = new ContainerMemory();
  await memory.refresh(db,{x:0,y:64,z:0},'overworld');
  for(let x=0;x<80;x++) memory.record({x,y:64,z:0},'chest',[{name:'iron_ingot',count:x+1}],'overworld');
  memory.record({x:0,y:64,z:0},'chest',[],'nether');
  await memory.refresh(db,{x:0,y:64,z:0},'overworld');
  const entries = memory.nearby({},48,'overworld');
  assert.equal(entries.length,8); assert.equal(entries[0].contents[0].count,1);
  assert.equal(entries[0].historical,true); assert.equal(memory.store.size,64);
  await memory.refresh(db,{x:0,y:64,z:0},'nether');
  assert.equal(memory.nearby({},48,'nether')[0].item_count,0);
  assert.deepEqual(await db.request('nearby',{dimension:'overworld',position:{x:0,y:200,z:0},radius:48}),[]);
});
test('checkpoint restore branches history and rejects different world', async t => {
  const s = setup(t); const db = s.open('live.sqlite');
  const saves = new SaveSystem(s.root,identity); saves.attachStorage(db);
  await db.request('visit',{dimension:'overworld',x:0,z:0});
  saves.log('test');
  const snapshot = { run_memory:{gameDay:1},world_model:{},goal_manager:{},agent_plan:null };
  await saves.savePersistent(snapshot,'test');
  assert.equal(saves.events.length,0);
  await db.request('visit',{dimension:'overworld',x:1,z:0});
  assert.deepEqual(saves.restore('latest'),snapshot);
  const branch = s.open('branch.sqlite',saves.restoredDatabase);
  assert.deepEqual(await branch.request('visit',{dimension:'overworld',x:0,z:0}),{fresh:false,count:1});
  const wrong = s.open('wrong.sqlite',saves.restoredDatabase,{world:'other',mode:'E'});
  await assert.rejects(wrong.ready,/mismatch/);
});
test('event retention and unknown requests report errors without killing worker', async t => {
  const s = setup(t); const db = s.open('live.sqlite');
  await db.request('events',Array.from({length:10010},(_,i)=>({timestamp:i,type:'test',i})));
  await assert.rejects(db.request('unknown'),/Unknown/);
  const file = path.join(s.root,'inspect.sqlite'); await db.request('checkpoint',{file});
  const { DatabaseSync } = require('node:sqlite'); const reader = new DatabaseSync(file);
  try { assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get().n,10000); }
  finally { reader.close(); }
});
test('container write failure is surfaced at refresh and checkpoint barriers', async () => {
  const memory = new ContainerMemory();
  memory.storage = { request: async () => { throw new Error('disk full'); } };
  memory.record({x:0,y:64,z:0},'chest',[]);
  await assert.rejects(memory.flush(), /disk full/);
  assert.equal(memory.pendingWrites.size,0);
  await assert.rejects(memory.flush(), /disk full/);
});
test('interval statistics retain exact mean with bounded samples and migrate old data', () => {
  const { RunMemory } = require('../src/memory/state');
  const run = new RunMemory({autonomousIntervals:[100,300],lastAgentAt:0});
  for (let i=1;i<=100;i++) run.agentCalled(i*200);
  assert.equal(run.data.autonomousIntervals.length,40);
  assert.equal(run.metrics().meanAutonomousHorizonMs,200);
  assert.equal(new RunMemory(run.data).metrics().meanAutonomousHorizonMs,200);
});
