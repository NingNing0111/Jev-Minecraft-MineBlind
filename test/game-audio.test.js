const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalizeSound, attachGameAudio } = require('../src/game-audio');
const { choose, gain } = require('../public/game-audio');
function fixture() {
  return Object.assign(new EventEmitter(), { version: '1.20.1', _client: new EventEmitter(), registry: { sounds: { 1: { name: 'entity.allay.ambient_with_item' } } }, entities: { 9: { position: { x: 1, y: 2, z: 3 } } }, entity: { position: { x: 0, y: 0, z: 0 } } });
}
test('holder IDs are decoded zero-based, entity sound IDs remain one-based', () => {
  const bot = fixture();
  const base = { volume: 1, pitch: 1, soundCategory: 'neutral', x: 8, y: 16, z: 24 };
  const sound = normalizeSound(bot, { ...base, sound: { soundId: 0 } });
  assert.equal(sound.name, 'entity.allay.ambient_with_item');
  assert.deepEqual(sound.position, { x: 1, y: 2, z: 3 });
  assert.deepEqual(normalizeSound(bot, { ...base, soundId: 1, entityId: 9 }, true), sound);
  assert.equal(normalizeSound(bot, { ...base, soundId: 1, entityId: 99 }, true), null);
  assert.equal(normalizeSound(bot, { ...base, sound: { data: { soundName: 'minecraft:test', fixedRange: 32 } } }).range, 32);
  assert.equal(normalizeSound(bot, { ...base, soundId: 0, soundEvent: { resource: 'minecraft:test', range: 20 }, entityId: 9 }, true).name, 'test');
});
test('bridge emits once, forwards stop and cleans up', () => {
  const bot = fixture(), events = [];
  const detach = attachGameAudio(bot, { emit: (...args) => events.push(args) });
  bot._client.emit('sound_effect', { sound: { soundId: 0 }, x: 0, y: 0, z: 0, volume: 1, pitch: 1 });
  bot._client.emit('stop_sound', { flags: 3, source: 6, sound: 'minecraft:test' });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], ['game_sound_stop', { category: 6, name: 'test' }]);
  detach();
  assert.equal(bot._client.listenerCount('sound_effect'), 0);
  assert.equal(bot.listenerCount('respawn'), 0);
});
test('weighted samples, event references, and cyclic references', () => {
  const events = { a: { sounds: ['one', { name: 'two', weight: 3 }] }, b: { sounds: [{ type: 'event', name: 'a', volume: 0.5 }] }, c: { sounds: [{ name: 'c', type: 'event' }] } };
  assert.equal(choose(events, 'a', () => 0).name, 'one');
  assert.equal(choose(events, 'a', () => 0.8).name, 'two');
  assert.equal(choose(events, 'b', () => 0).volume, 0.5);
  assert.equal(choose(events, 'c'), null);
  assert.equal(choose(events, 'unknown'), null);
});
test('distance attenuation, fixed range, loud sound radius', () => {
  const event = { position: { x: 8, y: 0, z: 0 }, listener: { x: 0, y: 0, z: 0 }, volume: 1 };
  assert.equal(gain(event, {}), 0.5);
  assert.equal(gain({ ...event, range: 8 }, {}), 0);
  assert.equal(gain({ ...event, volume: 2 }, {}), 0.75);
  assert.equal(gain(event, { volume: 0.5 }), 0.25);
});
