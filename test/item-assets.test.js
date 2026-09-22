const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { renderIcon, installItemAssets } = require('../src/item-assets');
const icons = require('../public/item-icons');

test('local assets embed PNG textures for tools, armor, blocks and shield', async () => {
  for (const name of ['iron_sword', 'iron_helmet', 'oak_log', 'cobblestone', 'grass_block', 'crafting_table', 'shield', 'water_bucket']) {
    const svg = await renderIcon(name);
    assert.match(svg, /^<svg /, name);
    const png = Buffer.from(svg.match(/base64,([^\"]+)/)[1], 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG', name);
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, name);
  }
  assert.equal(await renderIcon('../server'), null);
  assert.equal(await renderIcon('unknown_item'), null);
  assert.equal(await renderIcon('air'), null);
});

test('same-origin item route serves SVG and rejects unknown names', async t => {
  const app = express();
  installItemAssets(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/assets/items/iron_sword.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(response.headers.get('cache-control'), /max-age/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${base}/assets/items/unknown.svg`)).status, 404);
});

test('icons use safe local URLs and show text fallback on load errors', () => {
  const classes = new Set();
  const handlers = {};
  const doc = { createElement: () => ({
    setAttribute() {}, addEventListener(event, handler) { handlers[event] = handler; },
    parentNode: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
  }) };
  const image = icons.create(doc, 'iron_sword');
  assert.equal(image.src, '/assets/items/iron_sword.svg');
  handlers.load(); assert.equal(classes.has('has-item-icon'), true);
  handlers.error(); assert.equal(image.hidden, true);
  assert.equal(classes.has('has-item-icon'), false);
  assert.equal(icons.create(doc, '<script>'), null);
});
