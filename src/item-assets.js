// Serve HUD icons from the same local Minecraft assets as the 3D viewer.
const path = require('path');
const fs = require('fs');
const root = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public/textures/1.20.1');
const items = new Map(require(path.join(root, 'items_textures.json')).map(item => [item.name, item]));
const models = require(path.join(root, 'blocks_models.json'));
const embedded = new Map(require(path.join(root, 'texture_content.json')).map(item => [item.name, item.texture]));
const cache = new Map();

function textureFile(texture) {
  if (typeof texture !== 'string') return null;
  const match = /^(?:minecraft:)?(block|blocks|item|items)\/([a-z0-9_]+)$/.exec(texture);
  if (!match) return null;
  const file = path.join(root, match[1].startsWith('block') ? 'blocks' : 'items', match[2] + '.png');
  return fs.existsSync(file) ? file : null;
}

function blockTextures(name, seen = new Set()) {
  if (seen.has(name) || !models[name]) return {};
  seen.add(name);
  const model = models[name];
  const parent = model.parent?.replace(/^(?:minecraft:)?block\//, '');
  return { ...blockTextures(parent, seen), ...model.textures };
}

async function renderIcon(name) {
  if (!/^[a-z0-9_]+$/.test(name) || !items.has(name) || name === 'air') return null;
  const direct = path.join(root, 'items', name + '.png');
  if (fs.existsSync(direct)) return sprite(direct);
  // Shield is an entity model, not an item sprite; use its actual front-panel UV.
  if (name === 'shield') {
    return sprite(path.join(root, 'entity/shield/base.png'), [2, 2, 12, 22]);
  }
  const textures = blockTextures(name);
  function resolve(value, seen = new Set()) {
    if (!value?.startsWith('#')) return textureFile(value);
    if (seen.has(value)) return null;
    seen.add(value);
    return resolve(textures[value.slice(1)], seen);
  }
  const file = resolve(textures.front || textures.side || textures.all || textures.texture || textures.north || textures.cross || textures.particle)
    || textureFile(items.get(name).texture);
  if (!file) {
    const data = embedded.get(name);
    return data?.startsWith('data:image/png;base64,') ? sprite(Buffer.from(data.slice(22), 'base64')) : null;
  }
  return sprite(file);
}

// Embed local PNGs in a cropped SVG. No browser-side cross-origin requests or
// native canvas bindings are needed, including for animated texture strips.
async function sprite(file, crop) {
  const png = Buffer.isBuffer(file) ? file : await fs.promises.readFile(file);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const viewBox = crop || [0, 0, width, Math.min(width, height)];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}"><image width="${width}" height="${height}" style="image-rendering:pixelated" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
}

function installItemAssets(app) {
  app.get('/assets/items/:name.svg', async (req, res) => {
    try {
      const name = req.params.name;
      if (!items.has(name) || name === 'air') return res.sendStatus(404);
      if (!cache.has(name)) {
        cache.set(name, renderIcon(name).catch(error => { cache.delete(name); throw error; }));
      }
      const icon = await cache.get(name);
      if (!icon) return res.sendStatus(404);
      res.set('Cache-Control', 'public, max-age=86400').type('svg').send(icon);
    } catch (error) {
      console.warn('[ItemAssets]', error.message);
      res.sendStatus(500);
    }
  });
}
module.exports = { installItemAssets, renderIcon };
