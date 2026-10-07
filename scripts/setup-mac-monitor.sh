#!/usr/bin/env bash
# The worker bootstrap supplies an existing, authorized Newsletter checkout.
set -euo pipefail
MONITOR_SETUP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$MONITOR_SETUP_ROOT/scripts/setup-mac-monitor.mjs" "$@"
