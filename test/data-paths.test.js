const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config } = require('../src/experiment/config');
const { SaveSystem } = require('../src/save/save_system');

test('default and relative configured storage paths resolve under project root', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(config({}).saveRoot, path.join(root, 'data/saves'));
  assert.equal(config({}).knowledgeRoot, path.join(root, 'data/knowledge'));
  assert.equal(config({ SAVE_DIR: 'data/custom' }).saveRoot, path.join(root, 'data/custom'));
  assert.equal(config({ SAVE_DIR: '/app/data/saves' }).saveRoot, '/app/data/saves');
});

test('latest snapshot survives moving the entire save directory; legacy absolute pointers still work', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineblind-relocate-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const before = path.join(temp, 'before'), after = path.join(temp, 'after');
  const identity = { world: 'test', mode: 'A' };
  const snapshot = { run_memory: { gameDay: 1 }, world_model: {}, goal_manager: {}, agent_plan: {} };
  const saves = new SaveSystem(before, identity);
  const dest = saves.save(snapshot, 'test');
  const pointer = JSON.parse(fs.readFileSync(path.join(before, 'latest.json')));
  assert.equal(path.isAbsolute(pointer.path), false);
  fs.renameSync(before, after);
  const moved = new SaveSystem(after, identity);
  assert.deepEqual(moved.restore('latest'), snapshot);
  fs.writeFileSync(path.join(after, 'latest.json'), JSON.stringify({ path: path.join(after, path.relative(before, dest)) }));
  assert.deepEqual(moved.restore('latest'), snapshot);
});
