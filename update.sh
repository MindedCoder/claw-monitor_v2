#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/Documents/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo "=== Claw Monitor v2 Updater ==="

if [ ! -d "$INSTALL_DIR" ]; then
  echo "[ERROR] Installation not found at ${INSTALL_DIR}. Run install.sh first."
  exit 1
fi

# 1. pull latest code
echo "[INFO] Pulling latest code..."
cd "$INSTALL_DIR"
git pull

# 2. stop LaunchAgent (prevent KeepAlive respawn)
if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST_FILE" ]; then
  echo "[INFO] Stopping LaunchAgent..."
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
fi

# 3. kill all related processes
echo "[INFO] Stopping all services..."
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null || true
    pkill -P "$OLD_PID" 2>/dev/null || true
  fi
fi
for pid in $(pgrep -f "node.*${PROJECT_NAME}" 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done
for pid in $(pgrep -f "frpc.*${PROJECT_NAME}" 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 2

# 4. restart via install.sh
echo "[INFO] Restarting..."
bash install.sh
