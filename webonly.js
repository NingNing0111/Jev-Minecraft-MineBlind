// 仅启动 Web 服务器（不连 MC）用于测试穿透
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

require('./src/item-assets').installItemAssets(app);
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log(`[Server] 前端连接: ${socket.id}`);
  // 推送 demo 数据
  const pushDemo = () => {
    socket.emit('state_update', {
      state: {
        player: { hp: 14, max_hp: 20, hunger: 18, main_hand: 'iron_sword', off_hand: 'shield', is_in_water: false, is_on_fire: false, position: { x: 120, y: 64, z: -88 } },
        environment: { distance_to_wall_front: 5, distance_to_wall_back: 12, ceiling_clearance: 10, depth_below: 0, block_below: 'grass_block', can_jump: true, time_of_day: 6000, is_raining: false },
        threat_scan: [
          { id: 1, type: 'Creeper', distance: 4.2, has_line_of_sight: true, is_ignited: false, frames_to_reach_me: 20 },
          { id: 2, type: 'Skeleton', distance: 12, has_line_of_sight: true, is_ignited: false, frames_to_reach_me: 48 }
        ],
        knowledge_injected: {}
      },
      decision: { intent: 'Hit_and_Run', reason: '对Creeper实施拉扯打法 (置信度39%)', latency: 896, source: 'jev', confidence: 0.39 },
      log: [
        { timestamp: Date.now(), intent: 'Hit_and_Run', reason: '对Creeper实施拉扯', hp: 14 },
        { timestamp: Date.now() - 200, intent: 'Strafe_Dodge', reason: '横向躲避Skeleton', hp: 14 },
        { timestamp: Date.now() - 400, intent: 'Melee_Engage', reason: '接敌跳劈', hp: 16 },
      ],
      ai_paused: false,
    });
  };
  pushDemo();
  const timer = setInterval(pushDemo, 2000);
  socket.on('disconnect', () => clearInterval(timer));
});

httpServer.listen(3000, () => {
  console.log('[Server] Web HUD 监控大屏: http://localhost:3000');
});
