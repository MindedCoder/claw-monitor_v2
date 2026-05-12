#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="claw-monitor_v2"
TARGET_DIR="${HOME}/.bfe/${PROJECT_NAME}"
PLIST_LABEL="com.claw-monitor-v2.monitor"
PLIST_FILE="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ -x "${TARGET_DIR}/uninstall.sh" ]; then
  cd "$TARGET_DIR"
  exec bash "${TARGET_DIR}/uninstall.sh" "$@"
fi

if [ -f "$PLIST_FILE" ]; then
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || true
  rm -f "$PLIST_FILE"
fi

rm -rf "$TARGET_DIR"

echo "[OK] ${PROJECT_NAME} removed."
