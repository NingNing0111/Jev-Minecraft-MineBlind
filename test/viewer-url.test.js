const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const script = fs.readFileSync(path.join(publicDir, 'viewer-url.js'), 'utf8');

for (const [page, expected] of [
  ['http://localhost:3010/', 'http://localhost:3011/'],
  ['http://127.0.0.1:3010/?foo=bar#test', 'http://127.0.0.1:3011/'],
  ['http://[::1]:3010/dashboard', 'http://[::1]:3011/'],
]) {
  test(`Viewer connects directly from ${page}`, () => {
    const elements = { viewer: {}, viewerAddress: {} };
    vm.runInNewContext(script, {
      URL,
      window: { location: { href: page } },
      document: { getElementById: id => elements[id] },
    });
    assert.equal(elements.viewer.src, expected);
    assert.ok(elements.viewerAddress.textContent.includes(new URL(expected).host));
  });
}

test('HUD loads the direct Viewer URL script without tunnel addresses', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<script src="\/viewer-url\.js"><\/script>/);
  assert.doesNotMatch(html, /trycloudflare\.com/);
});
