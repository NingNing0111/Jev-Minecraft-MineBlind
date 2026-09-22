const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { viewerPixelRatio, smoothCameraPosition, patchPerformanceBundle } = require('../src/viewer-performance');
const { patchBundle } = require('../src/viewer-smoothing');
const { patchHandBundle } = require('../src/viewer-hand');
const { patchEntityBundle } = require('../src/viewer-entities');

class Tween {
  constructor(state) { this.state = state; }
  to(target, duration) { this.target = target; this.duration = duration; return this; }
  start() { return this; }
  stop() { this.stopped = true; }
}
const makeViewer = () => ({ camera: { position: { x: 0, y: 0, z: 0,
  set(x, y, z) { Object.assign(this, { x, y, z }); } } } });

test('framebuffer budget caps Retina and large windows without supersampling low-DPI screens', () => {
  assert.equal(viewerPixelRatio(800, 600, 1), 1);
  assert.equal(viewerPixelRatio(800, 600, 3), 1.5);
  for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
    const ratio = viewerPixelRatio(w, h, 3);
    assert.ok(w * h * ratio * ratio <= 2073601);
  }
  assert.equal(viewerPixelRatio(0, 0, undefined), 1);
});

test('position tween is bounded, ignores identical targets and snaps teleports', () => {
  const v = makeViewer();
  smoothCameraPosition(v, Tween, { x: 100, y: 70, z: 100 });
  assert.equal(v.camera.position.x, 100);
  assert.equal(v._mineblindPositionTween, undefined);
  smoothCameraPosition(v, Tween, { x: 101, y: 70, z: 100 });
  const first = v._mineblindPositionTween;
  assert.equal(first.duration, 80);
  smoothCameraPosition(v, Tween, { x: 101, y: 70, z: 100 });
  assert.equal(v._mineblindPositionTween, first);
  assert.equal(first.stopped, undefined);
  smoothCameraPosition(v, Tween, { x: 102, y: 70, z: 100 });
  assert.equal(first.stopped, true);
  const second = v._mineblindPositionTween;
  smoothCameraPosition(v, Tween, { x: NaN, y: 70, z: 100 });
  assert.equal(v._mineblindPositionTween, second);
  smoothCameraPosition(v, Tween, { x: 500, y: 70, z: 100 });
  assert.equal(second.stopped, true);
  assert.equal(v.camera.position.x, 500);
});

test('actual installed bundle supports all patches together, is valid JS and idempotent', () => {
  const source = fs.readFileSync(require.resolve('prismarine-viewer/public/index.js'), 'utf8');
  const patched = patchPerformanceBundle(patchEntityBundle(patchHandBundle(patchBundle(source))));
  new vm.Script(patched);
  assert.equal(patchPerformanceBundle(patched), patched);
  assert.ok(patched.includes('mineblind-viewer-performance-v1'));
  assert.ok(!patched.includes('new r.Tween(this.camera.position).to({x:t.x,y:e,z:t.z},50).start()'));
  assert.ok(!patched.includes('l.setPixelRatio(window.devicePixelRatio||1)'));
  assert.throws(() => patchPerformanceBundle('unknown'), /signature changed/);
});
