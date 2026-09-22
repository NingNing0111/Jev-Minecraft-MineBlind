(function (root) {
  'use strict';
  const objectives = { SURVIVE: '生存', ACQUIRE: '收集资源', ENTER_DIMENSION: '进入维度', FIND_STRUCTURE: '寻找建筑', DEFEAT_DRAGON: '击败末影龙' };
  const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—';
  const duration = value => Number.isFinite(value) ? `${Math.floor(value / 60000)} 分 ${Math.floor(value / 1000) % 60} 秒` : '—';

  function model(data = {}) {
    const e = data.experiment || {};
    const goals = e.goalManager?.goals || e.plan?.goals || (e.goal ? [e.goal] : []);
    const index = Number.isInteger(e.goalManager?.index) ? Math.max(0, Math.min(goals.length, e.goalManager.index)) : 0;
    const disabled = e.agentEnabled === false;
    const m = e.metrics || {};
    return {
      goals, index,
      status: disabled ? 'Agent 未启用' : goals.length ? (index === goals.length ? '本轮规划已完成' : '执行中') : '等待规划',
      rationale: e.plan?.rationale || (disabled ? '当前模式不启用宏观规划 Agent，由战术决策层自主行动。' : '尚未收到宏观规划，等待 Agent 下发目标。'),
      metrics: [
        ['实验模式', e.mode || '—'], ['运行时长', duration(m.elapsedMs)],
        ['Agent 调用', number(m.agentCalls)], ['Agent 错误', number(m.agentErrors)],
        ['Token 消耗', number(m.tokens)], ['死亡次数', number(m.deaths)],
        ['Agent 依赖率', Number.isFinite(m.agentDependencyRatio) ? `${number(m.agentDependencyRatio * 100)}%` : '—'],
        ['平均自主时长', duration(m.meanAutonomousHorizonMs)],
        ['探索区块', number(e.evidence?.new_chunks_visited)],
        ['移动距离', Number.isFinite(e.evidence?.distance_travelled) ? `${number(e.evidence.distance_travelled)} 格` : '—'],
        ['当前维度', data.state?.dimension || '—'],
        ['最终目标', m.completed === true ? '已击败末影龙' : m.completed === false ? '尚未完成' : '—'],
      ],
      saveError: e.saveError || '',
    };
  }

  function attach(doc) {
    const tabs = Array.from(doc.querySelectorAll('[role="tab"]'));
    function select(tab, focus = false) {
      tabs.forEach(item => {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        doc.getElementById(item.getAttribute('aria-controls')).hidden = !active;
      });
      if (focus) tab.focus();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); select(tabs[next], true); }
      });
    });
  }

  function render(doc, data) {
    const view = model(data);
    const text = (id, value) => { doc.getElementById(id).textContent = value; };
    const element = (tag, className, value) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    text('planStatus', view.status);
    text('planRationale', view.rationale);
    text('planProgressText', view.goals.length ? `本轮已完成 ${view.index} / ${view.goals.length} 个目标` : '暂无目标队列');
    const progress = doc.getElementById('planProgress');
    progress.max = view.goals.length || 1;
    progress.value = view.index;
    const list = doc.getElementById('goalList');
    // Preserve scroll position during frequent state updates when the plan is unchanged.
    const signature = JSON.stringify([view.goals, view.index]);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      view.goals.forEach((goal, index) => {
        const state = index < view.index ? 'done' : index === view.index ? 'current' : 'pending';
        const row = element('li', `goal-item ${state}`);
        const heading = element('div', 'goal-heading');
        heading.append(element('span', '', `${String(index + 1).padStart(2, '0')} · ${objectives[goal.objective] || goal.objective || '目标'}`),
          element('span', '', state === 'done' ? '✓ 已完成' : state === 'current' ? '● 当前目标' : '待执行'));
        row.append(heading, element('div', 'plan-copy', goal.description || goal.id),
          element('div', 'goal-detail', `目标：${goal.target || '—'} · 数量 / 阈值：${goal.amount ?? '—'}`));
        if (goal.constraints?.length) {
          const constraints = element('ul', 'goal-detail goal-constraints');
          goal.constraints.forEach(item => constraints.append(element('li', '', item)));
          row.append(constraints);
        }
        list.append(row);
      });
    }
    const metrics = doc.getElementById('metricsGrid');
    metrics.replaceChildren();
    view.metrics.forEach(([label, value]) => {
      const cell = element('div', 'metric');
      cell.append(element('dt', '', label), element('dd', '', value));
      metrics.append(cell);
    });
    text('saveError', view.saveError ? `存档异常：${view.saveError}` : '');
    doc.getElementById('saveError').hidden = !view.saveError;
    const resources = data.state?.environment?.nearby_resources;
    const resourceList = doc.getElementById('nearbyResourceList');
    resourceList.replaceChildren();
    if (!Array.isArray(resources) || resources.length === 0) {
      resourceList.append(element('li', 'plan-copy muted', Array.isArray(resources)
        ? '当前感知范围内未发现资源' : '等待资源感知数据…'));
    } else {
      resources.forEach(resource => {
        const row = element('li', 'goal-item');
        const heading = element('div', 'goal-heading');
        heading.append(element('span', '', resource.display || resource.type || '未知资源'),
          element('span', '', Number.isFinite(resource.distance) ? `${number(resource.distance)} 格` : '距离未知'));
        const harvest = resource.can_harvest === true ? '✓ 可采集' : resource.can_harvest === false ? '⚠ 工具不足' : '采集条件未知';
        const position = resource.position;
        const coordinates = position && [position.x, position.y, position.z].every(Number.isFinite)
          ? `${position.x}, ${position.y}, ${position.z}` : '未知';
        row.append(heading, element('div', 'plan-copy', harvest),
          element('div', 'goal-detail', `${resource.type || '—'} · 坐标：${coordinates}`));
        const details = [resource.min_tool ? `最低工具：${resource.min_tool}` : '',
          resource.drop_item ? `掉落：${resource.drop_item}` : '', resource.needs_smelt ? '需要冶炼' : '',
          resource.harvest_hint || ''].filter(Boolean);
        if (details.length) row.append(element('div', 'goal-detail', details.join(' · ')));
        resourceList.append(row);
      });
    }
    const inventory = Object.entries(data.state?.inventory || {}).filter(([, count]) => count > 0);
    text('inventoryList', inventory.length ? inventory.map(([name, count]) => `${name} × ${count}`).join('\n') : '暂无背包资源');
  }

  const api = { model, attach, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentDashboard = api;
})(typeof window !== 'undefined' ? window : globalThis);
