const fs = require('node:fs');

// Executed inside the browser bundle. Keep this function self-contained.
function smoothCameraRotation(viewer, Tween, yaw, pitch) {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
  const previous = viewer._mineblindRotationTarget;
  if (previous && Math.abs(Math.atan2(Math.sin(yaw - previous.yaw), Math.cos(yaw - previous.yaw))) < 1e-10 && previous.pitch === pitch) return;
  viewer._mineblindRotationTarget = { yaw, pitch };
  const camera = viewer.camera;
  if (!viewer._mineblindRotation) {
    viewer._mineblindRotation = { yaw, pitch };
    camera.rotation.set(pitch, yaw, 0, 'ZYX');
    return;
  }
  viewer._mineblindRotationTween?.stop();
  const state = viewer._mineblindRotation;
  // Rebase to avoid accumulated full turns and take the shortest path across ±π.
  state.yaw = Math.atan2(Math.sin(state.yaw), Math.cos(state.yaw));
  const delta = Math.atan2(Math.sin(yaw - state.yaw), Math.cos(yaw - state.yaw));
  viewer._mineblindRotationTween = new Tween(state)
    .to({ yaw: state.yaw + delta, pitch }, 80)
    .onUpdate(() => camera.rotation.set(state.pitch, state.yaw, 0, 'ZYX'))
    .start();
}

const marker = '/* mineblind-camera-smoothing-v2 */';
const legacyMarker = '/* mineblind-camera-smoothing-v1 */';
// prismarine-viewer ships a prebuilt browser bundle; editing viewer/lib alone
// would have no effect. Guard the known bundle signature against upstream changes.
const original = 'this.camera.rotation.set(i,e,0,"ZYX")';
function patchBundle(source) {
  if (source.includes(marker)) return source;
  // Upgrade already-patched installations, not just clean npm bundles.
  if (source.includes(legacyMarker)) {
    const start = source.indexOf(legacyMarker);
    const suffix = ')(this,r.Tween,e,i)';
    const end = source.indexOf(suffix, start);
    if (source.split(legacyMarker).length !== 2 || end < 0 ||
        !source.slice(start, end).startsWith(`${legacyMarker}(function smoothCameraRotation(`)) {
      throw new Error('Unsupported Prismarine Viewer bundle: legacy camera signature changed');
    }
    return source.slice(0, start) + `${marker}(${smoothCameraRotation.toString()}${suffix}` + source.slice(end + suffix.length);
  }
  if (source.split(original).length !== 2 || !source.includes('setFirstPersonCamera(t,e,i)')) {
    throw new Error('Unsupported Prismarine Viewer bundle: camera patch signature changed');
  }
  return source.replace(original,
    `${marker}(${smoothCameraRotation.toString()})(this,r.Tween,e,i)`);
}

function installViewerSmoothing() {
  const bundlePath = require.resolve('prismarine-viewer/public/index.js');
  const source = fs.readFileSync(bundlePath, 'utf8');
  const patched = patchBundle(source);
  if (patched !== source) fs.writeFileSync(bundlePath, patched);
}

module.exports = { smoothCameraRotation, patchBundle, installViewerSmoothing };
