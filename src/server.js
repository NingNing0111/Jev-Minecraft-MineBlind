/**
 * server.js — Express + Socket.io 监控服务
 * Port 3000: Web HUD 大屏
 * Port 3001: Prismarine-Viewer 3D 视角
 */

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

let io = null;
let httpServer = null;
let detachGameAudio = null;

/**
 * 启动监控服务器
 * @param {import('mineflayer').Bot} bot
 * @returns {import('socket.io').Server}
 */
function startServer(bot) {
  const app = express();
  httpServer = createServer(app);
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  require('./sound-assets').createSoundAssets().routes(app);
  detachGameAudio = require('./game-audio').attachGameAudio(bot, io);

  require('./item-assets').installItemAssets(app);

  // 静态文件服务
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // API: 获取当前状态（REST 备用）
  app.get('/api/status', (_req, res) => {
    res.json(latestBroadcast || {});
  });

  app.get('/api/decisions/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const record = bot.decisionHistory?.get(req.params.id);
    if (!record) return res.status(404).json({ error: '记录已过期或来自旧会话；仅保留最近 50 条详情。' });
    res.json(record);
  });

  // Socket.io 连接
  io.on('connection', (socket) => {
    console.log(`[Server] 前端连接: ${socket.id}`);

    // 发送最新状态给新连接的客户端
    if (latestBroadcast) {
      socket.emit('state_update', latestBroadcast);
    }

    // 前端控制命令
    socket.on('control', (cmd) => {
      console.log(`[Server] 控制命令: ${JSON.stringify(cmd)}`);
      handleControlCommand(bot, cmd, socket);
    });

    socket.on('disconnect', () => {
      console.log(`[Server] 前端断开: ${socket.id}`);
    });
  });

  const WEB_PORT = parseInt(process.env.WEB_PORT || '3010');
  const VIEWER_PORT = parseInt(process.env.VIEWER_PORT || '3011');

  httpServer.listen(WEB_PORT, () => {
    console.log(`[Server] Web HUD 监控大屏: http://localhost:${WEB_PORT}`);
  });

  // 启动 Prismarine-Viewer
  try {
    require('./viewer-live').installViewerLive();
    require('./viewer-smoothing').installViewerSmoothing();
    require('./viewer-hand').installViewerHand();
    require('./viewer-entities').installViewerEntities();
    require('./viewer-performance').installViewerPerformance();
    const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true });
    console.log(`[Server] 3D 视角 Prismarine-Viewer: http://localhost:${VIEWER_PORT}`);
  } catch (e) {
    console.warn('[Server] Prismarine-Viewer 不可用:', e.message);
  }

  return io;
}

let latestBroadcast = null;

/**
 * 广播状态到所有前端
 */
function broadcast(eventName, data) {
  if (!io) return;
  if (eventName === 'state_update') {
    latestBroadcast = data;
  }
  io.emit(eventName, data);
}

/**
 * 处理前端控制命令
 */
function handleControlCommand(bot, cmd, socket) {
  switch (cmd.type) {
    case 'pause_ai':
      process.emit('ai_pause');
      socket.emit('control_ack', { type: 'pause_ai', ok: true });
      break;
    case 'resume_ai':
      process.emit('ai_resume');
      socket.emit('control_ack', { type: 'resume_ai', ok: true });
      break;
    case 'force_intent':
      if (cmd.intent) {
        process.emit('ai_force_intent', cmd.intent);
        socket.emit('control_ack', { type: 'force_intent', intent: cmd.intent, ok: true });
      }
      break;
    case 'chat':
      if (cmd.message) {
        bot.chat(cmd.message);
        socket.emit('control_ack', { type: 'chat', ok: true });
      }
      break;
    default:
      socket.emit('control_ack', { type: cmd.type, ok: false, error: '未知命令' });
  }
}

async function stopServer(bot) {
  detachGameAudio?.();
  detachGameAudio = null;
  bot?.viewer?.close?.();
  if (io) { await new Promise(resolve => io.close(resolve)); io = null; }
  if (httpServer?.listening) await new Promise(resolve => httpServer.close(resolve));
  httpServer = null;
}

module.exports = { startServer, broadcast, stopServer };
