'use strict';

// minecraft-protocol decodes ItemSoundHolder registry IDs to zero-based indices,
// while minecraft-data's 1.20.1 sounds table uses the one-based wire IDs.
function normalizeSound(bot, packet, entitySound = false) {
  if (bot.version !== '1.20.1') return null;
  let name, range;
  if (entitySound) {
    name = packet.soundId === 0 ? packet.soundEvent?.resource : bot.registry.sounds[packet.soundId]?.name;
    range = packet.soundEvent?.range;
  } else if (packet.sound?.data) {
    name = packet.sound.data.soundName;
    range = packet.sound.data.fixedRange;
  } else {
    name = bot.registry.sounds[(packet.sound?.soundId ?? -1) + 1]?.name;
  }
  const position = entitySound ? bot.entities[packet.entityId]?.position
    : { x: packet.x / 8, y: packet.y / 8, z: packet.z / 8 };
  const listener = bot.entity?.position;
  if (!name || !position || !listener || ![position.x, position.y, position.z, listener.x, listener.y, listener.z, packet.volume, packet.pitch].every(Number.isFinite)) return null;
  return {
    name: name.replace(/^minecraft:/, ''), category: packet.soundCategory,
    position: { x: position.x, y: position.y, z: position.z },
    listener: { x: listener.x, y: listener.y, z: listener.z },
    volume: Math.max(0, packet.volume), pitch: Math.max(0.01, packet.pitch),
    range: Number.isFinite(range) && range > 0 ? range : null,
  };
}

function attachGameAudio(bot, io) {
  const sound = packet => { const event = normalizeSound(bot, packet); if (event) io.emit('game_sound', event); };
  const entitySound = packet => { const event = normalizeSound(bot, packet, true); if (event) io.emit('game_sound', event); };
  const stop = packet => io.emit('game_sound_stop', {
    name: packet.flags & 2 ? packet.sound?.replace(/^minecraft:/, '') : null,
    category: packet.flags & 1 ? packet.source : null,
  });
  const reset = () => io.emit('game_sound_stop', {});
  bot._client.on('sound_effect', sound);
  bot._client.on('entity_sound_effect', entitySound);
  bot._client.on('stop_sound', stop);
  bot.on('respawn', reset);
  bot.on('end', reset);
  return () => {
    bot._client.removeListener('sound_effect', sound);
    bot._client.removeListener('entity_sound_effect', entitySound);
    bot._client.removeListener('stop_sound', stop);
    bot.removeListener('respawn', reset);
    bot.removeListener('end', reset);
  };
}

module.exports = { normalizeSound, attachGameAudio };
