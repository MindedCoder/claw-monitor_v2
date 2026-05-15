#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="claw-monitor_v2"
TARGET_DIR="${HOME}/.bfe/${PROJECT_NAME}"
BACKUP_DIR=""

cleanup() {
  if [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
  fi
}
trap cleanup EXIT

backup_existing_data() {
  if [ -d "$TARGET_DIR/data" ]; then
    BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claw-monitor_v2-data.XXXXXX")"
    mkdir -p "$BACKUP_DIR/data"
    cp -R "$TARGET_DIR/data/." "$BACKUP_DIR/data/" 2>/dev/null || true
  fi
}

ensure_real_install_dir() {
  if [ -L "$TARGET_DIR" ]; then
    echo "[INFO] Replacing symlinked install dir with a real directory: $TARGET_DIR"
    backup_existing_data
    rm "$TARGET_DIR"
  fi
  mkdir -p "$TARGET_DIR"
}

sync_bundle_into_install_dir() {
  echo "[INFO] Syncing published bundle into ${TARGET_DIR}"
  rsync -a --delete \
    --exclude '.git' \
    --exclude '.DS_Store' \
    --exclude 'node_modules' \
    --exclude 'data' \
    "${SCRIPT_DIR}/" "${TARGET_DIR}/"

  mkdir -p "$TARGET_DIR/data"
  if [ -d "${SCRIPT_DIR}/data" ]; then
    cp -Rn "${SCRIPT_DIR}/data/." "$TARGET_DIR/data/" 2>/dev/null || true
  fi
  if [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR/data" ]; then
    cp -R "$BACKUP_DIR/data/." "$TARGET_DIR/data/" 2>/dev/null || true
  fi
}

ensure_real_install_dir
sync_bundle_into_install_dir

cd "$TARGET_DIR"
exec bash "$TARGET_DIR/install.sh"
