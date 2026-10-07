#!/bin/bash
# Installs only the read-only source bridge. It never starts a newsletter worker.
set -eu

monitor_mode=install
monitor_output_dir=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) monitor_mode=check ;;
    --uninstall) monitor_mode=uninstall ;;
    --generate-only) monitor_mode=generate ;;
    --output-dir)
      shift
      [ "$#" -gt 0 ] || { echo '--output-dir benötigt einen Pfad.' >&2; exit 1; }
      monitor_output_dir=$1 ;;
    --help)
      echo 'install-newsletter-monitor.sh [--check|--uninstall|--generate-only] [--output-dir <Testverzeichnis>]'
      echo 'Konfiguration: NEWSLETTER_WORKER_ROOT, MONITOR_RELAY_URL, MONITOR_TEAM_ID; optional MONITOR_NODE_PATH, MONITOR_WORKFLOWS_FILE, MONITOR_BRIDGE_INTERVAL_SECONDS.'
      echo 'Token: macOS-Schlüsselbund, Dienst "MaxMonitor Newsletter Bridge", Account = Team-ID.'
      exit 0 ;;
    *) echo "Unbekannter Parameter: $1" >&2; exit 1 ;;
  esac
  shift
done

case "${MONITOR_TEAM_ID:-}" in
  ''|*[!A-Z0-9]*) echo 'MONITOR_TEAM_ID fehlt oder ist ungültig (4–16 Zeichen A–Z/0–9).' >&2; exit 1 ;;
esac
[ "${#MONITOR_TEAM_ID}" -ge 4 ] && [ "${#MONITOR_TEAM_ID}" -le 16 ] || { echo 'MONITOR_TEAM_ID muss 4–16 Zeichen enthalten.' >&2; exit 1; }

monitor_label="de.max-monitor.newsletter-bridge.$MONITOR_TEAM_ID"
monitor_service_dir="$HOME/Library/Application Support/Max Monitor/Newsletter Bridge/$MONITOR_TEAM_ID"
monitor_plist="$HOME/Library/LaunchAgents/$monitor_label.plist"
monitor_uid=$(/usr/bin/id -u)

if [ "$monitor_mode" = uninstall ]; then
  /bin/launchctl bootout "gui/$monitor_uid/$monitor_label" >/dev/null 2>&1 || true
  /bin/rm -f "$monitor_plist" "$monitor_service_dir/run.sh"
  /bin/rmdir "$monitor_service_dir" >/dev/null 2>&1 || true
  echo 'Newsletter-Monitor-Dienst entfernt. Queue, Protokolle und Schlüsselbund-Eintrag bleiben erhalten.'
  exit 0
fi

[ -n "${NEWSLETTER_WORKER_ROOT:-}" ] && [ -n "${MONITOR_RELAY_URL:-}" ] || { echo 'NEWSLETTER_WORKER_ROOT und MONITOR_RELAY_URL fehlen.' >&2; exit 1; }
monitor_node=${MONITOR_NODE_PATH:-$(command -v node || true)}
[ -n "$monitor_node" ] && [ -x "$monitor_node" ] || { echo 'Node fehlt. MONITOR_NODE_PATH auf Node 20 oder neuer setzen.' >&2; exit 1; }
monitor_script_dir=$(cd "$(dirname "$0")" && pwd)
export MONITOR_INSTALL_SERVICE_DIR="$monitor_service_dir" MONITOR_INSTALL_PLIST="$monitor_plist"
export MONITOR_INSTALL_LABEL="$monitor_label" MONITOR_INSTALL_NODE="$monitor_node"
export MONITOR_INSTALL_BRIDGE="$monitor_script_dir/newsletter-monitor-bridge.mjs"
export MONITOR_INSTALL_MODE="$monitor_mode" MONITOR_INSTALL_OUTPUT_DIR="$monitor_output_dir"

if [ "$monitor_mode" != generate ]; then
  /usr/bin/security find-generic-password -s 'MaxMonitor Newsletter Bridge' -a "$MONITOR_TEAM_ID" >/dev/null 2>&1 || {
    echo 'Schlüsselbund-Eintrag fehlt: Dienst "MaxMonitor Newsletter Bridge", Account = MONITOR_TEAM_ID. In Schlüsselbundverwaltung anlegen; Token nicht ins Repo oder in die plist schreiben.' >&2
    exit 1
  }
fi

"$monitor_node" --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const env = process.env;
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20 oder neuer erforderlich.');
const { relayEndpoint, validateWorkflows } = await import(pathToFileURL(env.MONITOR_INSTALL_BRIDGE));
relayEndpoint(env.MONITOR_RELAY_URL, env.MONITOR_TEAM_ID);
const workerRoot = path.resolve(env.NEWSLETTER_WORKER_ROOT);
const require = createRequire(import.meta.url);
const { loadConfig } = require(path.join(workerRoot, 'src/config.js'));
loadConfig(path.join(workerRoot, 'config/worker.local.json'), { root: workerRoot });
if (!fs.existsSync(path.join(workerRoot, 'src/hub-transport.js'))) throw new Error('Newsletter Hub-Transport fehlt.');
if (env.MONITOR_WORKFLOWS_FILE) validateWorkflows(JSON.parse(fs.readFileSync(env.MONITOR_WORKFLOWS_FILE, 'utf8')));
const interval = Number(env.MONITOR_BRIDGE_INTERVAL_SECONDS || 60);
if (!Number.isInteger(interval) || interval < 30 || interval > 86400) throw new Error('Intervall muss 30–86400 ganze Sekunden sein.');
const nodePath = path.resolve(env.MONITOR_INSTALL_NODE);
const values = [workerRoot, nodePath, env.MONITOR_RELAY_URL, env.MONITOR_INSTALL_BRIDGE,
  env.MONITOR_WORKFLOWS_FILE, env.MONITOR_HUB_FLEET_DIRECTORY, env.MONITOR_BRIDGE_CACHE].filter(Boolean);
if (values.some(value => /[\r\n\0]/.test(value))) throw new Error('Konfiguration enthält Steuerzeichen.');
if (env.MONITOR_INSTALL_MODE === 'check') { console.log('Konfiguration und Schlüsselbund-Eintrag geprüft; keine Änderungen.'); process.exit(0); }
if (env.MONITOR_INSTALL_OUTPUT_DIR && env.MONITOR_INSTALL_MODE !== 'generate') throw new Error('--output-dir ist nur mit --generate-only erlaubt.');
const output = env.MONITOR_INSTALL_OUTPUT_DIR ? path.resolve(env.MONITOR_INSTALL_OUTPUT_DIR) : null;
const serviceDir = output ? path.join(output, 'service') : env.MONITOR_INSTALL_SERVICE_DIR;
const plistFile = output ? path.join(output, `${env.MONITOR_INSTALL_LABEL}.plist`) : env.MONITOR_INSTALL_PLIST;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const settings = { NEWSLETTER_WORKER_ROOT: workerRoot, MONITOR_RELAY_URL: env.MONITOR_RELAY_URL, MONITOR_TEAM_ID: env.MONITOR_TEAM_ID,
  ...(env.MONITOR_WORKFLOWS_FILE ? { MONITOR_WORKFLOWS_FILE: path.resolve(env.MONITOR_WORKFLOWS_FILE) } : {}),
  ...(env.MONITOR_HUB_FLEET_DIRECTORY ? { MONITOR_HUB_FLEET_DIRECTORY: env.MONITOR_HUB_FLEET_DIRECTORY } : {}),
  ...(env.MONITOR_BRIDGE_CACHE ? { MONITOR_BRIDGE_CACHE: path.resolve(env.MONITOR_BRIDGE_CACHE) } : {}),
};
const runner = `#!/bin/zsh\nset -eu\n${Object.entries(settings).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}\n` +
  `export MONITOR_BRIDGE_TOKEN="$(/usr/bin/security find-generic-password -w -s 'MaxMonitor Newsletter Bridge' -a "$MONITOR_TEAM_ID")"\n` +
  `exec ${quote(nodePath)} ${quote(env.MONITOR_INSTALL_BRIDGE)} --once\n`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(env.MONITOR_INSTALL_LABEL)}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>${xml(path.join(serviceDir, 'run.sh'))}</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${interval}</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(serviceDir, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(serviceDir, 'stderr.log'))}</string>
</dict></plist>\n`;
fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(plistFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(serviceDir, 'run.sh'), runner, { mode: 0o700 });
fs.writeFileSync(plistFile, plist, { mode: 0o600 });
console.log(env.MONITOR_INSTALL_MODE === 'generate' ? `Dienstdateien erzeugt; nicht geladen: ${plistFile}` : 'Dienstdateien erzeugt.');
JS

if [ "$monitor_mode" = install ]; then
  /usr/bin/plutil -lint "$monitor_plist" >/dev/null
  /bin/launchctl bootout "gui/$monitor_uid/$monitor_label" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "gui/$monitor_uid" "$monitor_plist"
  echo "Newsletter-Monitor läuft beim Login und alle ${MONITOR_BRIDGE_INTERVAL_SECONDS:-60} Sekunden."
fi
