const { Vec3 } = require('vec3');

const DROPS = { cobblestone: 'stone', raw_iron: 'iron_ore', raw_gold: 'gold_ore', diamond: 'diamond_ore', coal: 'coal_ore' };
const MARKERS = { village: 'bell', stronghold: 'end_portal_frame', nether_fortress: 'nether_bricks' };
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'powder_snow']);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const cell = (dimension, p) => `${dimension}:${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`;
const point = p => ({ x: p.x, y: p.y, z: p.z });

// 卡住检测参数
const STUCK_CHECK_MS = 6000;    // 每 6 秒采样一次卡住判断
const STUCK_MOVE_THRESHOLD = 1.5; // 小于 1.5 格视为几乎未动
const STUCK_MAX_COUNT = 3;       // 连续 3 次未动 → 判定为卡住

// 打转检测参数
const LOOP_WINDOW_MS = 20000;   // 20 秒窗口
const LOOP_TRAVEL_MIN = 24;     // 窗口内至少走 24 格才判断
const LOOP_DISPLACEMENT_RATIO = 0.25; // 位移 < 总路程 25% 视为打转

// 资源吸引力（引导探索方向用）
const RESOURCE_ATTRACTION = {
  critical: 120,
  high: 60,
  medium: 25,
};

// Local observations only. A safe endpoint is a candidate, NOT proof of a reachable path.
class Exploration {
  constructor(saved = {}) {
    this.visits = new Map((saved.visits || []).slice(-512));
    this.blocked = new Map((saved.blocked || []).slice(-128));
    this.active = null; this.heading = null; this.samples = []; this.lastCell = null;
    this.lastSample = -Infinity; this.cache = null;
    // 卡住检测状态
    this.stuckSamples = [];      // { pos, time }
    this.lastStuckCheck = -Infinity;
    this.stuckCount = 0;
    this.stuckSince = null;
    this.lastStuckPos = null;
  }

  snapshot() { return { visits: [...this.visits], blocked: [...this.blocked] }; }

  reset() {
    this.active = null; this.heading = null; this.samples = []; this.lastCell = null;
    this.lastSample = -Infinity; this.cache = null;
    this.stuckSamples = []; this.lastStuckCheck = -Infinity;
    this.stuckCount = 0; this.stuckSince = null; this.lastStuckPos = null;
  }

  sample(bot, now) {
    const dimension = String(bot.game?.dimension || 'overworld');
    if (this.dimension !== dimension) { this.reset(); this.dimension = dimension; }
    const p = bot.entity.position, key = cell(dimension, p);
    if (key !== this.lastCell) {
      const visits = (this.visits.get(key) || 0) + 1;
      this.visits.delete(key); this.visits.set(key, visits); this.lastCell = key;
      if (this.visits.size > 512) this.visits.delete(this.visits.keys().next().value);
    }
    if (now - this.lastSample >= 2000) {
      this.samples.push({ ...point(p), time: now }); this.samples = this.samples.slice(-24); this.lastSample = now;
    }
    for (const [key, until] of this.blocked) if (until <= now) this.blocked.delete(key);
  }

  /**
   * 卡住检测：每隔 STUCK_CHECK_MS 比较位移
   * 返回 { stuck: bool, stuckMs: number|null }
   */
  updateStuck(pos, now) {
    if (now - this.lastStuckCheck < STUCK_CHECK_MS) {
      return { stuck: this.stuckCount >= STUCK_MAX_COUNT, stuckMs: this.stuckSince ? now - this.stuckSince : null };
    }
    this.lastStuckCheck = now;
    if (this.lastStuckPos) {
      const moved = distance(pos, this.lastStuckPos);
      if (moved < STUCK_MOVE_THRESHOLD) {
        this.stuckCount++;
        if (!this.stuckSince) this.stuckSince = now;
      } else {
        this.stuckCount = Math.max(0, this.stuckCount - 1);
        if (this.stuckCount === 0) this.stuckSince = null;
      }
    }
    this.lastStuckPos = point(pos);
    return { stuck: this.stuckCount >= STUCK_MAX_COUNT, stuckMs: this.stuckSince ? now - this.stuckSince : null };
  }

  /**
   * 卡住后：废弃当前目的地，封锁当前格，强制扩大搜索半径
   */
  forceEscape(pos, now) {
    if (this.active) {
      this.finish(this.active.position, true, now);
    }
    // 也将当前位置附近格封锁一段时间
    const key = cell(this.dimension, pos);
    this.blocked.delete(key); this.blocked.set(key, now + 60000);
    this.stuckCount = 0; this.stuckSince = null;
    this.cache = null;
  }

  surface(bot, x, y, z) {
    for (const dy of [0, 1, -1, 2, -2, -3]) {
      const p = new Vec3(Math.floor(x) + .5, Math.floor(y) + dy, Math.floor(z) + .5);
      const blocks = [-1, 0, 1].map(offset => bot.blockAt(p.offset(0, offset, 0)));
      if (blocks.some(b => !b || HAZARDS.has(b.name))) continue;
      if (blocks[0].boundingBox === 'block' && blocks[1].boundingBox === 'empty' && blocks[2].boundingBox === 'empty') return point(p);
    }
    return null;
  }

  observe(bot, target = '', now = Date.now()) {
    this.sample(bot, now);
    const p = bot.entity.position, dimension = this.dimension;

    // --- 卡住检测 ---
    const stuckInfo = this.updateStuck(p, now);
    if (stuckInfo.stuck) {
      this.forceEscape(p, now);
    }

    if (this.active && (this.active.target !== target || distance(p, this.active.position) <= 3)) {
      this.active = null; this.cache = null;
    }
    if (this.cache && this.cache.target === target && now - this.cache.time < 2000 && distance(p, this.cache.origin) < 4)
      return this.cache.value;

    const names = [...new Set([MARKERS[target] || DROPS[target] || target, 'oak_log', 'birch_log', 'spruce_log', 'stone', 'coal_ore', 'crafting_table', 'chest'].filter(Boolean))];
    const resources = [];
    for (const name of names) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id === undefined) continue;
      const block = bot.findBlock({ matching: id, maxDistance: 48 });
      if (block) resources.push({ block: name, position: point(block.position), distance: Math.round(p.distanceTo(block.position)), matches_target: name === (MARKERS[target] || DROPS[target] || target) });
    }

    // --- 读取感知层的周围资源（来自 perception.js 注入，通过 bot._perceptionResources 共享）---
    // 如果 runtime 将 nearby_resources 注入到 bot 临时属性，可直接利用；否则降级为空
    const perceptionResources = bot._perceptionResources || [];

    const candidates = [];
    const add = (position, reason, bonus = 0) => {
      const key = cell(dimension, position);
      if (this.blocked.has(key)) return;
      const dx = position.x - p.x, dz = position.z - p.z, length = Math.hypot(dx, dz);
      if (length <= 3) return;
      const visits = this.visits.get(key) || 0;
      // 访问惩罚随次数指数增长，防止反复绕同一区域
      const visitPenalty = visits === 0 ? 40 : -(visits * visits * 15);
      const alignment = this.heading ? (dx * this.heading.x + dz * this.heading.z) / length : 0;
      const threats = Object.values(bot.entities || {}).filter(e => ['creeper', 'zombie', 'skeleton', 'witch', 'drowned', 'spider', 'pillager', 'blaze'].includes(e?.name));
      const danger = threats.some(e => e.position && distance(e.position, position) < 10);
      if (danger) return;
      // 资源吸引力加成：如果候选点方向上有高价值资源，加分
      let resourceBonus = 0;
      for (const res of perceptionResources) {
        const rdx = res.position.x - p.x, rdz = res.position.z - p.z;
        const rl = Math.hypot(rdx, rdz);
        if (rl < 1) continue;
        const attract = RESOURCE_ATTRACTION[res.value] || 0;
        // 方向对齐度
        const align = (dx * rdx + dz * rdz) / (length * rl);
        if (align > 0.7) resourceBonus += attract * align;
      }
      const score = bonus + visitPenalty + alignment * 20 + length * .2 + resourceBonus;
      candidates.push({ position, reason, visits, score: Math.round(score * 10) / 10 });
    };

    // 目标资源优先：直接导向已观测到的目标方块旁
    for (const resource of resources.filter(r => r.matches_target)) {
      for (const [dx, dz] of [[2,0],[-2,0],[0,2],[0,-2]]) {
        const q = resource.position, stand = this.surface(bot, q.x + dx, q.y, q.z + dz);
        if (stand) add(stand, `approach_observed:${resource.block}`, 120);
      }
    }

    // 感知资源直接导向（critical/high 资源强吸引）
    for (const res of perceptionResources) {
      if (res.value === 'medium') continue; // medium 只作为方向加成，不单独建立候选
      for (const [dx, dz] of [[2,0],[-2,0],[0,2],[0,-2]]) {
        const stand = this.surface(bot, res.position.x + dx, res.position.y, res.position.z + dz);
        if (stand) {
          const attraction = RESOURCE_ATTRACTION[res.value] || 40;
          add(stand, `resource_pull:${res.type}`, attraction);
        }
      }
    }

    // 卡住时扩大搜索半径到 48，否则正常 12/24
    const radii = stuckInfo.stuck ? [36, 48] : [12, 24];
    for (const radius of radii) for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      const stand = this.surface(bot, p.x + Math.cos(angle) * radius, p.y, p.z + Math.sin(angle) * radius);
      if (stand) add(stand, 'unvisited_local_frontier');
    }

    candidates.sort((a, b) => b.score - a.score);
    if (this.active && !candidates.some(c => distance(c.position, this.active.position) < 2)) {
      const a = this.active.position;
      const safe = this.surface(bot, a.x, a.y, a.z);
      if (!safe || safe.y !== a.y || Object.values(bot.entities || {}).some(e =>
        ['creeper','zombie','skeleton','witch','drowned','spider','pillager','blaze'].includes(e?.name) && e.position && distance(e.position, a) < 10)) this.active = null;
    }
    if (!this.active && candidates.length) {
      const next = candidates[0];
      this.active = { target, position: next.position, reason: next.reason };
      const length = distance(p, next.position);
      this.heading = { x: (next.position.x - p.x) / length, z: (next.position.z - p.z) / length };
    }

    // 打转检测
    const first = this.samples[0];
    const travelled = this.samples.slice(1).reduce((sum, q, i) => sum + distance(q, this.samples[i]), 0);
    const displacement = first ? distance(p, first) : 0;
    const looping = !!first && now - first.time >= LOOP_WINDOW_MS && travelled > LOOP_TRAVEL_MIN && displacement < travelled * LOOP_DISPLACEMENT_RATIO;

    const value = {
      purpose: target ? `search:${target}` : 'discover_unvisited_terrain',
      resources, destination: this.active ? { ...this.active, position: { ...this.active.position } } : null,
      candidates: candidates.slice(0, 5), revisits_here: this.visits.get(cell(dimension, p)) || 0,
      looping, travelled_recent: Math.round(travelled), displacement_recent: Math.round(displacement),
      blocked_areas: this.blocked.size,
      // 卡住状态上报，供 Jev / planner 感知
      stuck: stuckInfo.stuck,
      stuck_duration_ms: stuckInfo.stuckMs,
      status: this.active ? 'destination_selected' : 'no_safe_local_frontier',
      limitations: 'Loaded local blocks only; endpoint safety is not path reachability. Missing resources are not proof of global absence.',
    };
    this.cache = { target, time: now, origin: point(p), value };
    return value;
  }

  finish(position, failed = false, now = Date.now()) {
    if (failed && position) {
      const key = cell(this.dimension, position);
      this.blocked.delete(key); this.blocked.set(key, now + 120000);
      if (this.blocked.size > 128) this.blocked.delete(this.blocked.keys().next().value);
    }
    this.active = null; this.cache = null;
  }
}
module.exports = { Exploration };
