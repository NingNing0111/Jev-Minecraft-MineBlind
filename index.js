/**
 * index.js — MineBlind 入口
 * 用法: node index.js
 * 环境变量:
 *   MC_HOST, MC_PORT, MC_USERNAME, MC_VERSION, MC_AUTH
 *   JEV_API_URL, JEV_API_KEY
 */

require('dotenv').config({ path: '.env' });
const { createBot } = require('./src/bot');

console.log('╔══════════════════════════════════════╗');
console.log('║        MineBlind AI Bot              ║');
console.log('║  基于 Jev (TypeSafe.ai) 决策引擎    ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log(`[Config] MC服务器: ${process.env.MC_HOST || 'localhost'}:${process.env.MC_PORT || '25565'}`);
console.log(`[Config] 玩家名: ${process.env.MC_USERNAME || 'MineBlind'}`);
console.log(`[Config] Jev API: ${process.env.JEV_API_URL || '本地规则引擎（无API Key）'}`);
console.log('');

const bot = createBot();

// 优雅退出
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[Main] 收到退出信号，正在存档并关闭...');
  await bot.shutdown();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[Main] 未捕获异常:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] 未处理的 Promise 拒绝:', reason);
});
