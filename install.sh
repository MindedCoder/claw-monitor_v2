#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/.bfe/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
CONFIG_FILE="${INSTALL_DIR}/data/config.json"

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

# 2. if not running from install dir, create symlink
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
    echo "[ERROR] ${INSTALL_DIR} already exists as a real directory."
    echo "        Remove it first if you want to install from ${SCRIPT_DIR}"
    exit 1
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

# ========== interactive config ==========
if [ ! -f "$CONFIG_FILE" ]; then
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

# 5. stop LaunchAgent first (prevent KeepAlive from respawning)
if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST_FILE" ]; then
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
fi

# 6. stop existing monitor
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
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

# wait for port to be released
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

# 7. start monitor with keepalive
echo "[INFO] Starting monitor..."
cd "$INSTALL_DIR"

nohup bash -c "
while true; do
  bash \"${STARTUP_SCRIPT}\"
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] [keepalive] monitor exited, restarting in 3s...\" >> data/monitor.log
  sleep 3
done
" > /dev/null 2>&1 &

KEEPALIVE_PID=$!
echo "$KEEPALIVE_PID" > "$PID_FILE"
echo "[OK] Monitor started (keepalive PID: $KEEPALIVE_PID)"

# 8. setup macOS LaunchAgent for boot auto-start
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
fi

# 9. verify
sleep 2
if kill -0 "$KEEPALIVE_PID" 2>/dev/null; then
  PORT=$(grep -o '"port":[[:space:]]*[0-9]*' "$CONFIG_FILE" | head -1 | grep -o '[0-9]*')
  PORT=${PORT:-9001}
  echo ""
  echo "=== Installation Complete ==="
  echo "  Dashboard:   http://127.0.0.1:${PORT}"
  echo "  Config:      ${CONFIG_FILE}"
  echo "  Logs:        ${INSTALL_DIR}/data/monitor.log"
  echo "  Auto-start:  LaunchAgent (survives reboot)"
  echo ""
  echo "  To reconfigure: rm ${CONFIG_FILE} && bash install.sh"
else
  echo "[ERROR] Monitor failed to start. Check data/monitor.log for details."
  exit 1
fi
