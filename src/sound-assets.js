'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const INDEX_HASH = '78fe335ef048443d060bc53ace10bb0f41af7d50';
const INDEX_URL = `https://piston-meta.mojang.com/v1/packages/${INDEX_HASH}/5.json`;
const resourceUrl = hash => `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`;

function createSoundAssets(cacheDir = path.join(require('./experiment/config').config().saveRoot, 'sound-cache')) {
  let manifestPromise;
  const pending = new Map();
  async function cached(hash, url) {
    const file = path.join(cacheDir, hash);
    try {
      const data = await fs.readFile(file);
      if (createHash('sha1').update(data).digest('hex') === hash) return data;
    } catch {}
    if (pending.has(hash)) return pending.get(hash);
    if (pending.size >= 16) throw new Error('Sound downloads busy; retry shortly');
    const task = (async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Mojang asset HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (createHash('sha1').update(data).digest('hex') !== hash) throw new Error('Sound asset checksum mismatch');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, data);
      return data;
    })();
    pending.set(hash, task);
    try { return await task; } finally { pending.delete(hash); }
  }
  async function manifest() {
    if (!manifestPromise) manifestPromise = (async () => {
      let index, events;
      try {
        index = JSON.parse(await cached(INDEX_HASH, INDEX_URL));
        const meta = index.objects['minecraft/sounds.json'];
        events = JSON.parse(await cached(meta.hash, resourceUrl(meta.hash)));
      } catch (error) {
        throw new Error(`Unable to load Minecraft sound metadata: ${error.message}`, { cause: error });
      }
      const files = {};
      for (const [name, asset] of Object.entries(index.objects)) {
        if (name.startsWith('minecraft/sounds/') && name.endsWith('.ogg')) {
          files[name.slice(17, -4)] = asset.hash;
        }
      }
      return { version: '1.20.1', events, files };
    })().catch(error => { manifestPromise = null; throw error; });
    return manifestPromise;
  }
  function routes(app) {
    app.get('/api/audio/manifest', async (_req, res) => {
      try { res.json(await manifest()); }
      catch (error) { res.status(503).json({ error: error.message }); }
    });
    app.get('/api/audio/file/:hash', async (req, res) => {
      try {
        const { hash } = req.params;
        if (!/^[a-f0-9]{40}$/.test(hash)) return res.sendStatus(404);
        const data = await manifest();
        if (!Object.values(data.files).includes(hash)) return res.sendStatus(404);
        const buffer = await cached(hash, resourceUrl(hash));
        res.set('Cache-Control', 'public, max-age=31536000, immutable').type('audio/ogg').send(buffer);
      } catch (error) { res.status(503).json({ error: error.message }); }
    });
  }
  return { manifest, routes };
}
module.exports = { createSoundAssets };
