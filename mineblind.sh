#!/usr/bin/env bash
# ============================================================
# MineBlind 管理脚本
# 用法:
#   ./mineblind.sh start    — 启动全部服务
#   ./mineblind.sh stop     — 停止全部服务
#   ./mineblind.sh restart  — 重启全部服务
#   ./mineblind.sh status   — 查看当前状态
#   ./mineblind.sh logs     — 实时跟踪 Bot 日志
# ============================================================

set -euo pipefail

# ── 路径配置 ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MC_DIR="/root/mc-server"
BOT_DIR="$SCRIPT_DIR"
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/.logs"

BOT_PID_FILE="$PID_DIR/bot.pid"
CF_HUD_PID_FILE="$PID_DIR/cf_hud.pid"
CF_VIEW_PID_FILE="$PID_DIR/cf_view.pid"
MC_SCREEN="mcserver"

BOT_LOG="$LOG_DIR/bot.log"
CF_HUD_LOG="$LOG_DIR/cf_hud.log"
CF_VIEW_LOG="$LOG_DIR/cf_view.log"

# ── 端口配置 ──────────────────────────────────────────────
WEB_PORT=3010
VIEWER_PORT=3011
MC_PORT=25565

# ── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}[$(date '+%H:%M:%S')] ✅${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] ⚠️${NC}  $*"; }
err()  { echo -e "${RED}[$(date '+%H:%M:%S')] ❌${NC} $*"; }

# ── 工具函数 ──────────────────────────────────────────────
is_alive() { kill -0 "$1" 2>/dev/null; }

save_pid() {
  local file="$1" pid="$2"
  mkdir -p "$PID_DIR"
  echo "$pid" > "$file"
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] && cat "$file" || echo ""
}

port_listening() { ss -tlnp 2>/dev/null | grep -q ":$1 "; }

wait_for_port() {
  local port="$1" label="$2" timeout="${3:-60}"
  local elapsed=0
  printf "${CYAN}[$(date '+%H:%M:%S')]${NC} 等待 $label 端口 $port"
  while ! port_listening "$port"; do
    sleep 1; elapsed=$((elapsed+1))
    printf "."
    if [[ $elapsed -ge $timeout ]]; then
      echo ""
      err "$label 启动超时 (${timeout}s)"
      return 1
    fi
  done
  echo ""
  ok "$label 就绪 (port $port, ${elapsed}s)"
}

extract_cf_url() {
  local log_file="$1"
  local elapsed=0
  while [[ $elapsed -lt 20 ]]; do
    local url
    url=$(grep -o 'https://[^ ]*\.trycloudflare\.com' "$log_file" 2>/dev/null | head -1)
    if [[ -n "$url" ]]; then echo "$url"; return 0; fi
    sleep 1; elapsed=$((elapsed+1))
  done
  echo ""
}

# ── STOP ──────────────────────────────────────────────────
do_stop() {
  echo -e "\n${BOLD}⏹  停止 MineBlind 所有服务...${NC}\n"

  # 停 Bot
  local bot_pid; bot_pid=$(read_pid "$BOT_PID_FILE")
  if [[ -n "$bot_pid" ]] && is_alive "$bot_pid"; then
    kill "$bot_pid" 2>/dev/null
    ok "Bot 已停止 (pid $bot_pid)"
  else
    # 兜底：按名字杀
    pkill -f "WEB_PORT=$WEB_PORT.*node index.js" 2>/dev/null && ok "Bot 已停止（按名字）" || warn "Bot 未运行"
  fi
  rm -f "$BOT_PID_FILE"

  # 停 Cloudflared HUD
  local cf_hud_pid; cf_hud_pid=$(read_pid "$CF_HUD_PID_FILE")
  if [[ -n "$cf_hud_pid" ]] && is_alive "$cf_hud_pid"; then
    kill "$cf_hud_pid" 2>/dev/null
    ok "Cloudflared HUD 已停止 (pid $cf_hud_pid)"
  fi
  rm -f "$CF_HUD_PID_FILE"

  # 停 Cloudflared Viewer
  local cf_view_pid; cf_view_pid=$(read_pid "$CF_VIEW_PID_FILE")
  if [[ -n "$cf_view_pid" ]] && is_alive "$cf_view_pid"; then
    kill "$cf_view_pid" 2>/dev/null
    ok "Cloudflared Viewer 已停止 (pid $cf_view_pid)"
  fi
  rm -f "$CF_VIEW_PID_FILE"

  # 停 MC Server screen session
  if screen -list 2>/dev/null | grep -q "$MC_SCREEN"; then
    screen -S "$MC_SCREEN" -X quit 2>/dev/null
    ok "Minecraft Server 已停止 (screen: $MC_SCREEN)"
  fi
  # 兜底：杀 java server.jar 进程
  if pgrep -f "server.jar" > /dev/null 2>&1; then
    pkill -f "server.jar" 2>/dev/null
    sleep 2
    pkill -9 -f "server.jar" 2>/dev/null || true
    ok "Minecraft Server 已强制停止"
  fi

  # 清理相关 cloudflared（防止孤儿进程）
  # 只杀指向 3010/3011 的，不误杀其他项目
  pkill -f "cloudflared.*localhost:$WEB_PORT" 2>/dev/null || true
  pkill -f "cloudflared.*localhost:$VIEWER_PORT" 2>/dev/null || true

  sleep 1

  # 验证端口已释放
  local all_clear=true
  for port in $WEB_PORT $VIEWER_PORT $MC_PORT; do
    if port_listening "$port"; then
      warn "端口 $port 仍被占用"
      all_clear=false
    fi
  done
  $all_clear && ok "所有端口已释放"

  echo ""
}

# ── START ─────────────────────────────────────────────────
do_start() {
  echo -e "\n${BOLD}▶️  启动 MineBlind 全部服务...${NC}\n"

  mkdir -p "$PID_DIR" "$LOG_DIR"

  # ── 1. 启动 Minecraft Server ──────────────────────────
  log "正在启动 Minecraft 1.20.1 服务器..."

  if port_listening "$MC_PORT"; then
    warn "Minecraft Server 已在运行 (port $MC_PORT)"
  else
    if [[ ! -f "$MC_DIR/server.jar" ]]; then
      err "找不到 $MC_DIR/server.jar，请先下载服务端"
      exit 1
    fi
    # 确保 eula 已同意
    echo "eula=true" > "$MC_DIR/eula.txt"

    # 用 screen 启动（支持后续发指令）
    screen -dmS "$MC_SCREEN" bash -c "cd '$MC_DIR' && java -Xmx1G -Xms512M -jar server.jar nogui"

    # 等待 MC 服务器就绪
    wait_for_port "$MC_PORT" "Minecraft Server" 120
  fi

  # ── 2. 启动 MineBlind Bot ─────────────────────────────
  log "正在启动 MineBlind Bot..."

  if [[ -f "$BOT_PID_FILE" ]] && is_alive "$(read_pid "$BOT_PID_FILE")"; then
    warn "Bot 已在运行 (pid $(read_pid "$BOT_PID_FILE"))"
  else
    cd "$BOT_DIR"
    WEB_PORT=$WEB_PORT VIEWER_PORT=$VIEWER_PORT node index.js >> "$BOT_LOG" 2>&1 &
    local bot_pid=$!
    disown "$bot_pid"
    save_pid "$BOT_PID_FILE" "$bot_pid"

    wait_for_port "$WEB_PORT" "Web HUD" 30
    wait_for_port "$VIEWER_PORT" "Prismarine Viewer" 30
  fi

  # ── 3. 启动 Cloudflare 隧道 ───────────────────────────
  log "正在建立 Cloudflare 隧道..."

  # HUD 隧道
  cloudflared tunnel --url "http://localhost:$WEB_PORT" --no-autoupdate \
    > "$CF_HUD_LOG" 2>&1 &
  local cf_hud_pid=$!
  disown "$cf_hud_pid"
  save_pid "$CF_HUD_PID_FILE" "$cf_hud_pid"

  # Viewer 隧道
  cloudflared tunnel --url "http://localhost:$VIEWER_PORT" --no-autoupdate \
    > "$CF_VIEW_LOG" 2>&1 &
  local cf_view_pid=$!
  disown "$cf_view_pid"
  save_pid "$CF_VIEW_PID_FILE" "$cf_view_pid"

  # 等待 URL 出现
  log "等待 Cloudflare 分配公网 URL..."
  local hud_url view_url
  hud_url=$(extract_cf_url "$CF_HUD_LOG")
  view_url=$(extract_cf_url "$CF_VIEW_LOG")

  # 把 Viewer URL 写入 HUD 的 iframe
  if [[ -n "$view_url" ]]; then
    sed -i "s|src=\"[^\"]*3011[^\"]*\"|src=\"$view_url\"|g" "$BOT_DIR/public/index.html"
    sed -i "s|localhost:3011|${view_url#https://}|g" "$BOT_DIR/public/index.html"
  fi

  # ── 打印结果 ──────────────────────────────────────────
  echo ""
  echo -e "${BOLD}════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  MineBlind 已全部启动！${NC}"
  echo -e "${BOLD}════════════════════════════════════════${NC}"
  echo ""
  if [[ -n "$hud_url" ]]; then
    echo -e "  ${BOLD}🖥  HUD 监控大屏 (主入口):${NC}"
    echo -e "     ${CYAN}${hud_url}${NC}"
  else
    echo -e "  ${YELLOW}⚠️  HUD URL 获取超时，手动访问: http://localhost:$WEB_PORT${NC}"
  fi
  echo ""
  if [[ -n "$view_url" ]]; then
    echo -e "  ${BOLD}🎮  Bot 3D 第一人称视角:${NC}"
    echo -e "     ${CYAN}${view_url}${NC}"
  else
    echo -e "  ${YELLOW}⚠️  Viewer URL 获取超时，手动访问: http://localhost:$VIEWER_PORT${NC}"
  fi
  echo ""
  echo -e "  📄 Bot 日志:       tail -f $BOT_LOG"
  echo -e "  📺 MC Server:      screen -r $MC_SCREEN"
  echo -e "  🔧 状态检查:       $0 status"
  echo -e "${BOLD}════════════════════════════════════════${NC}"
  echo ""
}

# ── STATUS ────────────────────────────────────────────────
do_status() {
  echo -e "\n${BOLD}📊 MineBlind 服务状态${NC}\n"

  # Bot
  local bot_pid; bot_pid=$(read_pid "$BOT_PID_FILE")
  if [[ -n "$bot_pid" ]] && is_alive "$bot_pid"; then
    echo -e "  Bot (node):         ${GREEN}运行中${NC} (pid $bot_pid)"
  else
    echo -e "  Bot (node):         ${RED}已停止${NC}"
  fi

  # MC Server
  if port_listening "$MC_PORT"; then
    local mc_pid; mc_pid=$(ss -tlnp 2>/dev/null | grep ":$MC_PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    echo -e "  Minecraft Server:   ${GREEN}运行中${NC} (port $MC_PORT${mc_pid:+, pid $mc_pid})"
  else
    echo -e "  Minecraft Server:   ${RED}已停止${NC}"
  fi

  # Web HUD
  if port_listening "$WEB_PORT"; then
    echo -e "  Web HUD (3010):     ${GREEN}运行中${NC}"
  else
    echo -e "  Web HUD (3010):     ${RED}已停止${NC}"
  fi

  # Viewer
  if port_listening "$VIEWER_PORT"; then
    echo -e "  Prismarine Viewer:  ${GREEN}运行中${NC}"
  else
    echo -e "  Prismarine Viewer:  ${RED}已停止${NC}"
  fi

  # Cloudflare URLs
  local hud_url; hud_url=$(grep -o 'https://[^ ]*\.trycloudflare\.com' "$CF_HUD_LOG" 2>/dev/null | head -1)
  local view_url; view_url=$(grep -o 'https://[^ ]*\.trycloudflare\.com' "$CF_VIEW_LOG" 2>/dev/null | head -1)

  echo ""
  if [[ -n "$hud_url" ]]; then
    echo -e "  🖥  HUD:    ${CYAN}$hud_url${NC}"
  fi
  if [[ -n "$view_url" ]]; then
    echo -e "  🎮  Viewer: ${CYAN}$view_url${NC}"
  fi
  echo ""
}

# ── LOGS ──────────────────────────────────────────────────
do_logs() {
  if [[ ! -f "$BOT_LOG" ]]; then
    err "日志文件不存在: $BOT_LOG"
    exit 1
  fi
  echo -e "${CYAN}=== Bot 实时日志 (Ctrl+C 退出) ===${NC}"
  tail -f "$BOT_LOG"
}

# ── 入口 ──────────────────────────────────────────────────
case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 2; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo -e "用法: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
