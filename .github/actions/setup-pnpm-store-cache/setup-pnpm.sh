#!/usr/bin/env bash
set -euo pipefail
case "$CACHE_MODE" in
  off|restore|read-write) ;;
  *)
    echo "::error::Invalid cache-mode input: '$CACHE_MODE' (expected off, restore, or read-write)"
    exit 2
    ;;
esac
project_dir="$(dirname "$PACKAGE_MANAGER_FILE")"
if [[ ! -f "$PACKAGE_MANAGER_FILE" ]]; then
  echo "::error::package manager file not found: $PACKAGE_MANAGER_FILE"
  exit 1
fi
echo "project-dir=$project_dir" >> "$GITHUB_OUTPUT"

requested_node="${REQUESTED_NODE_VERSION:-${NODE_VERSION:-}}"
source "$(dirname "${BASH_SOURCE[0]}")/ensure-node.sh"
openclaw_ensure_node "$requested_node"

package_manager="$(node -e "const fs = require('node:fs'); const path = require('node:path'); const pkg = JSON.parse(fs.readFileSync(path.resolve(process.argv[1]), 'utf8')); process.stdout.write(pkg.packageManager || '')" "$PACKAGE_MANAGER_FILE")"
case "$package_manager" in
  pnpm@*) ;;
  *)
    echo "::error::Expected packageManager to pin pnpm, got '${package_manager:-<empty>}'"
    exit 1
    ;;
esac
if [ -n "${PNPM_HOME:-}" ]; then
  mkdir -p "$PNPM_HOME"
  corepack enable --install-directory "$PNPM_HOME"
  echo "PNPM_HOME=$PNPM_HOME" >> "$GITHUB_ENV"
  echo "$PNPM_HOME" >> "$GITHUB_PATH"
else
  corepack enable
fi
prepared=false
for attempt in 1 2 3; do
  if corepack prepare "$package_manager" --activate; then
    prepared=true
    break
  fi
  sleep $((attempt * 5))
done
[[ "$prepared" == "true" ]] || corepack prepare "$package_manager" --activate

if [[ "$CACHE_MODE" != "off" && "$RUNNER_OS" != "Windows" ]]; then
  store_path=""
  for attempt in 1 2 3; do
    if store_path="$(pnpm store path --silent)"; then
      break
    fi
    if [[ "$attempt" -eq 3 ]]; then
      exit 1
    fi
    sleep $((attempt * 5))
  done
  node -e "require('node:fs').mkdirSync(process.argv[1], { recursive: true })" "$store_path"
  echo "path=$store_path" >> "$GITHUB_OUTPUT"
fi

echo "pnpm-version=$(cd "$project_dir" && pnpm -v)" >> "$GITHUB_OUTPUT"
