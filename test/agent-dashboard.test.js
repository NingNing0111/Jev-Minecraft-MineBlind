const test = require('node:test');
const assert = require('node:assert/strict');
const { model, attach, render } = require('../public/agent-dashboard');

function node() {
  return { textContent: '', className: '', hidden: false, dataset: {}, children: [], attrs: {}, handlers: {},
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(k, fn) { this.handlers[k] = fn; }, focus() { this.focused = true; } };
}
function document() {
  const nodes = new Map();
  const doc = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, querySelectorAll() { return tabs; } };
  const tabs = ['plan', 'state', 'log', 'controls'].map(id => {
    const tab = node(); tab.attrs['aria-controls'] = `panel-${id}`; return tab;
  });
  return { doc, tabs };
}

test('missing payload and disabled agent have explicit empty states', () => {
  assert.equal(model().status, '等待规划');
  assert.deepEqual(model().goals, []);
  assert.equal(model({ experiment: { agentEnabled: false } }).status, 'Agent 未启用');
  assert.equal(model().metrics.find(([key]) => key === '最终目标')[1], '—');
});

test('goal manager cursor determines current-plan progress, with legacy goal fallback', () => {
  const goals = [{ id: 'a' }, { id: 'b' }];
  assert.equal(model({ experiment: { plan: { goals }, goalManager: { goals, index: 1 } } }).index, 1);
  assert.equal(model({ experiment: { goalManager: { goals, index: 2 } } }).status, '本轮规划已完成');
  assert.equal(model({ experiment: { goal: goals[0] } }).goals.length, 1);
  assert.equal(model({ experiment: { goalManager: { goals, index: 99 } } }).index, 2);
});

test('tabs support click, arrow wrapping, Home and End with ARIA state', () => {
  const { doc, tabs } = document(); attach(doc);
  tabs[1].handlers.click();
  assert.equal(tabs[1].attrs['aria-selected'], 'true');
  assert.equal(doc.getElementById('panel-plan').hidden, true);
  assert.equal(doc.getElementById('panel-state').hidden, false);
  const key = (tab, key) => tab.handlers.keydown({ key, preventDefault() {} });
  key(tabs[0], 'ArrowLeft'); assert.equal(tabs[3].tabIndex, 0);
  key(tabs[3], 'ArrowRight'); assert.equal(tabs[0].tabIndex, 0);
  key(tabs[0], 'End'); assert.equal(tabs[3].tabIndex, 0);
  key(tabs[3], 'Home'); assert.equal(tabs[0].tabIndex, 0);
  assert.equal(tabs[0].focused, true);
});

test('render shows rationale, constraints, metrics, inventory and clears stale plans safely', () => {
  const { doc } = document();
  const goal = { id: 'wood', description: '<img src=x onerror=alert(1)>', objective: 'ACQUIRE', target: 'oak_log', amount: 8, constraints: ['避开敌人'] };
  const data = { state: { inventory: { oak_log: 3 } }, experiment: {
    plan: { rationale: '先积累资源', goals: [goal] }, goalManager: { goals: [goal], index: 0 },
    metrics: { agentCalls: 0, tokens: 0 }, saveError: 'disk full' } };
  render(doc, data);
  assert.equal(doc.getElementById('planRationale').textContent, '先积累资源');
  const row = doc.getElementById('goalList').children[0];
  assert.equal(row.className, 'goal-item current');
  assert.equal(row.children[1].textContent, goal.description);
  assert.equal(row.children[3].children[0].textContent, '避开敌人');
  assert.equal(doc.getElementById('inventoryList').textContent, 'oak_log × 3');
  assert.equal(doc.getElementById('saveError').hidden, false);
  render(doc, data); assert.equal(doc.getElementById('goalList').children[0], row);
  render(doc, {});
  assert.equal(doc.getElementById('goalList').children.length, 0);
  assert.equal(doc.getElementById('saveError').hidden, true);
});
