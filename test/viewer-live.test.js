const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { Vec3 } = require('vec3');
const { attachLivePosition, patchLivePosition } = require('../src/viewer-live');

function fixture() {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 };
  const socket = new EventEmitter();
  const packets = [];
  socket.on('position', packet => packets.push(packet));
  return { bot, socket, packets };
}

test('viewer publishes immediately and independently without movement or decision completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bot, socket, packets } = fixture();
  let release;
  const decision = new Promise(resolve => { release = resolve; });
  let finished = false;
  decision.then(() => { finished = true; });
  const detach = attachLivePosition(bot, socket, { updatePosition() {} }, true);
  t.after(() => { detach(); release(); });
  assert.equal(packets.length, 1);
  bot.entity.position.x = 12; bot.entity.yaw = 1; bot.entity.pitch = .5;
  t.mock.timers.tick(150);
  assert.equal(finished, false);
  assert.equal(packets.length, 4);
  assert.equal(packets[0].pos.x, 0);
  assert.equal(packets.at(-1).pos.x, 12);
  assert.equal(packets.at(-1).yaw, 1);
  assert.equal(packets.at(-1).pitch, .5);
  socket.emit('disconnect');
  t.mock.timers.tick(200);
  bot.emit('move');
  assert.equal(packets.length, 4);
  assert.equal(bot.listenerCount('move'), 0);
  assert.equal(bot.listenerCount('end'), 0);
});

test('slow chunk loading does not block camera updates or start overlapping loads', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { bot, socket, packets } = fixture();
  let release; let loads = 0;
  const detach = attachLivePosition(bot, socket, { updatePosition() {
    loads++;
    return new Promise(resolve => { release = resolve; });
  } }, false);
  t.after(() => { detach(); release?.(); });
  await Promise.resolve();
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(loads, 1);
  assert.equal(packets.length, 6);
  assert.equal('pitch' in packets[0], false);
  bot.emit('end');
  t.mock.timers.tick(200);
  assert.equal(packets.length, 6);
  assert.equal(socket.listenerCount('disconnect'), 0);
});

test('live adapter patch supports installed dependency, is idempotent and validates signatures', () => {
  const source = fs.readFileSync(require.resolve('prismarine-viewer/lib/mineflayer'), 'utf8');
  const patched = patchLivePosition(source);
  assert.ok(patched.includes('const detachPosition ='));
  assert.ok(patched.includes('      detachPosition()'));
  assert.ok(!patched.includes("bot.on('move', botPosition)"));
  assert.equal(patchLivePosition(patched), patched);
  assert.doesNotThrow(() => new Function(patched));
  assert.throws(() => patchLivePosition('unknown adapter'), /signature changed/);
});
