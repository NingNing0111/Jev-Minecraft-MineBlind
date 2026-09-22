(function (root) {
  'use strict';
  function choose(events, name, random = Math.random, depth = 0) {
    if (depth > 8) return null;
    const entries = events[name]?.sounds || [];
    const total = entries.reduce((sum, entry) => sum + (typeof entry === 'string' ? 1 : entry.weight ?? 1), 0);
    let roll = random() * total;
    for (const item of entries) {
      const entry = typeof item === 'string' ? { name: item } : item;
      roll -= entry.weight ?? 1;
      if (roll >= 0) continue;
      const selected = entry.type === 'event' ? choose(events, entry.name.replace(/^minecraft:/, ''), random, depth + 1) : entry;
      if (!selected) return null;
      if (entry.type !== 'event') return { ...entry, name: entry.name.replace(/^minecraft:/, '') };
      return { ...selected, volume: (entry.volume ?? 1) * (selected.volume ?? 1), pitch: (entry.pitch ?? 1) * (selected.pitch ?? 1) };
    }
    return null;
  }
  function gain(event, sample) {
    const distance = Math.hypot(event.position.x - event.listener.x, event.position.y - event.listener.y, event.position.z - event.listener.z);
    const volume = event.volume * (sample.volume ?? 1);
    const range = event.range ?? (sample.attenuation_distance ?? 16) * Math.max(1, event.volume);
    return Math.min(1, volume) * Math.max(0, 1 - distance / range);
  }
  function attach(socket) {
    const button = document.getElementById('audioToggle');
    const slider = document.getElementById('audioVolume');
    const status = document.getElementById('audioStatus');
    let context, master, manifest, enabled = false, generation = 0;
    const buffers = new Map(), active = new Set();
    const categories = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice'];
    function stop(filter = {}) {
      generation++;
      for (const voice of active) {
        if (filter.name != null && filter.name !== voice.name) continue;
        if (filter.category != null && filter.category !== voice.category && categories[filter.category] !== voice.category) continue;
        voice.source.stop();
        active.delete(voice);
      }
    }
    async function buffer(hash) {
      if (!buffers.has(hash)) {
        if (buffers.size >= 128) buffers.delete(buffers.keys().next().value);
        buffers.set(hash, (async () => {
          const response = await fetch(`/api/audio/file/${hash}`);
          if (!response.ok) throw new Error('音效下载失败');
          return context.decodeAudioData(await response.arrayBuffer());
        })().catch(error => { buffers.delete(hash); throw error; }));
      }
      return buffers.get(hash);
    }
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (enabled) {
          enabled = false;
          stop();
          master.gain.value = 0;
          button.textContent = '🔇 开启游戏声音';
          status.textContent = '已静音';
          return;
        }
        if (!context) {
          context = new (root.AudioContext || root.webkitAudioContext)();
          master = context.createGain();
          master.connect(context.destination);
        }
        await context.resume();
        status.textContent = '加载 Minecraft 音效资源…';
        if (!manifest) {
          const response = await fetch('/api/audio/manifest');
          if (!response.ok) throw new Error('资源不可用，请重试');
          manifest = await response.json();
        }
        enabled = true;
        master.gain.value = Number(slider.value) / 100;
        button.textContent = '🔊 静音';
        status.textContent = '已开启 · 等待服务器声音事件';
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    slider.addEventListener('input', () => { if (master) master.gain.value = enabled ? Number(slider.value) / 100 : 0; });
    socket.on('game_sound', async event => {
      if (!enabled || context.state !== 'running' || !manifest) return;
      const sample = choose(manifest.events, event.name);
      const hash = sample && manifest.files[sample.name];
      if (!hash) return;
      const volume = gain(event, sample);
      if (volume <= 0 || active.size >= 32) return;
      const epoch = generation, started = performance.now();
      try {
        const decoded = await buffer(hash);
        // Never replay stale sounds after downloads, mute, disconnect or stop-sound.
        if (!enabled || epoch !== generation || performance.now() - started > 1500 || active.size >= 32) return;
        const source = context.createBufferSource();
        const level = context.createGain();
        source.buffer = decoded;
        source.playbackRate.value = Math.max(0.01, Math.min(4, event.pitch * (sample.pitch ?? 1)));
        level.gain.value = volume;
        source.connect(level).connect(master);
        const voice = { source, name: event.name, category: event.category };
        active.add(voice);
        source.onended = () => { active.delete(voice); source.disconnect(); level.disconnect(); };
        source.start();
        status.textContent = `播放: ${event.name}`;
      } catch (error) { status.textContent = error.message; }
    });
    socket.on('game_sound_stop', stop);
    socket.on('disconnect', () => stop());
  }
  if (typeof module === 'object' && module.exports) module.exports = { choose, gain };
  else root.GameAudio = { attach };
})(typeof window === 'undefined' ? globalThis : window);
