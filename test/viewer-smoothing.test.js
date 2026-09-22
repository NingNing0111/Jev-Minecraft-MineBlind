const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { smoothCameraRotation, patchBundle } = require('../src/viewer-smoothing');

class Tween {
  constructor(state) { this.state = state; }
  to(target, duration) { this.target = target; this.duration = duration; return this; }
  onUpdate(update) { this.update = update; return this; }
  start() { return this; }
  stop() { this.stopped = true; }
  advance(fraction) {
    for (const key of Object.keys(this.target)) {
      this.state[key] += (this.target[key] - this.state[key]) * fraction;
    }
    this.update();
  }
}
function viewer() {
  return { camera: { rotation: { set(pitch, yaw, roll, order) {
    Object.assign(this, { pitch, yaw, roll, order });
  } } } };
}
const radians = degrees => degrees * Math.PI / 180;

test('initial camera snaps once, subsequent turns interpolate yaw and pitch', () => {
  const v = viewer();
  smoothCameraRotation(v, Tween, 0, 0);
  smoothCameraRotation(v, Tween, 1, 0.5);
  assert.equal(v.camera.rotation.yaw, 0);
  assert.equal(v._mineblindRotationTween.duration, 80);
  v._mineblindRotationTween.advance(0.5);
  assert.equal(v.camera.rotation.yaw, 0.5);
  assert.equal(v.camera.rotation.pitch, 0.25);
  assert.equal(v.camera.rotation.order, 'ZYX');
});

for (const direction of [1, -1]) {
  test(`shortest path across angle boundary (${direction})`, () => {
    const v = viewer();
    smoothCameraRotation(v, Tween, radians(179 * direction), 0);
    smoothCameraRotation(v, Tween, radians(-179 * direction), 0);
    const delta = v._mineblindRotationTween.target.yaw - v._mineblindRotation.yaw;
    assert.ok(Math.abs(delta - radians(2 * direction)) < 1e-10);
  });
}

test('new target cancels old tween and continues from displayed orientation', () => {
  const v = viewer();
  smoothCameraRotation(v, Tween, 0, 0);
  smoothCameraRotation(v, Tween, 1, 0);
  const old = v._mineblindRotationTween;
  old.advance(0.5);
  smoothCameraRotation(v, Tween, 2, 0);
  assert.equal(old.stopped, true);
  assert.equal(v.camera.rotation.yaw, 0.5);
  assert.equal(v._mineblindRotation.yaw, 0.5);
  smoothCameraRotation(v, Tween, NaN, 0);
  assert.equal(v._mineblindRotationTween.target.yaw, 2);
});

test('identical orientation packets preserve the running tween', () => {
  const v = viewer();
  smoothCameraRotation(v, Tween, 0, 0);
  smoothCameraRotation(v, Tween, 1, 0.5);
  const tween = v._mineblindRotationTween;
  tween.advance(0.5);
  smoothCameraRotation(v, Tween, 1 + 2 * Math.PI, 0.5);
  assert.equal(v._mineblindRotationTween, tween);
  assert.equal(tween.stopped, undefined);
});

test('legacy v1 camera patch upgrades once and remains executable', () => {
  const source = 'class Viewer {setFirstPersonCamera(t,e,i){/* mineblind-camera-smoothing-v1 */(function smoothCameraRotation(viewer,Tween,yaw,pitch){viewer.camera.rotation.set(pitch,yaw,0,"ZYX")})(this,r.Tween,e,i)}}; Viewer';
  const patched = patchBundle(source);
  assert.equal(patched.includes('smoothing-v1'), false);
  assert.equal(patchBundle(patched), patched);
  const Viewer = vm.runInNewContext(patched, { r: { Tween } });
  const v = new Viewer(); v.camera = viewer().camera;
  v.setFirstPersonCamera(null, 0, 0); v.setFirstPersonCamera(null, 1, 0.5);
  assert.equal(v._mineblindRotationTween.target.yaw, 1);
});

test('browser bundle patch is executable, idempotent and rejects unknown versions', () => {
  const source = 'class Viewer {setFirstPersonCamera(t,e,i){this.camera.rotation.set(i,e,0,"ZYX")}}; Viewer';
  const patched = patchBundle(source);
  assert.equal(patchBundle(patched), patched);
  assert.throws(() => patchBundle('unknown'), /signature changed/);
  const Viewer = vm.runInNewContext(patched, { r: { Tween } });
  const v = new Viewer();
  v.camera = viewer().camera;
  v.setFirstPersonCamera(null, 0, 0);
  v.setFirstPersonCamera(null, 1, 0.5);
  v._mineblindRotationTween.advance(1);
  assert.equal(v.camera.rotation.yaw, 1);
  assert.equal(v.camera.rotation.pitch, 0.5);
});
