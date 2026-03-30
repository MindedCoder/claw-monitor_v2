#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/Documents/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo "=== Claw Monitor v2 Installer ==="

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

# 2. copy project files if not running from install dir
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  echo "[INFO] Copying project to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  rsync -a --exclude='data/config.json' --exclude='data/static' --exclude='data/*.log' --exclude='data/*.pid' --exclude='node_modules' "$SCRIPT_DIR/" "$INSTALL_DIR/"
else
  echo "[INFO] Already in install directory."
fi

# 3. create data dir & default config
mkdir -p "${INSTALL_DIR}/data/static"
if [ ! -f "${INSTALL_DIR}/data/config.json" ]; then
  cp "${INSTALL_DIR}/config.example.json" "${INSTALL_DIR}/data/config.json"
  echo "[OK] Created default config at data/config.json"
  echo "[IMPORTANT] Edit data/config.json to customize your settings!"
else
  echo "[OK] Config already exists, not overwriting."
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

# 5. stop existing monitor if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[INFO] Stopping existing monitor (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    pkill -P "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi
# also kill any stale processes from this project
pgrep -f "node.*claw-monitor_v2/src/index" | while read stale_pid; do
  echo "[INFO] Killing stale node process $stale_pid..."
  kill "$stale_pid" 2>/dev/null || true
done

# 6. write startup wrapper script (used by both manual start and LaunchAgent)
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

  # unload old plist if exists (safe: just remove the file, no launchctl unload)
  if [ -f "$PLIST_FILE" ]; then
    # try bootout first (modern API, no permission prompt)
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
    <string>bash</string>
    <string>${STARTUP_SCRIPT}</string>
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
    <string>/usr/local/bin:/opt/homebrew/bin:${HOME}/bin:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

  # load using modern bootstrap API (no permission prompt)
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
  echo "[OK] LaunchAgent installed: auto-start on login enabled"
  echo "     Plist: $PLIST_FILE"
  echo "     KeepAlive: enabled (launchd will restart if crashed)"
fi

# 9. verify
sleep 2
if kill -0 "$KEEPALIVE_PID" 2>/dev/null; then
  PORT=$(grep -o '"port":[[:space:]]*[0-9]*' data/config.json | head -1 | grep -o '[0-9]*')
  PORT=${PORT:-9001}
  echo ""
  echo "=== Installation Complete ==="
  echo "  Dashboard:   http://127.0.0.1:${PORT}"
  echo "  Config:      ${INSTALL_DIR}/data/config.json"
  echo "  Logs:        ${INSTALL_DIR}/data/monitor.log"
  echo "  PID file:    ${PID_FILE}"
  echo "  Auto-start:  LaunchAgent (survives reboot)"
  echo ""
  echo "Next steps:"
  echo "  1. Edit data/config.json to set instanceName, healthUrl, frpc settings, etc."
  echo "  2. Restart: bash install.sh"
else
  echo "[ERROR] Monitor failed to start. Check data/monitor.log for details."
  exit 1
fi
