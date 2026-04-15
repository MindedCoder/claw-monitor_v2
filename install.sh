#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/.bfe/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
CONFIG_FILE="${INSTALL_DIR}/data/config.json"
OPENCLAW_CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

configure_feishu_status() {
  local mode="$1"
  local default_enable="$2"
  local enable_choice=""
  local active_minutes="240"
  local refresh_ms="5000"
  local currently_enabled="false"

  if [ -f "$CONFIG_FILE" ]; then
    local existing_values
    existing_values=$(CONFIG_FILE="$CONFIG_FILE" node <<'NODE'
const fs = require('fs');
const path = process.env.CONFIG_FILE;
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
const f = cfg.feishuStatus || {};
const enabled = cfg.feishuStatus && f.enabled !== false ? 'true' : 'false';
console.log([
  enabled,
  String(f.activeMinutes || 240),
  String(f.refreshIntervalMs || 5000),
].join('\n'));
NODE
)
    if [ -n "$existing_values" ]; then
      local old_ifs="$IFS"
      local lines=()
      IFS=$'\n' read -r -d '' -a lines < <(printf '%s\0' "$existing_values")
      IFS="$old_ifs"
      currently_enabled="${lines[0]:-false}"
      active_minutes="${lines[1]:-240}"
      refresh_ms="${lines[2]:-5000}"
    fi
  fi

  echo ""
  if [ "$mode" = "existing" ] && [ "$currently_enabled" = "true" ]; then
    read -rp "飞书聊天状态监控当前已启用，是否保持启用? [Y/n]: " enable_choice
    [ -z "$enable_choice" ] && enable_choice="y"
  else
    read -rp "是否启用飞书聊天状态监控? [y/N]: " enable_choice
  fi

  if [[ ! "$enable_choice" =~ ^[Yy]$ ]]; then
    export CONFIG_FILE
    node <<'NODE'
const fs = require('fs');
const path = process.env.CONFIG_FILE;
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.feishuStatus = { enabled: false };
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('[INFO] Feishu status monitor disabled');
NODE
    return
  fi

  echo "[INFO] 默认通过本机 openclaw 会话存储读取数据，无需填写 Gateway WS/Token"
  echo "[INFO] 直接回车即可使用默认值"
  read -rp "活跃窗口分钟数 [${active_minutes}]: " active_minutes_input
  active_minutes="${active_minutes_input:-$active_minutes}"
  read -rp "刷新间隔毫秒 [${refresh_ms}]: " refresh_ms_input
  refresh_ms="${refresh_ms_input:-$refresh_ms}"

  export CONFIG_FILE FEISHU_ACTIVE_MINUTES="$active_minutes" FEISHU_REFRESH_MS="$refresh_ms"
  node <<'NODE'
const fs = require('fs');
const path = process.env.CONFIG_FILE;
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.feishuStatus = {
  enabled: true,
  activeMinutes: Number(process.env.FEISHU_ACTIVE_MINUTES || '240') || 240,
  limit: 200,
  refreshIntervalMs: Number(process.env.FEISHU_REFRESH_MS || '5000') || 5000,
  staleMs: 180000,
  idleMs: 1800000,
  onlyFeishu: true,
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('[OK] feishuStatus config written to', path);
NODE
}

echo "=== Claw Monitor v2 Installer ==="
echo ""

# 1. check node
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null)" "${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin/node" "/usr/local/bin/node" "/opt/homebrew/bin/node"; do
  if [ -x "$candidate" ] 2>/dev/null; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[ERROR] Node.js >= 18 not found. Please install Node.js first."
  exit 1
fi

NODE_VER=$("$NODE_BIN" -e "console.log(process.version)")
echo "[OK] Node.js found: $NODE_BIN ($NODE_VER)"

# 2. stop existing processes first (before symlink setup, to prevent KeepAlive from recreating dirs)
if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST_FILE" ]; then
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
fi
# stop keepalive / node processes
if [ -f "${INSTALL_DIR}/data/monitor.pid" ] 2>/dev/null; then
  OLD_PID=$(cat "${INSTALL_DIR}/data/monitor.pid" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[INFO] Stopping existing monitor (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    pkill -P "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi
for stale_pid in $(pgrep -f "node.*claw-monitor_v2/src/index" 2>/dev/null || true); do
  echo "[INFO] Killing stale node process $stale_pid..."
  kill -9 "$stale_pid" 2>/dev/null || true
done

# 3. if not running from install dir, create symlink
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -L "$INSTALL_DIR" ]; then
    EXISTING_TARGET="$(readlink "$INSTALL_DIR")"
    if [ "$EXISTING_TARGET" != "$SCRIPT_DIR" ]; then
      echo "[INFO] Updating symlink ${INSTALL_DIR} -> ${SCRIPT_DIR}"
      rm "$INSTALL_DIR"
      ln -s "$SCRIPT_DIR" "$INSTALL_DIR"
    else
      echo "[OK] Symlink already correct: ${INSTALL_DIR} -> ${SCRIPT_DIR}"
    fi
  elif [ -d "$INSTALL_DIR" ]; then
    echo "[WARN] ${INSTALL_DIR} exists as a real directory, replacing with symlink..."
    # preserve data dir if it has user config
    if [ -d "${INSTALL_DIR}/data" ]; then
      echo "[INFO] Backing up existing data dir to ${SCRIPT_DIR}/data"
      cp -rn "${INSTALL_DIR}/data/" "${SCRIPT_DIR}/data/" 2>/dev/null || true
    fi
    rm -rf "$INSTALL_DIR"
    ln -s "$SCRIPT_DIR" "$INSTALL_DIR"
    echo "[OK] Replaced with symlink: ${INSTALL_DIR} -> ${SCRIPT_DIR}"
  else
    echo "[INFO] Creating symlink: ${INSTALL_DIR} -> ${SCRIPT_DIR}"
    ln -s "$SCRIPT_DIR" "$INSTALL_DIR"
  fi
fi

# 3. install filedeck dependencies
if [ -f "${INSTALL_DIR}/services/filedeck/package.json" ]; then
  echo "[INFO] Installing filedeck dependencies..."
  (cd "${INSTALL_DIR}/services/filedeck" && "$NODE_BIN" "$(dirname "$NODE_BIN")/npm" install --production 2>&1) || {
    # fallback: try npm from PATH
    (cd "${INSTALL_DIR}/services/filedeck" && npm install --production 2>&1) || echo "[WARN] filedeck npm install failed, filedeck may not work"
  }
  echo "[OK] filedeck dependencies installed"
fi

# 4. create data dir & config
mkdir -p "${INSTALL_DIR}/data/static"
IS_NEW_CONFIG="false"

# ========== interactive config ==========
if [ ! -f "$CONFIG_FILE" ]; then
  IS_NEW_CONFIG="true"
  echo ""
  echo "--- 首次安装，请配置以下参数 ---"
  echo "(直接回车使用 [默认值])"
  echo ""

  # instance name
  read -p "实例名称 [default]: " INPUT_INSTANCE
  INPUT_INSTANCE="${INPUT_INSTANCE:-default}"

  # monitor port
  read -p "监控面板端口 [9001]: " INPUT_PORT
  INPUT_PORT="${INPUT_PORT:-9001}"

  # generate config.json
  cat > "$CONFIG_FILE" << CONF
{
  "port": ${INPUT_PORT},
  "instanceName": "${INPUT_INSTANCE}",
  "basePath": "",

  "health": {
    "enabled": true,
    "url": "http://127.0.0.1:18789/health",
    "intervalMs": 5000,
    "timeoutMs": 5000,
    "failThreshold": 3
  },

  "ping": {
    "enabled": true,
    "targets": [
      { "name": "Google", "url": "https://www.google.com" },
      { "name": "Baidu", "url": "https://www.baidu.com" }
    ],
    "timeoutMs": 10000
  },

  "codexUsage": {
    "enabled": true,
    "intervalMs": 300000,
    "authProfilesPath": "~/.openclaw/agents/main/agent/auth-profiles.json"
  },

  "logs": {
    "maxEntries": 500,
    "sources": [
      { "name": "gateway", "path": "~/.openclaw/logs/gateway.log" },
      { "name": "errors", "path": "~/.openclaw/logs/gateway.err.log" }
    ]
  },

  "deploy": {
    "staticDir": "./data/static"
  },

  "frpc": {
    "version": "0.61.1",
    "serverAddr": "8.135.54.217",
    "serverPort": 7000,
    "loginFailExit": false,
    "transport": {
      "heartbeatInterval": 10,
      "heartbeatTimeout": 30,
      "protocol": "tcp"
    },
    "proxies": [
      {
        "name": "monitor-v2-${INPUT_INSTANCE}",
        "type": "http",
        "localIP": "127.0.0.1",
        "localPort": ${INPUT_PORT},
        "customDomains": ["claw.bfelab.com"],
        "locations": ["/${INPUT_INSTANCE}"]
      }
    ]
  }

}
CONF

  echo ""
  echo "[OK] Config generated at ${CONFIG_FILE}"
else
  echo "[OK] Config already exists, skipping interactive setup."
  echo "     To reconfigure, delete data/config.json and re-run install.sh"
fi

configure_feishu_status "$([ "$IS_NEW_CONFIG" = "true" ] && echo new || echo existing)" "false"

# 4. download frpc
echo "[INFO] Checking frpc..."
if command -v frpc >/dev/null 2>&1 || [ -x "${HOME}/bin/frpc" ]; then
  echo "[OK] frpc already installed."
else
  echo "[INFO] Downloading frpc..."
  FRPC_VER="0.61.1"
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "[ERROR] Unsupported arch: $ARCH"; exit 1 ;;
  esac

  TARNAME="frp_${FRPC_VER}_${OS}_${ARCH}"
  URL="https://github.com/fatedier/frp/releases/download/v${FRPC_VER}/${TARNAME}.tar.gz"
  TMPDIR=$(mktemp -d)

  if curl -fsSL "$URL" -o "${TMPDIR}/${TARNAME}.tar.gz"; then
    tar xzf "${TMPDIR}/${TARNAME}.tar.gz" -C "$TMPDIR"
    mkdir -p "${HOME}/bin"
    cp "${TMPDIR}/${TARNAME}/frpc" "${HOME}/bin/frpc"
    chmod +x "${HOME}/bin/frpc"
    rm -rf "$TMPDIR"
    echo "[OK] frpc installed to ~/bin/frpc"
  else
    echo "[WARN] frpc download failed. You can install it manually later."
  fi
fi

# 5. wait for port to be released
PORT_CFG=$(grep -o '"port":[[:space:]]*[0-9]*' "$CONFIG_FILE" 2>/dev/null | head -1 | grep -o '[0-9]*' || echo "9001")
for i in 1 2 3 4 5; do
  PORT_PID=$(lsof -ti ":${PORT_CFG}" 2>/dev/null || true)
  if [ -n "$PORT_PID" ]; then
    echo "[INFO] Port ${PORT_CFG} occupied by PID ${PORT_PID}, killing..."
    echo "$PORT_PID" | xargs kill -9 2>/dev/null || true
    sleep 1
  else
    break
  fi
done

# 6. write startup wrapper script
STARTUP_SCRIPT="${INSTALL_DIR}/data/startup.sh"
cat > "$STARTUP_SCRIPT" << WRAPPER
#!/usr/bin/env bash
cd "${INSTALL_DIR}"
exec "${NODE_BIN}" src/index.js >> data/monitor.log 2>&1
WRAPPER
chmod +x "$STARTUP_SCRIPT"

# 7. start monitor
echo "[INFO] Starting monitor..."
cd "$INSTALL_DIR"

if [ "$(uname -s)" = "Darwin" ]; then
  echo "[INFO] Setting up macOS auto-start (LaunchAgent)..."

  if [ -f "$PLIST_FILE" ]; then
    launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  fi

  mkdir -p "${HOME}/Library/LaunchAgents"
  cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/src/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/data/monitor.log</string>

  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/data/monitor.err.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:${HOME}/bin:$(dirname "${NODE_BIN}"):/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
  echo "[OK] LaunchAgent installed: auto-start on login enabled"
  rm -f "$PID_FILE"
else
  nohup bash "$STARTUP_SCRIPT" > /dev/null 2>&1 &
  MONITOR_PID=$!
  echo "$MONITOR_PID" > "$PID_FILE"
  echo "[OK] Monitor started (PID: $MONITOR_PID)"
fi

# 9. verify
sleep 2
if [ "$(uname -s)" = "Darwin" ] || { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null || true)" 2>/dev/null; }; then
  PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "$CONFIG_FILE" | head -1 | grep -o '[0-9]*')
  PORT=${PORT:-9001}
  echo ""
  echo "=== Installation Complete ==="
  echo "  Dashboard:   http://127.0.0.1:${PORT}"
  echo "  Config:      ${CONFIG_FILE}"
  echo "  Logs:        ${INSTALL_DIR}/data/monitor.log"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  Auto-start:  LaunchAgent (single instance)"
  else
    echo "  Auto-start:  nohup startup.sh"
  fi
  echo ""
  echo "  To reconfigure: rm ${CONFIG_FILE} && bash install.sh"
else
  echo "[ERROR] Monitor failed to start. Check data/monitor.log for details."
  exit 1
fi
