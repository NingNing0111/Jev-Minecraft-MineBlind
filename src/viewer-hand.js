const fs = require('node:fs');

// Browser-bundle injection: a camera-local, default block-style right arm.
// This is a visual view model, not the bot's world entity or held-item state.
function ensureFirstPersonHand(viewer, THREE) {
  if (viewer._mineblindHand) return;
  const arm = new THREE.Group();
  const material = color => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.42, 0.18), material(0xb98262));
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.24, 0.19), material(0x20a6ae));
  sleeve.position.y = -0.28;
  for (const mesh of [hand, sleeve]) {
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    arm.add(mesh);
  }
  arm.position.set(0.36, -0.30, -0.65);
  arm.rotation.set(-0.45, -0.15, -0.18);
  viewer.camera.add(arm);
  // The upstream camera is not a child of the scene; its children otherwise
  // never participate in rendering. Adding it preserves its world transform.
  if (!viewer.camera.parent) viewer.scene.add(viewer.camera);
  viewer._mineblindHand = arm;
}

const marker = '/* mineblind-first-person-hand-v1 */';
function patchHandBundle(source) {
  if (source.includes(marker)) return source;
  const signature = 'setFirstPersonCamera(t,e,i){';
  if (source.split(signature).length !== 2 || !source.includes('this.camera=new n.PerspectiveCamera')) {
    throw new Error('Unsupported Prismarine Viewer bundle: hand patch signature changed');
  }
  return source.replace(signature,
    `${signature}${marker}(${ensureFirstPersonHand.toString()})(this,n);`);
}
function installViewerHand() {
  const bundlePath = require.resolve('prismarine-viewer/public/index.js');
  const source = fs.readFileSync(bundlePath, 'utf8');
  const patched = patchHandBundle(source);
  if (source !== patched) fs.writeFileSync(bundlePath, patched);
}
module.exports = { ensureFirstPersonHand, patchHandBundle, installViewerHand };
