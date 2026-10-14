#!/usr/bin/env bash
set -euo pipefail
monitor_hub_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
monitor_hub_node="${MAX_MONITOR_HUB_NODE:-$(command -v node || true)}"
if [[ -z "$monitor_hub_node" ]]; then
  echo 'Node.js >= 20 wird für die Hub-Einrichtung benötigt.' >&2
  exit 1
fi
"$monitor_hub_node" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo 'Node.js >= 20 wird für die Hub-Einrichtung benötigt.' >&2
  exit 1
}
exec "$monitor_hub_node" "$monitor_hub_dir/install-monitor-hub.mjs" "$@"
