const fs = require('node:fs');

// Self-contained functions injected into Prismarine's prebuilt browser bundle.
function viewerPixelRatio(width, height, deviceRatio) {
  const native = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  const area = Math.max(1, width * height || 1);
  // Cap Retina supersampling and total framebuffer work (~2 megapixels).
  return Math.min(native, 1.5, Math.sqrt(2073600 / area));
}

function smoothCameraPosition(viewer, Tween, target) {
  if (![target.x, target.y, target.z].every(Number.isFinite)) return;
  const previous = viewer._mineblindPositionTarget;
  if (previous && previous.x === target.x && previous.y === target.y && previous.z === target.z) return;
  viewer._mineblindPositionTween?.stop();
  viewer._mineblindPositionTarget = { ...target };
  const position = viewer.camera.position;
  const distanceSquared = (position.x - target.x) ** 2 + (position.y - target.y) ** 2 + (position.z - target.z) ** 2;
  // Spawn/teleport should not fly through the world; ordinary motion stays interpolated.
  if (!previous || distanceSquared > 64) {
    position.set(target.x, target.y, target.z);
    return;
  }
  viewer._mineblindPositionTween = new Tween(position).to(target, 80).start();
}

const marker = '/* mineblind-viewer-performance-v1 */';
function patchPerformanceBundle(source) {
  if (source.includes(marker)) return source;
  const position = 'new r.Tween(this.camera.position).to({x:t.x,y:e,z:t.z},50).start()';
  const pixelRatio = 'l.setPixelRatio(window.devicePixelRatio||1)';
  const resize = 'l.setSize(window.innerWidth,window.innerHeight)';
  if (source.split(position).length !== 2 || source.split(pixelRatio).length !== 2 || source.split(resize).length !== 3) {
    throw new Error('Unsupported Prismarine Viewer bundle: performance patch signature changed');
  }
  const ratio = `l.setPixelRatio((${viewerPixelRatio.toString()})(window.innerWidth,window.innerHeight,window.devicePixelRatio))`;
  return source.replace(position, `(${smoothCameraPosition.toString()})(this,r.Tween,{x:t.x,y:e,z:t.z})`)
    .replace(pixelRatio + ',', marker)
    // Also recompute when the iframe/browser changes size; setPixelRatio resizes its buffer.
    .replaceAll(resize, `${ratio},${resize}`);
}
function installViewerPerformance() {
  const file = require.resolve('prismarine-viewer/public/index.js');
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchPerformanceBundle(source);
  if (patched !== source) fs.writeFileSync(file, patched);
}
module.exports = { viewerPixelRatio, smoothCameraPosition, patchPerformanceBundle, installViewerPerformance };
