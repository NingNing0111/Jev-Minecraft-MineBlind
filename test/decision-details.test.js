const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DecisionHistory } = require('../src/decision-history');
const { attach } = require('../public/decision-details');
test('decision snapshots are detached, redacted and bounded', () => {
  const h = new DecisionHistory(2), input = { inventory: { stone: 1 }, apiKey: 'private' };
  const id = h.add({ input, output: { skill: 'CRAFT_ITEM' } });
  input.inventory.stone = 99;
  assert.equal(h.get(id).input.inventory.stone, 1);
  assert.equal(h.get(id).input.apiKey, '[REDACTED]');
  h.add({}); h.add({}); assert.equal(h.get(id), undefined);
});
function dom() {
  const nodes = new Map();
  const element = () => ({ children: [], open: false, textContent: '', appendChild(n) { this.children.push(n); },
    addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } });
  return { createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } };
}
test('details render input/output as text and handle expired records', async () => {
  const doc = dom();
  const open = attach(doc, async () => ({ ok: true, json: async () => ({ input: '<script>alert(1)</script>', output: { skill: 'FLEE' } }) }));
  await open({ id: 'one', timestamp: 1 });
  const sections = doc.getElementById('decisionDetail').children;
  assert.match(sections[1].children[1].textContent, /<script>/);
  assert.match(sections[2].children[1].textContent, /FLEE/);
  await attach(doc, async () => ({ ok: false, json: async () => ({ error: '记录已过期' }) }))({ id: 'old', timestamp: 1 });
  assert.equal(doc.getElementById('decisionDetail').textContent, '记录已过期');
});
test('closing details ignores an in-flight response', async () => {
  const doc = dom(); let resolve;
  const open = attach(doc, () => new Promise(r => { resolve = r; }));
  const pending = open({ id: 'one', timestamp: 1 });
  doc.getElementById('closeDecision').onclick();
  resolve({ ok: true, json: async () => ({ input: 'late' }) }); await pending;
  assert.equal(doc.getElementById('decisionDialog').open, false);
  assert.equal(doc.getElementById('decisionDetail').children.length, 0);
});
