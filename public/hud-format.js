(function (root) {
  const skills = {
    EXPLORE_AREA: ['🧭', '探索区域', 'info'], NAVIGATE_TO: ['➜', '前往目标', 'info'],
    MINE_RESOURCE: ['⛏', '采集资源', 'ok'], CRAFT_ITEM: ['⚒', '合成物品', 'ok'],
    FIGHT_MOB: ['⚔', '战斗', 'danger'], FLEE: ['🏃', '撤离', 'danger'],
    BUILD_PORTAL: ['▣', '建造传送门', 'info'], SEARCH_STRUCTURE: ['⌕', '寻找建筑', 'info'],
    LOOT_CONTAINER: ['📦', '搜集容器物品', 'ok'], EAT: ['🍖', '进食', 'ok'],
    WATER: ['🪣', '用水避险', 'warn'], REQUEST_AGENT: ['💡', '请求规划', 'warn'],
    Idle: ['◌', '待命', 'info'], IDLE: ['◌', '待命', 'info'],
  };
  function action(intent) {
    const [icon, label, className] = skills[intent] || ['•', intent || '待命', 'info'];
    return { icon, label, className };
  }
  function latency(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '未提供';
  }
  function source(value) {
    return ({ local: '本地规则', jev: 'Jev AI', forced: '手动控制', reflex: '本地避险', runtime: '执行器' })[value] || '来源未提供';
  }
  function detail(entry) {
    if (entry.reason) return entry.reason;
    const p = entry.params || {};
    if (p.target) return `目标：${p.target}`;
    if (p.position && ['x', 'y', 'z'].every(k => Number.isFinite(p.position[k])))
      return `前往 ${p.position.x}, ${p.position.y}, ${p.position.z}`;
    return '';
  }
  const api = { action, latency, source, detail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HudFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
