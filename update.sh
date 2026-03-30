#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/Documents/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"

echo "=== Claw Monitor v2 Updater ==="

if [ ! -d "$INSTALL_DIR" ]; then
  echo "[ERROR] Installation not found at ${INSTALL_DIR}. Run install.sh first."
  exit 1
fi

# 1. stop existing monitor
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[INFO] Stopping monitor (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    # also kill child node processes
    pkill -P "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# 2. update source files (preserve data/)
echo "[INFO] Updating source files..."
rsync -a \
  --exclude='data/' \
  --exclude='node_modules/' \
  --exclude='.git/' \
  "$SCRIPT_DIR/" "$INSTALL_DIR/"

echo "[OK] Source files updated."

# 3. restart via install.sh
echo "[INFO] Restarting monitor..."
cd "$INSTALL_DIR"
bash install.sh
