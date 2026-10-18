#!/bin/bash
# Install the shared Max Monitor maintenance client, without touching worker services.
set -euo pipefail
mm_source="$(cd "$(dirname "$0")/.." && pwd)"
mm_parent="$HOME/.local/share/max-monitor-admin"
mm_plist="$HOME/Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist"
if [ -f "$mm_plist" ]; then
  mm_node="$(/usr/bin/python3 - "$mm_plist" <<'PY'
import pathlib,plistlib,sys
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
print(next(a for a in p['ProgramArguments'] if pathlib.Path(a).name=='node'))
PY
)"
else
  # Till's approved maintenance Macs deliberately have no Newsletter LaunchAgent.
  # Reuse their installed runtime without creating or re-enabling a worker.
  mm_node="$HOME/.local/share/ai-newsletter-runtime/bin/node"
  if [ ! -x "$mm_node" ]; then mm_node="$(command -v node || true)"; fi
fi
[ -n "$mm_node" ] && [ -x "$mm_node" ] || { echo 'Node für den Wartungsclient fehlt.' >&2; exit 1; }
"$mm_node" "$mm_source/scripts/worker-admin.mjs" list >/dev/null
mkdir -p "$mm_parent" "$HOME/.local/bin"
chmod 700 "$mm_parent"
mm_stage="$(mktemp -d "$mm_parent/tool.XXXXXX")"
trap 'rm -rf "$mm_stage"' EXIT
mkdir -p "$mm_stage/scripts" "$mm_stage/team-server"
for mm_file in worker-admin.mjs worker-admin-hub.mjs worker-diagnose.py member-remote.py worker-remote.mjs worker-remote-hub.mjs setup-mac-monitor.mjs enroll-monitor-worker.mjs check-worker-control.mjs; do
  cp "$mm_source/scripts/$mm_file" "$mm_stage/scripts/"
done
for mm_file in remote-access.js worker-control.js enrollment.js; do
  cp "$mm_source/team-server/$mm_file" "$mm_stage/team-server/"
done
if [ -e "$mm_parent/tool.previous" ]; then rm -rf "$mm_parent/tool.previous"; fi
if [ -e "$mm_parent/tool" ]; then mv "$mm_parent/tool" "$mm_parent/tool.previous"; fi
mv "$mm_stage" "$mm_parent/tool"
trap - EXIT
cat > "$HOME/.local/bin/max-monitor-worker" <<'SH'
#!/bin/bash
set -euo pipefail
SH
printf 'exec %q "$HOME/.local/share/max-monitor-admin/tool/scripts/worker-admin.mjs" "$@"\n' "$mm_node" >> "$HOME/.local/bin/max-monitor-worker"
chmod 700 "$HOME/.local/bin/max-monitor-worker"
echo 'Max-Monitor-Wartung installiert: ~/.local/bin/max-monitor-worker'
