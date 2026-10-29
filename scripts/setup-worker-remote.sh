#!/bin/bash
# Run once as the logged-in MacWorker user after granting macOS Remote Login.
set -euo pipefail
if [ "$(uname -s)" != Darwin ] || [ "$(id -u)" -eq 0 ]; then
  echo 'Auf dem Mac als angemeldeter Worker-Benutzer ausführen, nicht mit sudo.' >&2
  exit 1
fi

# Resolve the production installation from launchd, before falling back to paths.
worker_root="${MAX_MONITOR_WORKER_ROOT:-}"
node_bin="$(command -v node || true)"
plist="$HOME/Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist"
if [ -f "$plist" ]; then
  if [ -z "$worker_root" ]; then
    worker_root="$(/usr/bin/python3 - "$plist" <<'PY'
import plistlib,sys,pathlib
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
print(next((str(pathlib.Path(a).parent.parent) for a in p.get('ProgramArguments',[]) if a.endswith('/src/cli.js')),''))
PY
)"
  fi
  if [ -z "$node_bin" ]; then
    node_bin="$(/usr/bin/python3 - "$plist" <<'PY'
import plistlib,sys,pathlib
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
print(next((a for a in p.get('ProgramArguments',[]) if pathlib.Path(a).name=='node'),''))
PY
)"
  fi
fi
if [ -z "$worker_root" ]; then
  for candidate in "$HOME/.local/share/ai-newsletter-production" "$HOME/Documents/AI Newsletter Creation"; do
    if [ -f "$candidate/config/worker.local.json" ]; then worker_root="$candidate"; break; fi
  done
fi
if [ -z "$worker_root" ] || [ -z "$node_bin" ]; then
  echo 'Aktiver Newsletter-Worker oder Node fehlt. MAX_MONITOR_WORKER_ROOT angeben.' >&2
  exit 1
fi

# Only non-secret, validated SSH paths are returned; credentials never enter argv.
mapfile_data="$("$node_bin" - "$worker_root" <<'JS'
const path=require('node:path'),os=require('node:os');
const root=process.argv[2];
const {loadConfig}=require(path.join(root,'src/config.js'));
const c=loadConfig(path.join(root,'config/worker.local.json'),{root});
if(!/^[A-Za-z0-9_.@:-]+$/.test(c.hub.ssh_host))throw Error('Ungültiger Hub');
for(const v of [c.hub.ssh_host,c.hub.identity_file,c.hub.known_hosts_file]){
 if(typeof v!=='string'||/[\r\n\x00]/.test(v))throw Error('Ungültige SSH-Konfiguration');
 console.log(v.startsWith('~/')?path.join(os.homedir(),v.slice(2)):v);
}
JS
)"
hub_host="$(printf '%s\n' "$mapfile_data" | sed -n '1p')"
identity="$(printf '%s\n' "$mapfile_data" | sed -n '2p')"
known_hosts="$(printf '%s\n' "$mapfile_data" | sed -n '3p')"

tool_parent="$HOME/.local/share/max-monitor-remote"
mkdir -p "$tool_parent"
chmod 700 "$tool_parent"
stage="$(mktemp -d "$tool_parent/tool.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
/usr/bin/ssh -i "$identity" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\"$known_hosts\"" -o ConnectTimeout=10 \
  "$hub_host" 'tar -C /opt/max-monitor -cf - scripts/worker-remote.mjs scripts/worker-remote-hub.mjs scripts/setup-mac-monitor.mjs scripts/worker-wallpaper.mjs scripts/check-worker-control.mjs scripts/enroll-monitor-worker.mjs team-server/enrollment.js team-server/worker-control.js team-server/claude-account-control.js team-server/worker-kinds.js team-server/worker-identities.json' \
  | /usr/bin/tar -xf - -C "$stage"
"$node_bin" "$stage/scripts/worker-remote.mjs" install --worker-root "$worker_root"
if [ -e "$tool_parent/tool.previous" ]; then rm -rf "$tool_parent/tool.previous"; fi
if [ -e "$tool_parent/tool" ]; then mv "$tool_parent/tool" "$tool_parent/tool.previous"; fi
mv "$stage" "$tool_parent/tool"
trap - EXIT
echo 'Wartungstunnel installiert. Erst nach erfolgreichem check vom Wartungs-Mac ist der Fernzugriff bestätigt.'
