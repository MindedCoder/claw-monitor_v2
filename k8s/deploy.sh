#!/usr/bin/env bash
# Apply all k8s manifests for claw-monitor_v2 and roll all deployments in the dir.
# Files ending in .local are skipped (local-only overrides).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="bfe"
DEPLOYMENTS=("auth-gateway" "frps")

# kubectl 走代理会连不上 API server
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

echo "[deploy] applying manifests in ${SCRIPT_DIR}"
shopt -s nullglob
files=("${SCRIPT_DIR}"/*.yaml)
if [ ${#files[@]} -eq 0 ]; then
  echo "[deploy] no yaml files found"; exit 1
fi
for f in "${files[@]}"; do
  echo "  - $(basename "$f")"
  kubectl apply -f "$f"
done

for d in "${DEPLOYMENTS[@]}"; do
  echo "[deploy] rolling deployment ${NAMESPACE}/${d}"
  kubectl -n "${NAMESPACE}" rollout restart deployment/"${d}"
  kubectl -n "${NAMESPACE}" rollout status deployment/"${d}" --timeout=120s
done

echo "[deploy] done"
