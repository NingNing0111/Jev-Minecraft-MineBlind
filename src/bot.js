const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { startServer, broadcast, stopServer } = require('./server');
const { Runtime } = require('./bot/runtime');
const { config } = require('./experiment/config');

function createBot(options = {}) {
  const settings = config();
  const bot = mineflayer.createBot({
    host: options.host || process.env.MC_HOST || 'localhost',
    port: options.port || Number(process.env.MC_PORT || 25565),
    username: options.username || process.env.MC_USERNAME || 'MineBlind',
    version: options.version || process.env.MC_VERSION || '1.20.1',
    auth: options.auth || process.env.MC_AUTH || 'offline',
  });
  bot.loadPlugin(pathfinder);
  let runtime;
  bot.once('spawn', () => {
    try {
      const movement = new Movements(bot);
      movement.allowSprinting = true; movement.canDig = false;
      bot.pathfinder.setMovements(movement);
      runtime = new Runtime(bot, settings, broadcast);
      bot.runtime = runtime;
      startServer(bot); runtime.start();
      console.log(`[Bot] MineBlind mode ${settings.mode}; Mastra ${settings.agent ? settings.model : 'disabled'}`);
    } catch (error) {
      console.error('[Bot] 初始化失败:', error.message); bot.quit('Initialization failed');
    }
  });
  const pause = () => { runtime?.pause(); broadcast('ai_status', { paused: true }); };
  const resume = () => { runtime?.resume(); broadcast('ai_status', { paused: false }); };
  const force = intent => {
    // Old HUD combat controls are intentionally restricted to safe arbiter-mediated commands.
    const mapping = { Retreat_Sprint: 'FLEE', Navigate_Away: 'FLEE', Eat_Food: 'EAT', Bucket_Water: 'WATER' };
    if (intent === 'Idle') return pause();
    if (mapping[intent]) runtime?.arbiter.submit(mapping[intent], {}, 1);
  };
  process.on('ai_pause', pause); process.on('ai_resume', resume); process.on('ai_force_intent', force);
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (message === '!pause') pause();
    if (message === '!resume') resume();
    if (message === '!save') runtime?.save('manual');
    if (message.startsWith('!intent ')) force(message.slice(8).trim());
  });
  bot.on('error', error => console.error('[Bot]', error.message));
  bot.on('kicked', reason => broadcast('bot_event', { type: 'kicked', reason }));
  bot.once('end', async () => {
    process.removeListener('ai_pause', pause); process.removeListener('ai_resume', resume); process.removeListener('ai_force_intent', force);
    await runtime?.stop(); await stopServer(bot);
  });
  bot.shutdown = async () => { await runtime?.stop(); await stopServer(bot); bot.quit('MineBlind shutting down'); };
  return bot;
}
module.exports = { createBot };
