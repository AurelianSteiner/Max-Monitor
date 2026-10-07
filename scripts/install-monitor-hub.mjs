#!/usr/bin/env node
// Dedicated, reversible RS Hub deployment. Run --generate-only before --install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configuration, loadConfiguration, checkEnrollment } from './enroll-monitor-worker.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'max-monitor-relay.service';
const QUEUE_SERVICE = 'max-monitor-queue.service';
const BEGIN = '# MAX MONITOR BEGIN';
const END = '# MAX MONITOR END';
const SOURCE_FILES = ['team-server/server.js', 'team-server/fleet.js', 'team-server/enrollment.js', 'team-server/package.json',
  'team-server/public/dashboard.html', 'team-server/public/dashboard.css', 'team-server/public/dashboard.js', 'scripts/enroll-monitor-worker.mjs',
  'scripts/install-monitor-hub.mjs', 'scripts/install-monitor-hub.sh', 'scripts/newsletter-monitor-bridge.mjs'];
const defaults = { serverURL: 'https://api.ruegamer-steiner.de/max-monitor', teamId: 'RSMACS01', port: 8941, nodeBinary: '/usr/bin/node' };

export function installationSettings(values = {}, previous) {
  const proposed = { ...defaults, ...values };
  if (!Number.isInteger(proposed.port) || proposed.port < 1024 || proposed.port > 65535) throw new Error('Relay-Port muss zwischen 1024 und 65535 liegen.');
  if (!/^\/[A-Za-z0-9_./-]+$/.test(proposed.nodeBinary)) throw new Error('Node-Binary muss ein absoluter Linux-Pfad ohne Leerzeichen sein.');
  const validated = configuration({ serverURL: proposed.serverURL, teamId: proposed.teamId,
    ownerToken: previous?.ownerToken || crypto.randomBytes(24).toString('hex') });
  if (previous) {
    const old = configuration(previous);
    if (old.serverURL !== validated.serverURL || old.teamId !== validated.teamId) throw new Error('Bestehende Enrollment-Konfiguration gehört zu einer anderen Server-Adresse oder Team-ID; keine automatische Änderung.');
  }
  const url = new URL(validated.serverURL);
  if (url.protocol !== 'https:') throw new Error('Die öffentliche Hub-Adresse muss HTTPS verwenden.');
  const prefix = url.pathname.replace(/\/$/, '');
  if (!/^\/[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('Öffentliche Hub-Adresse benötigt genau einen Pfad-Präfix, zum Beispiel /max-monitor.');
  return { ...validated, port: proposed.port, nodeBinary: proposed.nodeBinary, prefix, serverName: url.hostname };
}

export function relayEnvironment(settings) {
  return `# Managed by Max Monitor Hub installer; root only.\nTEAM_TOKENS=${settings.teamId}:${settings.ownerToken}\nDATA_DIR=/var/lib/max-monitor\nHOST=127.0.0.1\nPORT=${settings.port}\n`;
}

export function relayService(settings) {
  return `# Managed by Max Monitor Hub installer\n[Unit]\nDescription=Max Monitor shared Mac fleet and queue relay\nAfter=network.target\n\n[Service]\nType=simple\nUser=max-monitor\nGroup=max-monitor\nWorkingDirectory=/opt/max-monitor/team-server\nEnvironmentFile=/etc/max-monitor/relay.env\nExecStart=${settings.nodeBinary} /opt/max-monitor/team-server/server.js\nRestart=on-failure\nRestartSec=5\nStateDirectory=max-monitor\nStateDirectoryMode=0700\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/var/lib/max-monitor\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function queueService(settings) {
  return `# Managed by Max Monitor Hub installer\n[Unit]\nDescription=Read-only ClickUp and Newsletter queue monitor\nAfter=network-online.target ${SERVICE}\nWants=network-online.target\nRequires=${SERVICE}\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=/opt/rs-hub\nExecStart=${settings.nodeBinary} /opt/max-monitor/scripts/newsletter-monitor-bridge.mjs --worker-root /opt/max-monitor/newsletter-source --local-hub /opt/rs-hub --enrollment-config /etc/max-monitor/enrollment.json --cache /var/lib/max-monitor-queue/cache.json --interval 60\nRestart=on-failure\nRestartSec=10\nStateDirectory=max-monitor-queue\nStateDirectoryMode=0700\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadOnlyPaths=/opt/rs-hub /etc/max-monitor\nReadWritePaths=/var/lib/max-monitor-queue\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function nginxLocation(settings) {
  return `    ${BEGIN}\n    location = ${settings.prefix} {\n        return 308 ${settings.prefix}/$is_args$args;\n    }\n    location ^~ ${settings.prefix}/ {\n        proxy_pass http://127.0.0.1:${settings.port}/;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_redirect off;\n        client_max_body_size 3m;\n    }\n    ${END}\n`;
}

// Tokenize nginx braces while respecting comments, quoted strings and escapes.
// Only the existing TLS server for the requested server_name is edited.
function nginxTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    if (source[index] === '#') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    const start = index;
    if ('{};'.includes(source[index])) { tokens.push({ value: source[index++], start, end: index }); continue; }
    let quote = null;
    let value = '';
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') { value += source.slice(index, index + 2); index += 2; continue; }
      if (quote) { index += 1; if (char === quote) quote = null; else value += char; continue; }
      if (char === '"' || char === "'") { quote = char; index += 1; continue; }
      if (/\s/.test(char) || '{};#'.includes(char)) break;
      value += char;
      index += 1;
    }
    if (quote) throw new Error('Nginx-Konfiguration enthält eine unvollständige Zeichenkette.');
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

export function injectNginxLocation(source, settings) {
  const tokens = nginxTokens(source);
  const servers = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].value !== 'server' || tokens[index + 1].value !== '{') continue;
    let depth = 1;
    let end = index + 2;
    let matchingName = false;
    let tls = false;
    while (end < tokens.length && depth > 0) {
      const token = tokens[end];
      if (depth === 1 && (token.value === 'server_name' || token.value === 'listen')) {
        const values = [];
        for (let directive = end + 1; directive < tokens.length && tokens[directive].value !== ';'; directive += 1) values.push(tokens[directive].value);
        if (token.value === 'server_name') matchingName ||= values.includes(settings.serverName);
        else tls ||= values.includes('ssl') || values.some((value) => /(?:^|:)443$/.test(value));
      }
      if (token.value === '{') depth += 1;
      if (token.value === '}') depth -= 1;
      end += 1;
    }
    if (depth !== 0) throw new Error('Nginx-Konfiguration enthält unvollständige Server-Blöcke.');
    if (matchingName && tls) servers.push({ start: tokens[index + 1].end, end: tokens[end - 1].start });
    index = end - 1;
  }
  if (servers.length !== 1) throw new Error('Genau ein bestehender TLS-Server mit passendem server_name ist erforderlich.');
  const target = servers[0];
  let body = source.slice(target.start, target.end);
  const begin = body.indexOf(BEGIN);
  const finish = body.indexOf(END);
  if ((begin >= 0) !== (finish >= 0) || (begin >= 0 && finish < begin)) throw new Error('Unvollständiger Max-Monitor-Block in Nginx; manuell prüfen.');
  if (begin >= 0) {
    const lineStart = body.lastIndexOf('\n', begin) + 1;
    const after = body.indexOf('\n', finish);
    body = body.slice(0, lineStart) + body.slice(after < 0 ? body.length : after + 1);
  }
  const escaped = settings.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\blocation\\s+(?:(?:=|\\^~)\\s+)?["']?${escaped}(?:/|[\\s"'])`).test(body)) throw new Error('Der Monitor-Pfad ist bereits außerhalb des verwalteten Blocks konfiguriert.');
  const insertion = body.endsWith('\n') ? '' : '\n';
  return source.slice(0, target.start) + body + insertion + nginxLocation(settings) + source.slice(target.end);
}

function privateJSON(file) {
  if (!fs.existsSync(file)) return undefined;
  return loadConfiguration({ env: {}, configPath: file });
}

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: file.startsWith('/etc/max-monitor/') ? 0o700 : 0o755 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
    // writeFileSync's mode is filtered by umask. Apply the intended permissions
    // before the atomic rename, so the non-root relay can read public runtime
    // files even when root deploys with umask 077.
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function ensureRuntimeDirectories(files, { runtimeDirectory = '/opt/max-monitor', changeOwner = fs.chownSync } = {}) {
  const root = path.resolve(runtimeDirectory);
  const directories = new Set();
  for (const file of files) {
    const target = path.resolve(file.target);
    if (!target.startsWith(`${root}/`)) continue;
    let directory = path.dirname(target);
    while (directory === root || directory.startsWith(`${root}/`)) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Runtime-Verzeichnis darf kein Symlink sein.');
    changeOwner(directory, 0, 0);
    fs.chmodSync(directory, 0o755);
  }
}

export function prepareInstallation({ stageDirectory, nginxConfigPath, workerRoot, existingConfigPath = '/etc/max-monitor/enrollment.json', values = {}, sourceRoot = REPO_ROOT }) {
  if (!nginxConfigPath) throw new Error('--nginx-config ist erforderlich; die bestehende TLS-Konfiguration wird zuerst geprüft.');
  if (!workerRoot) throw new Error('--worker-root ist erforderlich; ausschließlich geprüfter Newsletter-Quellcode wird kopiert.');
  const settings = installationSettings(values, privateJSON(existingConfigPath));
  const source = fs.readFileSync(nginxConfigPath, 'utf8');
  const nginx = injectNginxLocation(source, settings);
  const files = SOURCE_FILES.map((relative) => ({ target: `/opt/max-monitor/${relative}`, content: fs.readFileSync(path.join(sourceRoot, relative)), mode: relative.endsWith('.sh') ? 0o755 : 0o644 }));
  for (const name of ['config.js', 'hub-transport.js', 'pre-gen.js']) {
    files.push({ target: `/opt/max-monitor/newsletter-source/src/${name}`, content: fs.readFileSync(path.join(workerRoot, 'src', name)), mode: 0o644 });
  }
  files.push({ target: '/opt/max-monitor/newsletter-source/config/worker.local.json', mode: 0o600,
    content: `${JSON.stringify({ worker_id: 'max-monitor-source', claude: { bin: '/usr/bin/false' } }, null, 2)}\n` });
  files.push({ target: '/etc/max-monitor/enrollment.json', content: `${JSON.stringify({ serverURL: settings.serverURL, teamId: settings.teamId, ownerToken: settings.ownerToken }, null, 2)}\n`, mode: 0o600 },
    { target: '/etc/max-monitor/relay.env', content: relayEnvironment(settings), mode: 0o600 },
    { target: `/etc/systemd/system/${SERVICE}`, content: relayService(settings), mode: 0o644 },
    { target: `/etc/systemd/system/${QUEUE_SERVICE}`, content: queueService(settings), mode: 0o644 },
    { target: fs.realpathSync(nginxConfigPath), content: nginx, mode: fs.statSync(nginxConfigPath).mode & 0o777 });
  if (stageDirectory) {
    fs.mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(stageDirectory, 0o700);
    for (const file of files) atomicWrite(path.join(stageDirectory, 'payload', file.target.slice(1)), file.content, file.mode);
    atomicWrite(path.join(stageDirectory, 'plan.json'), `${JSON.stringify({ schema: 1, serverURL: settings.serverURL, teamId: settings.teamId, port: settings.port,
      service: SERVICE, queueService: QUEUE_SERVICE, dataDirectory: '/var/lib/max-monitor', queueCacheDirectory: '/var/lib/max-monitor-queue', files: files.map(({ target, mode }) => ({ target, mode })) }, null, 2)}\n`, 0o600);
  }
  return { settings, files };
}

function command(binary, arguments_, allowFailure = false) {
  const result = spawnSync(binary, arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`Systembefehl fehlgeschlagen: ${path.basename(binary)} ${arguments_[0] || ''}`);
  return result;
}

function systemctl(...args) { return command('/usr/bin/systemctl', args); }
function activeService(name = SERVICE) { return command('/usr/bin/systemctl', ['is-active', '--quiet', name], true).status === 0; }
function enabledService(name = SERVICE) { return command('/usr/bin/systemctl', ['is-enabled', '--quiet', name], true).status === 0; }
function requireLinuxRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('--install und --rollback benötigen Linux und root auf dem RS Hub.');
}

async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Loopback-Relay-Port ist bereits belegt.')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export function safeFailureReason(error) {
  // Classify errors without echoing upstream responses, request URLs or tokens.
  const message = String(error?.message || '');
  const http = message.match(/HTTP\s+(\d{3})/);
  if (http) return `HTTP ${http[1]}`;
  if (message.includes('nicht erreichbar')) return 'Server nicht erreichbar';
  if (message.includes('JSON')) return 'ungültige JSON-Antwort';
  if (message.includes('Worker-Registrierung')) return 'Enrollment-Schema nicht verfügbar';
  if (message.includes('Fleet-Übersicht')) return 'Fleet-Schema nicht verfügbar';
  if (message.includes('Snapshot')) return 'kein frischer Queue-Snapshot';
  if (message.includes('Systembefehl')) return 'Systembefehl fehlgeschlagen';
  return 'Funktionsprüfung fehlgeschlagen';
}

export async function waitForEnrollment(settings, { attempts = 20, interval = 500, probe = checkEnrollment,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastReason = 'Server nicht erreichbar';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await probe(settings);
      return;
    } catch (error) {
      lastReason = safeFailureReason(error);
      if (attempt < attempts - 1) await pause(interval);
    }
  }
  throw new Error(`Relay-Funktionsprüfung fehlgeschlagen (${lastReason}).`);
}

async function waitForSource(settings, startedAt) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${settings.port}/v1/teams/${settings.teamId}/fleet`, {
        redirect: 'error', headers: { Authorization: `Bearer ${settings.ownerToken}` }, signal: AbortSignal.timeout(5000),
      });
      const snapshot = response.ok ? await response.json() : null;
      if (snapshot?.queue?.source && !snapshot.queue.source.error && Date.parse(snapshot.queue.source.lastSuccessAt) >= startedAt - 2000) return;
    } catch { /* Wait for the first complete shared source snapshot. */ }
    if (attempt < 119) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Der zentrale Queue-Dienst hat keinen frischen vollständigen Snapshot geliefert.');
}

export function restoreFiles(backupDirectory, manifest) {
  for (const item of manifest.files) {
    if (item.existed) atomicWrite(item.target, fs.readFileSync(path.join(backupDirectory, item.backup)), item.mode);
    else fs.rmSync(item.target, { force: true });
  }
}

function restoreInstallation(backupDirectory, manifest) {
  const services = manifest.services || [{ name: SERVICE, wasActive: manifest.wasActive, wasEnabled: manifest.wasEnabled }];
  for (const service of [...services].reverse()) {
    command('/usr/bin/systemctl', ['stop', service.name], true);
    command('/usr/bin/systemctl', ['disable', service.name], true);
  }
  restoreFiles(backupDirectory, manifest);
  systemctl('daemon-reload');
  for (const service of services) {
    if (service.wasEnabled) systemctl('enable', service.name);
    if (service.wasActive) systemctl('start', service.name);
  }
  command('/usr/sbin/nginx', ['-t']);
  systemctl('reload', 'nginx');
}

export async function installOnHub(options) {
  requireLinuxRoot();
  const { settings, files } = prepareInstallation(options);
  const wasActive = activeService();
  const wasEnabled = enabledService();
  const services = [{ name: SERVICE, wasActive, wasEnabled }, { name: QUEUE_SERVICE, wasActive: activeService(QUEUE_SERVICE), wasEnabled: enabledService(QUEUE_SERVICE) }];
  if (!wasActive) await freePort(settings.port);
  command('/usr/sbin/nginx', ['-t']);
  command('/usr/bin/systemctl', ['--version']);
  command(settings.nodeBinary, ['-e', 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)']);
  const user = command('/usr/bin/id', ['-u', 'max-monitor'], true);
  if (user.status === 0 && user.stdout.trim() === '0') throw new Error('Der Dienstbenutzer max-monitor darf nicht root sein.');
  if (user.status !== 0) command('/usr/sbin/useradd', ['--system', '--user-group', '--home-dir', '/var/lib/max-monitor', '--no-create-home', '--shell', '/usr/sbin/nologin', 'max-monitor']);
  const backupDirectory = path.join('/var/backups/max-monitor', `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const manifest = { schema: 1, service: SERVICE, wasActive, wasEnabled, services, files: [] };
  for (const [index, file] of files.entries()) {
    const existed = fs.existsSync(file.target);
    const mode = existed ? fs.statSync(file.target).mode & 0o777 : file.mode;
    const backup = `files/${index}`;
    if (existed) atomicWrite(path.join(backupDirectory, backup), fs.readFileSync(file.target), mode);
    manifest.files.push({ target: file.target, existed, mode, backup });
  }
  atomicWrite(path.join(backupDirectory, 'rollback.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  let stage = 'files';
  try {
    ensureRuntimeDirectories(files);
    for (const file of files) atomicWrite(file.target, file.content, file.mode);
    stage = 'nginx-test';
    command('/usr/sbin/nginx', ['-t']);
    stage = 'relay-start';
    systemctl('daemon-reload');
    systemctl('enable', SERVICE);
    systemctl('restart', SERVICE);
    stage = 'relay-local-check';
    await waitForEnrollment({ ...settings, serverURL: `http://127.0.0.1:${settings.port}` });
    stage = 'nginx-reload';
    systemctl('reload', 'nginx');
    // A successful reload command sends HUP; old workers can still serve the
    // previous routes briefly. Verify the real public APIs with bounded retries.
    stage = 'relay-public-check';
    await waitForEnrollment(settings);
    const startedAt = Date.now();
    stage = 'queue-start';
    systemctl('enable', QUEUE_SERVICE);
    systemctl('restart', QUEUE_SERVICE);
    stage = 'queue-source-check';
    await waitForSource(settings, startedAt);
    return { ok: true, serverURL: settings.serverURL, teamId: settings.teamId, service: SERVICE, queueService: QUEUE_SERVICE, sourceFresh: true, rollbackDirectory: backupDirectory };
  } catch (error) {
    const diagnostic = `${stage}: ${safeFailureReason(error)}`;
    try { restoreInstallation(backupDirectory, manifest); } catch { throw new Error(`Hub-Installation fehlgeschlagen (${diagnostic}); automatische Wiederherstellung war unvollständig. Private Sicherung: ${backupDirectory}`); }
    throw new Error(`Hub-Installation fehlgeschlagen (${diagnostic}) und wurde zurückgenommen. Private Sicherung: ${backupDirectory}`);
  }
}

export function rollbackOnHub(backupDirectory) {
  requireLinuxRoot();
  const file = path.join(backupDirectory, 'rollback.json');
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== 0) throw new Error('Rollback benötigt eine private root-Sicherung.');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== 1 || manifest.service !== SERVICE || !Array.isArray(manifest.files)) throw new Error('Ungültige Rollback-Sicherung.');
  restoreInstallation(backupDirectory, manifest);
  return { ok: true, restored: true, dataDirectoryPreserved: '/var/lib/max-monitor' };
}

export function parseInstallArguments(argv) {
  const options = { values: {} };
  const keys = { '--nginx-config': 'nginxConfigPath', '--worker-root': 'workerRoot', '--existing-config': 'existingConfigPath', '--generate-only': 'stageDirectory', '--rollback': 'rollbackDirectory' };
  const valueKeys = { '--server-url': 'serverURL', '--team-id': 'teamId', '--port': 'port', '--node-binary': 'nodeBinary' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--install') options.install = true;
    else if (arg === '--help') options.help = true;
    else if ((keys[arg] || valueKeys[arg]) && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const value = argv[++index];
      if (keys[arg]) options[keys[arg]] = value;
      else options.values[valueKeys[arg]] = arg === '--port' ? Number(value) : value;
    } else throw new Error('Ungültige Hub-Installer-Option; siehe --help.');
  }
  const modes = [Boolean(options.install), Boolean(options.stageDirectory), Boolean(options.rollbackDirectory)].filter(Boolean).length;
  if (!options.help && modes !== 1) throw new Error('Genau einen Modus --generate-only <dir>, --install oder --rollback <dir> wählen.');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallArguments(argv);
  if (options.help) {
    process.stdout.write('node scripts/install-monitor-hub.mjs --generate-only <private-dir>|--install --nginx-config <existing-tls-config> --worker-root <newsletter-source>\n' +
      'Optionen: --server-url <https-prefix-url> --team-id <id> --port <port> --node-binary <path> --existing-config <private-json>\n' +
      'Wiederherstellung: --rollback <private-backup-dir>. DATA_DIR wird niemals gelöscht.\n');
    return;
  }
  if (options.rollbackDirectory) process.stdout.write(`${JSON.stringify(rollbackOnHub(options.rollbackDirectory))}\n`);
  else if (options.install) process.stdout.write(`${JSON.stringify(await installOnHub(options))}\n`);
  else {
    const plan = prepareInstallation(options);
    process.stdout.write(`${JSON.stringify({ ok: true, generatedOnly: true, stageDirectory: options.stageDirectory, serverURL: plan.settings.serverURL, teamId: plan.settings.teamId, port: plan.settings.port })}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
