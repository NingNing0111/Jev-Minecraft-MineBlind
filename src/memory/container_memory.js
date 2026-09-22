/**
 * container_memory.js — 箱子/容器内容快照记忆
 * 开箱后保存内容，注入到环境感知，避免重复开空箱
 */

const MAX_ENTRIES = 64;

class ContainerMemory {
  constructor(saved = {}) {
    // key = "x,y,z" => { position, block_name, contents: [{name,count}], looted_at }
    this.store = new Map(Object.entries(saved.store || {}));
    this.pendingWrites = new Set();
  }

  /**
   * 记录一次开箱结果
   * @param {object} position { x, y, z }
   * @param {string} blockName
   * @param {Array} items  mineflayer containerItems()
   */
  record(position, blockName, items, dimension = 'overworld') {
    const key = `${dimension}:${this._key(position)}`;
    const contents = items.map(i => ({ name: i.name, count: i.count }));
    this.store.set(key, {
      position: { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) },
      dimension,
      block_name: blockName,
      contents,
      item_count: contents.reduce((s, i) => s + i.count, 0),
      looted_at: Date.now(),
    });
    if (this.storage) {
      const pending = this.storage.request('record', this.store.get(key))
        .catch(error => { this.writeError = error; })
        .finally(() => this.pendingWrites.delete(pending));
      this.pendingWrites.add(pending);
    }
    // 裁剪
    if (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
  }

  /**
   * 获取附近已知容器列表（供感知层注入）
   * @param {object} pos  当前玩家坐标
   * @param {number} radius 扫描半径
   */
  async refresh(storage, pos, dimension) {
    this.storage = storage;
    await this.flush();
    this.cached = await storage.request('nearby', { position: pos, dimension, radius: 48 });
    this.cachedDimension = dimension;
  }

  async flush() {
    await Promise.all([...this.pendingWrites]);
    // A failed persistent write must not silently produce a successful checkpoint.
    if (this.writeError) throw this.writeError;
  }

  nearby(pos, radius = 48, dimension = 'overworld') {
    if (this.storage) return this.cachedDimension === dimension ? this.cached || [] : [];
    const result = [];
    for (const entry of this.store.values()) {
      if ((entry.dimension || 'overworld') !== dimension) continue;
      const dist = Math.hypot(entry.position.x - pos.x, entry.position.y - pos.y, entry.position.z - pos.z);
      if (dist <= radius) {
        result.push({ ...entry, distance: Math.round(dist * 10) / 10 });
      }
    }
    result.sort((a, b) => a.distance - b.distance);
    return result.slice(0, 8);
  }

  _key(pos) {
    return `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
  }

  snapshot() {
    const store = {};
    for (const [k, v] of this.store) store[k] = v;
    return { store };
  }
}

module.exports = { ContainerMemory };
