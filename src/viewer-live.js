const fs = require('node:fs');

// Injected into Prismarine's server adapter. Independent of AI ticks and move
// events: stationary bots and newly connected viewers still receive live poses.
function attachLivePosition(bot, socket, worldView, firstPerson) {
  let closed = false;
  let updating = false;
  let lastSent = -Infinity;
  function publish(force = false) {
    if (closed || !bot.entity?.position) return;
    const now = performance.now();
    if (!force && now - lastSent < 50) return;
    lastSent = now;
    const { position, yaw, pitch } = bot.entity;
    // Clone: asynchronous chunk loading must not retain a mutable bot position.
    const pos = position.clone();
    socket.emit('position', { pos, yaw, ...(firstPerson ? { pitch } : {}), addMesh: true });
    // Chunk work must neither overlap nor hold up camera packets.
    if (!updating) {
      updating = true;
      Promise.resolve().then(() => {
        if (!closed) return worldView.updatePosition(pos);
      }).catch(error => {
        if (!closed) console.warn('[Viewer] Position update failed:', error.message);
      }).finally(() => { updating = false; });
    }
  }
  const onMove = () => publish();
  const timer = setInterval(() => publish(true), 50);
  timer.unref?.();
  bot.on('move', onMove);
  function detach() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    bot.removeListener('move', onMove);
    bot.removeListener('end', detach);
    socket.removeListener('disconnect', detach);
  }
  bot.once('end', detach);
  socket.once('disconnect', detach);
  publish(true);
  return detach;
}

const marker = '/* mineblind-live-position-v1 */';
function patchLivePosition(source) {
  if (source.includes(marker)) return source;
  const start = source.indexOf('    function botPosition () {');
  const endSignature = "    bot.on('move', botPosition)";
  const end = source.indexOf(endSignature, start);
  const cleanup = "      bot.removeListener('move', botPosition)";
  if (start < 0 || end < 0 || source.split(cleanup).length !== 2) {
    throw new Error('Unsupported Prismarine Viewer adapter: live position signature changed');
  }
  return (source.slice(0, start) +
    `    ${marker}\n    const detachPosition = (${attachLivePosition.toString()})(bot, socket, worldView, firstPerson)` +
    source.slice(end + endSignature.length)).replace(cleanup, '      detachPosition()');
}
function installViewerLive() {
  const file = require.resolve('prismarine-viewer/lib/mineflayer');
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchLivePosition(source);
  if (source !== patched) fs.writeFileSync(file, patched);
}
module.exports = { attachLivePosition, patchLivePosition, installViewerLive };
