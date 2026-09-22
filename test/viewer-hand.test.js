const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const THREE = require('three');
const { ensureFirstPersonHand, patchHandBundle } = require('../src/viewer-hand');
const { patchBundle } = require('../src/viewer-smoothing');

test('first-person arm is camera-local, visible in frustum and created only once', () => {
  const viewer = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000) };
  ensureFirstPersonHand(viewer, THREE);
  const arm = viewer._mineblindHand;
  assert.equal(arm.parent, viewer.camera);
  assert.equal(viewer.camera.parent, viewer.scene);
  assert.equal(arm.children.length, 2);
  ensureFirstPersonHand(viewer, THREE);
  assert.equal(viewer.camera.children.length, 1);
  for (const aspect of [16 / 9, 1, 0.75]) {
    viewer.camera.aspect = aspect; viewer.camera.updateProjectionMatrix();
    viewer.scene.updateMatrixWorld(true);
    const center = arm.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
    assert.ok(Math.abs(center.x) < 1 && Math.abs(center.y) < 1 && Math.abs(center.z) < 1);
  }
  for (const mesh of arm.children) {
    assert.equal(mesh.material.depthTest, false);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.renderOrder, 1000);
  }
});

test('hand patch composes with smoothing, is executable, idempotent and guarded', () => {
  const source = 'class Viewer {constructor(){this.camera=new n.PerspectiveCamera(75,1,.1,1000);this.scene=new n.Scene()}setFirstPersonCamera(t,e,i){this.camera.rotation.set(i,e,0,"ZYX")}}; Viewer';
  const patched = patchHandBundle(patchBundle(source));
  assert.equal(patchHandBundle(patched), patched);
  assert.equal(patchBundle(patched), patched);
  assert.throws(() => patchHandBundle('unknown'), /signature changed/);
  const Viewer = vm.runInNewContext(patched, { n: THREE, r: {} });
  const v = new Viewer(); v.setFirstPersonCamera(null, 0, 0);
  assert.ok(v._mineblindHand);
});
