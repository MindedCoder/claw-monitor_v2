#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/Documents/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"

echo "=== Claw Monitor v2 Updater ==="

if [ ! -d "$INSTALL_DIR" ]; then
  echo "[ERROR] Installation not found at ${INSTALL_DIR}. Run install.sh first."
  exit 1
fi

# 1. pull latest code
echo "[INFO] Pulling latest code..."
cd "$INSTALL_DIR"
git pull

# 2. stop existing monitor
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[INFO] Stopping monitor (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    pkill -P "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# 3. restart via install.sh
echo "[INFO] Restarting monitor..."
bash install.sh
