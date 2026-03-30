#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="claw-monitor_v2"
INSTALL_DIR="${HOME}/Documents/${PROJECT_NAME}"
PID_FILE="${INSTALL_DIR}/data/monitor.pid"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo "=== Claw Monitor v2 Uninstaller ==="

# 1. remove LaunchAgent (stop auto-start)
if [ -f "$PLIST_FILE" ]; then
  echo "[INFO] Removing LaunchAgent (auto-start)..."
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  rm -f "$PLIST_FILE"
  echo "[OK] LaunchAgent removed."
fi

# 2. stop monitor
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[INFO] Stopping monitor (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    pkill -P "$OLD_PID" 2>/dev/null || true
  fi
fi

# kill any remaining node processes for this project
pgrep -f "node.*${PROJECT_NAME}" | while read pid; do
  echo "[INFO] Killing process $pid..."
  kill "$pid" 2>/dev/null || true
done

# 3. ask about frpc
FRPC_BIN="${HOME}/bin/frpc"
if [ -x "$FRPC_BIN" ]; then
  read -p "Remove frpc binary at ${FRPC_BIN}? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    pkill -f frpc 2>/dev/null || true
    rm -f "$FRPC_BIN"
    echo "[OK] frpc removed."
  else
    echo "[INFO] Keeping frpc."
  fi
fi

# 4. ask about data
if [ -d "${INSTALL_DIR}/data" ]; then
  read -p "Remove all data (config, logs, static files)? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "${INSTALL_DIR}/data"
    echo "[OK] Data removed."
  else
    echo "[INFO] Keeping data directory."
  fi
fi

# 5. remove project dir
if [ -d "$INSTALL_DIR" ]; then
  read -p "Remove project directory ${INSTALL_DIR}? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$INSTALL_DIR"
    echo "[OK] Project directory removed."
  else
    echo "[INFO] Keeping project directory."
  fi
fi

# 6. clean cache
CACHE_DIR="${HOME}/.cache/claw-monitor-v2"
if [ -d "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
  echo "[OK] Cache cleaned."
fi

echo ""
echo "=== Uninstall Complete ==="
