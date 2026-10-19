#!/usr/bin/env node
// Enrollment secrets travel only over SSH and child stdin. Never argv or logs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'xyz.fi5h.Usage4Claude';
const DEFAULT_HELPER = '/opt/max-monitor/scripts/enroll-monitor-worker.mjs';
const PREFERENCE_FIELDS = {deviceId:'fleetDeviceId',workerId:'fleetWorkerId',serverURL:'teamServerURL',
  teamId:'teamServerTeamId',memberId:'teamServerMemberId',role:'teamServerRole'};

export function optionsFrom(args) {
  const result = { workerRoot: path.join(os.homedir(), 'Documents', 'AI Newsletter Creation'),
    appPath: path.join(os.homedir(), 'Applications', 'Max Monitor.app'),
    hubHelper: DEFAULT_HELPER, bundleId:BUNDLE_ID, check: false, dryRun: false, open: true,
    launchAtLogin: true, allowLoopback: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--check') result.check = true;
    else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--update-only') result.updateOnly = true;
    else if (argument === '--code-only') result.codeOnly = true;
    else if (argument === '--no-open') result.open = false;
    else if (argument === '--no-launch-at-login') result.launchAtLogin = false;
    else if (argument === '--allow-loopback') result.allowLoopback = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (['--worker-root', '--app-path', '--app-bundle', '--hub-helper', '--bundle-id'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Wert fehlt: ${argument}`);
      result[{'--worker-root':'workerRoot','--app-path':'appPath','--app-bundle':'appBundle','--hub-helper':'hubHelper','--bundle-id':'bundleId'}[argument]] = value;
    } else throw new Error(`Unbekannte Option: ${argument}`);
  }
  if (result.check && result.dryRun) throw new Error('--check und --dry-run sind getrennte Aufrufe.');
  if (result.codeOnly && (!result.updateOnly || result.check || result.dryRun))
    throw new Error('--code-only benötigt --update-only; die Verbindung wird danach in der laufenden App geprüft.');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(result.hubHelper)) throw new Error('Ungültiger Hub-Helferpfad.');
  if (!/^[A-Za-z][A-Za-z0-9.-]{2,119}$/.test(result.bundleId)) throw new Error('Ungültige App-Bundle-ID.');
  result.workerRoot = path.resolve(result.workerRoot);
  result.appPath = path.resolve(result.appPath);
  if (result.appBundle) result.appBundle = path.resolve(result.appBundle);
  return result;
}

const ENROLLMENT_STAGES = Object.freeze({
  relay: 'Server-Verbindung prüfen',
  credentials: 'Zugang sicher im Schlüsselbund speichern; eine macOS-Passwortabfrage bitte bestätigen',
  settings: 'Verbindungseinstellungen speichern',
  login: 'Autostart einrichten',
  complete: 'Gespeicherte Verbindung lesen',
});

// tee (build only, never for credentials): the child's output still reaches this
// process's stdout/stderr (or the given streams), and its last OUTPUT_TAIL bytes
// travel with a failure as error.outputTail, so the cause can be named.
const OUTPUT_TAIL = 16 * 1024;

export function run(command, args, { input, env = process.env, cwd, timeout = 45000,
  label = path.basename(command), outputLimit = 128 * 1024, inherit = false, tee = null,
  onProgress, progressTimeouts = {} } = {}) {
  return new Promise((resolve, reject) => {
    const forward = tee === true ? { stdout: process.stdout, stderr: process.stderr } : tee;
    const child = spawn(command, args, { cwd, env, shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', inherit && !forward ? 'inherit' : 'pipe', inherit && !forward ? 'inherit' : 'pipe'] });
    let stdout = '', tooLarge = false, timedOut = false, stderrBuffer = '', stage = null, tail = '';
    const preferenceRead = command === '/usr/bin/defaults' && args.length === 3 && args[0] === 'read'
      && Object.values(PREFERENCE_FIELDS).includes(args[2]);
    let preferenceError = '';
    const stages = Object.keys(ENROLLMENT_STAGES);
    const expire = () => { timedOut = true; child.kill('SIGKILL'); };
    let timer = setTimeout(expire, timeout);
    const keep = chunk => { tail = (tail + chunk).slice(-OUTPUT_TAIL); };
    child.stdout?.on('data', chunk => {
      if (forward) { forward.stdout?.write(chunk); keep(chunk); return; }
      if (Buffer.byteLength(stdout) + chunk.length > outputLimit) { tooLarge = true; child.kill('SIGKILL'); }
      else stdout += chunk;
    });
    // Raw stderr stays private. Accept only fixed, forward-moving native phase markers.
    child.stderr?.on('data', chunk => {
      if (preferenceRead) preferenceError = (preferenceError + chunk).slice(-4096);
      if (forward) { forward.stderr?.write(chunk); keep(chunk); return; }
      if (!onProgress) return;
      stderrBuffer = (stderrBuffer + chunk).slice(-4096);
      let end;
      while ((end = stderrBuffer.indexOf('\n')) !== -1) {
        const line = stderrBuffer.slice(0, end); stderrBuffer = stderrBuffer.slice(end + 1);
        const next = line.startsWith('MAX_MONITOR_ENROLLMENT_STAGE:')
          ? line.slice('MAX_MONITOR_ENROLLMENT_STAGE:'.length) : null;
        if (!Object.hasOwn(ENROLLMENT_STAGES, next) || stages.indexOf(next) <= stages.indexOf(stage)) continue;
        stage = next;
        clearTimeout(timer);
        timer = setTimeout(expire, progressTimeouts[stage] ?? timeout);
        onProgress(stage);
      }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${label} konnte nicht gestartet werden.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || tooLarge || code !== 0) {
        const reason = timedOut ? `Zeitüberschreitung${stage ? `: ${ENROLLMENT_STAGES[stage]}` : ''}`
          : tooLarge ? 'Antwort zu groß' : `Exit ${code}`;
        const preferenceMissing = preferenceRead && !timedOut && code === 1
          && /^The domain\/default pair of \([^\n]*\) does not exist\s*$/m.test(preferenceError);
        reject(Object.assign(new Error(`${label} fehlgeschlagen (${reason}).`), { timedOut, stage, exitCode:code,
          ...(preferenceMissing ? {preferenceMissing:true} : {}),
          ...(forward ? { outputTail:tail } : {}) }));
      } else resolve(stdout);
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function parseJson(value, label) {
  try { const result = JSON.parse(value); if (result && !Array.isArray(result) && typeof result === 'object') return result; } catch {}
  throw new Error(`${label}: ungültige Antwort.`);
}
function homePath(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }

export async function readWorker(options) {
  const configFile = path.resolve(options.workerRoot, homePath(options.workerConfig || process.env.MAX_MONITOR_WORKER_CONFIG || 'config/worker.local.json'));
  if (options.updateOnly) await fs.access(configFile);
  const { loadConfig } = require(path.join(options.workerRoot, 'src', 'config.js'));
  const config = loadConfig(configFile, { root: options.workerRoot });
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(config.worker_id)) throw new Error('Eine eindeutige Worker-ID fehlt. Newsletter-Setup zuerst ausführen.');
  const hub = config.hub;
  if (!/^[A-Za-z0-9_.@:-]+$/.test(hub.ssh_host)) throw new Error('Ungültiger Hub-Host.');
  return { workerId: config.worker_id, hubHost: hub.ssh_host,
    identityFile: homePath(hub.identity_file), knownHostsFile: hub.known_hosts_file,
    monitorDeviceIdFile: config.paths?.state_db ? path.join(path.dirname(config.paths.state_db), 'monitor-device-id') : undefined };
}

export function hubArguments(worker, options, check = false) {
  return ['-i', worker.identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${worker.knownHostsFile}"`,
    '-o', 'ConnectTimeout=15', worker.hubHost,
    `node ${options.hubHelper} ${check ? '--check' : '--stdin'}`];
}

export function validateEnrollment(value, workerId, deviceId, allowLoopback = false) {
  let url;
  try { url = new URL(value.serverURL); } catch { throw new Error('Hub liefert keine gültige Server-Adresse.'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && loopback)) ||
      (loopback && !allowLoopback)) throw new Error('Der Hub muss einen gemeinsam erreichbaren HTTPS-Monitor liefern.');
  if (!/^[A-Z0-9]{4,16}$/.test(value.teamId) || !/^[A-Za-z0-9_-]{20,256}$/.test(value.token) ||
      value.workerId !== workerId || value.deviceId !== deviceId ||
      !/^[a-z0-9-]{1,64}$/.test(value.memberId)) throw new Error('Hub-Registrierung passt nicht zu diesem Mac.');
  return value;
}

export async function appInformation(appPath, runner = run, expectedBundleId = BUNDLE_ID, allowLegacy = false) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  try { await fs.access(plist); } catch { return null; }
  const info = parseJson(await runner('/usr/bin/python3', ['-c',
    'import plistlib,json,sys; d=plistlib.load(open(sys.argv[1],"rb")); print(json.dumps({k:d.get(k) for k in ["CFBundleIdentifier","CFBundleExecutable","CFBundleShortVersionString","RSWorkerEnrollmentVersion"]}))', plist],
    {label:'App-Version prüfen'}), 'App-Version');
  const legacy = info.RSWorkerEnrollmentVersion == null;
  if (info.CFBundleIdentifier !== expectedBundleId ||
      (info.RSWorkerEnrollmentVersion !== 1 && !(allowLegacy && legacy)) ||
      !/^[A-Za-z0-9_-]+$/.test(info.CFBundleExecutable || '')) return null;
  return { executable: path.join(appPath, 'Contents', 'MacOS', info.CFBundleExecutable),
    version:info.CFBundleShortVersionString, ...(legacy ? {legacy:true} : {}) };
}

export async function appStatus(app, verify = false, runner = run, timeout = 45000) {
  const value = parseJson(await runner(app.executable, ['--enrollment-status', ...(verify ? ['--verify'] : [])],
    {label: verify ? 'Monitor-Verbindung prüfen' : 'Mac-Kennung lesen', timeout}), 'Monitor-Status');
  const safe = {};
  for (const key of ['schema','deviceId','bundleId','configured','serverURL','teamId','workerId','memberId','role','launchAtLoginStatus','verified','fleetAvailable'])
    if (value[key] !== undefined) safe[key] = value[key];
  return safe;
}
export function healthy(status, worker) {
  return status.configured === true && (!status.role || status.role === 'member') && status.workerId === worker.workerId &&
    status.verified === true && status.fleetAvailable === true;
}

function startupSummary(status, requested, log) {
  requested = requested !== false;
  const loginReady = status.launchAtLoginStatus === 'enabled';
  const loginActionRequired = requested && !loginReady;
  const loginApprovalRequired = loginActionRequired && status.launchAtLoginStatus === 'requiresApproval';
  const result = {...status, launchAtLoginRequested:requested, loginReady, loginActionRequired, loginApprovalRequired};
  if (loginActionRequired) {
    result.loginHint = loginApprovalRequired
      ? 'macOS benötigt noch die Freigabe unter Systemeinstellungen → Allgemein → Anmeldeobjekte.'
      : 'Autostart ist noch nicht aktiv. In Max Monitor unter Einstellungen → Allgemein → Beim Anmelden starten aktivieren und die Einrichtung erneut prüfen.';
    log?.(result.loginHint);
  }
  return result;
}

async function sourceRevision(runner) {
  try { return (await runner('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {label:'Repo-Version lesen'})).trim(); }
  catch { return 'local-source'; }
}
// AppKit metadata identifies renamed/moved copies without touching other bundle IDs.
// Objective-C framework calls do not use Apple Events or request Automation/TCC access.
const APP_PROCESS_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  var action = argv[0], bundleId = argv[1];
  if (!['inventory','terminate','forceTerminate'].includes(action)) throw new Error('Invalid process action');
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  var result = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var value = {pid:Number(app.processIdentifier), bundleId:ObjC.unwrap(app.bundleIdentifier),
      bundlePath:ObjC.unwrap(app.bundleURL.path), executablePath:ObjC.unwrap(app.executableURL.path)};
    if (action === 'terminate') value.terminationRequested = Boolean(app.terminate);
    if (action === 'forceTerminate') value.terminationRequested = Boolean(app.forceTerminate);
    result.push(value);
  }
  return JSON.stringify(result);
}`;

export async function runningMonitorApps(bundleId, runner = run, action = 'inventory') {
  const output = await runner('/usr/bin/osascript',
    ['-l','JavaScript','-e',APP_PROCESS_SCRIPT,action,bundleId], {label:'Laufende Monitor-App prüfen'});
  let values;
  try { values = JSON.parse(output); } catch { throw new Error('Laufende Monitor-App konnte nicht geprüft werden.'); }
  if (!Array.isArray(values)) throw new Error('Laufende Monitor-App konnte nicht geprüft werden.');
  const matches = values.filter(value => value?.bundleId === bundleId);
  if (matches.some(value => !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.bundlePath !== 'string' || !path.isAbsolute(value.bundlePath) ||
      typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath)))
    throw new Error('Laufende Monitor-App lieferte keine eindeutige Kennung.');
  return matches;
}

export async function stopMonitorApps(bundleId, runner = run, pause = delay, knownApps, recoverHung = false) {
  const original = knownApps || await runningMonitorApps(bundleId, runner);
  if (!original.length) return [];
  await runningMonitorApps(bundleId, runner, 'terminate');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await runningMonitorApps(bundleId, runner)).length) return original;
    await pause(250);
  }
  if (recoverHung) {
    await runningMonitorApps(bundleId,runner,'forceTerminate');
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await runningMonitorApps(bundleId,runner)).length) return original;
      await pause(250);
    }
  }
  throw new Error('Laufende Monitor-App lässt sich nicht schließen. App schließen und Setup erneut ausführen.');
}

export async function openMonitorApp(appPath, bundleId, runner = run, pause = delay) {
  const intended = await fs.realpath(appPath);
  const isIntended = app => app.bundlePath === intended &&
    app.executablePath.startsWith(path.join(intended,'Contents','MacOS') + path.sep);
  const active = await runningMonitorApps(bundleId, runner);
  if (active.length === 1 && isIntended(active[0])) return active[0];
  if (active.length) {
    await requireUnlockedLoginKeychain(runner);
    await stopMonitorApps(bundleId, runner, pause, active);
  }
  await runner('/usr/bin/open', ['-g','-n',appPath], {label:'Max Monitor öffnen'});
  for (let attempt = 0; attempt < 20; attempt++) {
    const launched = await runningMonitorApps(bundleId, runner);
    if (launched.length === 1 && isIntended(launched[0])) return launched[0];
    await pause(250);
  }
  throw new Error('Laufende Monitor-App: Die neu installierte App läuft noch nicht. App öffnen und Setup erneut prüfen.');
}

async function restoreMonitorApps(original, bundleId, runner) {
  let active;
  try { active = await runningMonitorApps(bundleId, runner); } catch { return; }
  for (const appPath of new Set(original.map(app => app.bundlePath))) {
    if (active.some(app => app.bundlePath === appPath)) continue;
    try {
      await fs.access(appPath);
      await runner('/usr/bin/open', ['-g','-n',appPath], {label:'Vorherigen Monitor öffnen'});
    } catch {}
  }
}

export async function installBundle(source, destination, runner = run) {
  if (source === destination) return { rollback:async()=>{}, finish:async()=>{} };
  const parent = path.dirname(destination);
  await fs.mkdir(parent, {recursive:true});
  const stage = await fs.mkdtemp(path.join(parent, '.max-monitor-'));
  const stagedApp = path.join(stage, 'Max Monitor.app'), backup = path.join(stage, 'previous.app');
  let previous = false, installed = false;
  try {
    await runner('/usr/bin/ditto', [source, stagedApp], {label:'Max Monitor installieren'});
    await runner('/usr/bin/codesign', ['--verify','--deep','--strict',stagedApp], {label:'App-Signatur prüfen'});
    try { await fs.rename(destination, backup); previous = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stagedApp, destination); installed = true;
  } catch (error) {
    if (previous) await fs.rename(backup, destination);
    await fs.rm(stage, {recursive:true,force:true}); throw error;
  }
  return {
    rollback: async () => {
      if (installed) await fs.rm(destination, {recursive:true,force:true});
      if (previous) await fs.rename(backup, destination);
      await fs.rm(stage, {recursive:true,force:true});
    },
    finish: async () => fs.rm(stage, {recursive:true,force:true}),
  };
}

// Exactly the inputs of scripts/build_without_xcode.sh: Swift sources and
// resources, the project version, Info.plist/entitlements and the build script.
// Every other file (helpers, relay, docs, tests) leaves the app binary unchanged.
// A new build input must be added here, or it would not trigger a rebuild.
export const NATIVE_PATHS = ['Usage4Claude', 'Usage4Claude.xcodeproj', 'Config/Info.plist',
  'Config/Usage4Claude.entitlements', 'Package.swift', 'Package.resolved', 'scripts/build_without_xcode.sh'];
const NATIVE_FILE = /^(?:Usage4Claude\/|Usage4Claude\.xcodeproj\/|Config\/(?:Info\.plist|Usage4Claude\.entitlements)$|Package\.(?:swift|resolved)$|scripts\/build_without_xcode\.sh$)/;

export async function nativeCodeUnchanged(from, to, runner = run) {
  if (!/^[a-f0-9]{40}$/.test(from || '') || !/^[a-f0-9]{40}$/.test(to || '')) return false;
  try {
    const changed = (await runner('git', ['-C', ROOT, 'diff', '--name-only', from, to, '--'],
      {label:'Native App-Änderungen prüfen'})).trim().split('\n').filter(Boolean);
    // An allowlist of non-native helpers rejected every new helper script and
    // made old worker toolchains rebuild an unchanged app every ~100 s (14.10.).
    return !changed.some(file => NATIVE_FILE.test(file));
  } catch { return false; }
}

// Content key of every native build input at one revision. A fix commit to the
// same Swift file yields a new key, unlike a list of changed file names.
export async function nativeSourceKey(revision, runner = run) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) return null;
  try {
    const tree = await runner('git', ['-C', ROOT, 'ls-tree', revision, '--', ...NATIVE_PATHS], {label:'Native App-Quellen lesen'});
    return tree.trim() ? createHash('sha256').update(tree).digest('hex') : null;
  } catch { return null; }
}

async function swiftToolchain(runner) {
  try { return (await runner('swiftc', ['--version'], {label:'Swift-Version lesen'})).split('\n')[0].trim().slice(0, 200) || 'unknown'; }
  catch { return 'unknown'; }
}

export const BUILD_RETRY_MS = 6 * 3600000;
const CAUSE_MAX = 200;

// The line of a failed build's output that names its cause: the build script's
// own verdict (❌), else the last located compiler diagnostic (file:line:col:
// error:), else the last other error line, else the last line. swiftc quotes the
// source line after a diagnostic, and a source line may itself contain "error:"
// or "fehlgeschlagen"; the driver closes with a summary such as "error:
// emit-module command failed" (review A14-02). Without colours, paths below the
// repo or the home folder, credentials-like tokens; at most CAUSE_MAX characters.
// null without output.
export function buildCause(output) {
  const lines = String(output || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = pattern => [...lines].reverse().find(value => pattern.test(value));
  const line = last(/^❌/) || last(/:\d+:\d+: (?:fatal )?error: /)
    || last(/\berror:|\bfatal\b|fehlgeschlagen|nicht gefunden|failed/i) || lines.at(-1);
  const home = os.homedir();
  const safe = line.split(ROOT + path.sep).join('').replace(/\/(?:[^\s/]+\/)*?(Usage4Claude(?:\.xcodeproj)?\/)/g, '$1')
    .split(home && home !== path.sep ? home : '\0').join('~')
    .replace(/\b(?:xox[abposr]-|sk-|gh[opsu]_)[A-Za-z0-9_-]+/g, '[ENTFERNT]').replace(/Bearer\s+\S+/gi, 'Bearer [ENTFERNT]');
  return safe.length > CAUSE_MAX ? safe.slice(0, CAUSE_MAX - 1) + '…' : safe;
}

// Source build of the app; a failure names its cause (A14-02, Fehleraudit 17.10.2026).
async function buildApp(runner, options) {
  try {
    await runner('/bin/bash',[path.join(ROOT,'scripts','build_without_xcode.sh')],{
      cwd:ROOT,env:{...process.env,U4C_PRODUCT_NAME:'Max Monitor',U4C_BUNDLE_ID:options.bundleId,U4C_APPCAST_URL:''},
      timeout:15*60000,tee:true,label:'Max Monitor bauen'});
  } catch (error) {
    const cause = buildCause(error.outputTail);
    if (cause && !error.message.includes(cause)) error.message = error.message.replace(/\.$/, '') + ': ' + cause;
    if (cause) error.buildCause = cause;
    throw error;
  }
  return path.join(ROOT,'build','no-xcode','Max Monitor.app');
}

// The last failed background update, kept after a later success (recoveredAt), so
// a sporadic failure can still be explained (A14-02, Fehleraudit 17.10.2026). The
// same failure in a row is one episode: since stays, count grows.
function failureRecord(previous, error, at) {
  const text = String(error?.message || 'Unbekannter Fehler').replace(/\s+/g, ' ').trim();
  const message = text.length > CAUSE_MAX ? text.slice(0, CAUSE_MAX - 1) + '…' : text;
  const same = previous && typeof previous === 'object' && !previous.recoveredAt && previous.message === message;
  return { at, message, since: same && typeof previous.since === 'string' ? previous.since : at,
    count: same ? (Number.isSafeInteger(previous.count) ? previous.count : 1) + 1 : 1 };
}

async function recordUpdateFailure(receiptPath, error, at) {
  let receipt = {};
  try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); } catch {}
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) receipt = {};
  await fs.mkdir(path.dirname(receiptPath),{recursive:true,mode:0o700});
  const temporary = receiptPath + '.tmp';
  await fs.writeFile(temporary,JSON.stringify({...receipt,lastFailure:failureRecord(receipt.lastFailure, error, at)},null,2)+'\n',{mode:0o600});
  await fs.rename(temporary,receiptPath);
}

export async function storedMonitorPreferences(bundleId, runner = run) {
  const safe = {schema:1,bundleId};
  for (const [field,key] of Object.entries(PREFERENCE_FIELDS)) {
    try { safe[field] = (await runner('/usr/bin/defaults',['read',bundleId,key],
      {label:'Gespeicherte Monitor-Einstellung lesen',timeout:5000})).trim() || null; }
    catch (error) {
      if (error.preferenceMissing === true) safe[field] = null;
      else throw Object.assign(new Error(`Monitor-Einstellungen nicht lesbar (${key}); Bindung nicht bestätigt. `
        + 'Für einen ausdrücklich nur auf App-Code begrenzten Austausch --update-only --code-only verwenden '
        + 'und die bestehende Verbindung danach in der laufenden App prüfen.'), {code:'MONITOR_PREFERENCES_UNAVAILABLE'});
    }
  }
  safe.deviceId = safe.deviceId?.toLowerCase() || null;
  safe.configured = Boolean(safe.serverURL && safe.teamId && /^[0-9a-f-]{36}$/.test(safe.deviceId || ''));
  return safe;
}

export async function workerArtifactManifest(manifestPath = path.join(ROOT,'releases','worker-native.json')) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath,'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('App-Version: Monitor-Release ist ungültig.'); }
  if (manifest.schema !== 1 || !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.version || '') ||
      (manifest.paused !== undefined && typeof manifest.paused !== 'boolean') ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceRevision || '') ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
      manifest.tag !== 'worker-native-' + manifest.sourceRevision.slice(0,12) ||
      manifest.asset !== 'Max-Monitor-worker.zip') throw new Error('App-Version: Monitor-Release ist ungültig.');
  return manifest;
}

async function artifactMatchesSource(manifest, revision, runner) {
  if (await nativeCodeUnchanged(manifest.sourceRevision,revision,runner)) return true;
  await runner('git',['-C',ROOT,'fetch','--quiet','origin',manifest.sourceRevision],{label:'Repo-Update: Monitor-Release-Stand prüfen'});
  return nativeCodeUnchanged(manifest.sourceRevision,revision,runner);
}

export async function workerArtifactBundle(revision, runner = run, {
  manifestPath = path.join(ROOT,'releases','worker-native.json'),
  cacheRoot = path.join(ROOT,'build','worker-artifacts'),
} = {}) {
  const manifest = await workerArtifactManifest(manifestPath);
  if (!manifest) return null;
  if (manifest.paused === true) throw Object.assign(new Error('Automatisches Max-Monitor-Update angehalten; installierte App bleibt erhalten.'), {code:'MONITOR_RELEASE_PAUSED'});
  if (!await artifactMatchesSource(manifest,revision,runner)) return null;
  await fs.mkdir(cacheRoot,{recursive:true});
  const cache = path.join(cacheRoot,manifest.sha256);
  const zip = path.join(cache,manifest.asset);
  const bundle = path.join(cache,'Max Monitor.app');
  try { await fs.access(zip); } catch {
    const staging = await fs.mkdtemp(path.join(cacheRoot,'download-'));
    try {
      await runner('gh',['release','download',manifest.tag,'--repo','AurelianSteiner/Max-Monitor',
        '--pattern',manifest.asset,'--dir',staging],{label:'Repo-Download: Monitor-Release laden',timeout:180000});
      const archive = path.join(staging,manifest.asset);
      const size = (await fs.stat(archive)).size;
      if (size > 64*1024*1024 || createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== manifest.sha256)
        throw new Error('App-Signatur: Monitor-Release-Prüfsumme stimmt nicht.');
      await fs.rename(staging,cache);
    } finally { await fs.rm(staging,{recursive:true,force:true}); }
  }
  if (createHash('sha256').update(await fs.readFile(zip)).digest('hex') !== manifest.sha256)
    throw new Error('App-Signatur: Monitor-Release-Prüfsumme stimmt nicht.');
  // Materialize the verified archive again; a changed extracted cache is never trusted.
  await fs.rm(bundle,{recursive:true,force:true});
  await runner('/usr/bin/ditto',['-x','-k',zip,cache],{label:'Monitor-Release entpacken'});
  await runner('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{label:'App-Signatur prüfen'});
  // Reuse the Mac's existing local app signing identity, as the source build does.
  // The publisher's archive has already passed its pinned hash and signature checks.
  const identities = await runner('/usr/bin/security',['find-identity','-v','-p','codesigning'],{label:'Lokale App-Signatur lesen'});
  const local = identities.match(/\b([A-F0-9]{40}) "Claude Max Monitor Signing"/i);
  if (local) {
    await runner('/usr/bin/codesign',['--force','--deep','--sign',local[1],'--timestamp=none',
      '--preserve-metadata=entitlements,flags,runtime',bundle],{label:'App-Signatur mit vorhandener Mac-Identität versehen'});
    await runner('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{label:'App-Signatur prüfen'});
  }
  return bundle;
}

export async function preserveExistingSigningIdentity(installed, candidate, runner = run) {
  const read = async bundle => {
    const output = await runner('/usr/bin/codesign',['-d','-r-',bundle],
      {label:'Vorhandene App-Signieridentität prüfen'});
    const requirement = output.trim().match(/^(?:# )?designated => (.+)$/m)?.[1];
    if (!requirement) throw new Error('App-Signatur: Vorhandene Signieridentität nicht lesbar; installierte App bleibt erhalten.');
    return requirement;
  };
  const before = await read(installed), after = await read(candidate);
  if (!/\bcertificate\b/.test(before)) {
    if (/\bcertificate\b/.test(after))
      throw new Error('App-Signatur: Wechsel der vorhandenen Signieridentität nicht erlaubt; installierte App bleibt erhalten.');
    return;
  }
  // The installed app's own designated requirement binds its certificate, not
  // its human-readable label. A missing/expired local identity must never turn
  // the optional artifact re-sign into a silent switch to the publisher.
  try {
    await runner('/usr/bin/codesign',['--verify','--strict','-R','='+before,candidate],
      {label:'Bestehende App-Signieridentität erhalten'});
  } catch {
    throw new Error('App-Signatur: Vorhandene Signieridentität für das Update nicht bestätigt; installierte App bleibt erhalten.');
  }
}

export async function requireUnlockedLoginKeychain(runner = run) {
  let state;
  try {
    state = parseJson(await runner('/usr/bin/python3',['-c',
      '# monitor-keychain-state: metadata only; no credential, ACL, create or unlock API\n' +
      'import ctypes,json,pathlib\n' +
      'p=pathlib.Path.home()/"Library/Keychains/login.keychain-db"\n' +
      'if not p.exists(): p=pathlib.Path.home()/"Library/Keychains/login.keychain"\n' +
      'lib=ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")\n' +
      'ref=ctypes.c_void_p(); flags=ctypes.c_uint32()\n' +
      'lib.SecKeychainOpen.argtypes=[ctypes.c_char_p,ctypes.POINTER(ctypes.c_void_p)]\n' +
      'lib.SecKeychainGetStatus.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)]\n' +
      'opened=lib.SecKeychainOpen(str(p).encode(),ctypes.byref(ref)) if p.exists() else -1\n' +
      'status=lib.SecKeychainGetStatus(ref,ctypes.byref(flags)) if opened==0 else -1\n' +
      'print(json.dumps({"available":status==0,"unlocked":bool(flags.value&1) if status==0 else None}))\n'],
      {label:'Login-Schlüsselbundstatus prüfen',timeout:5000}), 'Login-Schlüsselbundstatus');
  } catch {
    throw Object.assign(new Error('Login-Schlüsselbundstatus nicht lesbar; installierte App bleibt unverändert. '
      + 'Vor dem App-Update den bestehenden Schlüsselbund am Mac regulär entsperren.'),{code:'MONITOR_KEYCHAIN_UNAVAILABLE'});
  }
  if (state.available !== true || typeof state.unlocked !== 'boolean')
    throw Object.assign(new Error('Login-Schlüsselbundstatus nicht bestätigt; installierte App bleibt unverändert.'),
      {code:'MONITOR_KEYCHAIN_UNAVAILABLE'});
  if (!state.unlocked)
    throw Object.assign(new Error('Login-Schlüsselbund gesperrt; installierte App bleibt unverändert. '
      + 'Vor dem App-Update am Mac regulär entsperren.'),{code:'MONITOR_KEYCHAIN_LOCKED'});
}

async function updateExistingMonitor(options, {worker, app, revision, release, releaseCurrent,
  receipt, receiptPath, runner, appReader, artifactReader, log, pause, now = Date.now}) {
  if (!app) throw new Error('Kein eingerichteter Monitor vorhanden – zuerst die Worker-Einrichtung ausführen.');
  // Background maintenance must never launch the credential-reading native CLI.
  // The running GUI owns Keychain access and reports its authenticated heartbeat.
  let before = options.codeOnly ? null : await storedMonitorPreferences(options.bundleId,runner);
  // Updating an existing bundle does not require an account or change its binding.
  // Missing cached preferences must not disable future native code updates.
  const recorded = receipt?.binarySourceRevision || receipt?.sourceRevision;
  const sameCode = receipt?.sourceRevision === revision || await nativeCodeUnchanged(recorded,revision,runner);
  const sameVersion = !releaseCurrent || app.version.split('+')[0] === release.version;
  const writeReceipt = async (binarySourceRevision, installed, failure) => {
    await fs.mkdir(path.dirname(receiptPath),{recursive:true,mode:0o700});
    // A failed build keeps the last confirmed source, so the next run never
    // mistakes the unbuilt revision for the installed app.
    const safe = {schema:1,maintenanceVersion:failure ? receipt?.maintenanceVersion : 1,
      sourceRevision:failure ? receipt?.sourceRevision : revision,binarySourceRevision,appVersion:app.version,
      appPath:options.appPath,...(before ? {workerId:before.workerId || worker.workerId,deviceId:before.deviceId,
        serverURL:before.serverURL,teamId:before.teamId,bindingVerification:'preferences_preserved'} : {
        bindingVerification:'required',
        ...Object.fromEntries(['workerId','deviceId','serverURL','teamId'].filter(key => receipt?.[key] != null)
          .map(key => [key,receipt[key]]))}),checkedAt:new Date(now()).toISOString(),
      installedAt:installed ? new Date(now()).toISOString() : receipt?.installedAt,
      ...(failure ? {buildFailure:failure} : {}),
      ...(receipt?.lastFailure && typeof receipt.lastFailure === 'object' ? {lastFailure:failure ? receipt.lastFailure
        : {...receipt.lastFailure,recoveredAt:receipt.lastFailure.recoveredAt || new Date(now()).toISOString()}} : {})};
    const temporary = receiptPath + '.tmp';
    await fs.writeFile(temporary,JSON.stringify(safe,null,2)+'\n',{mode:0o600});
    await fs.rename(temporary,receiptPath);
  };
  if (!options.appBundle && sameCode && sameVersion) {
    await runner('/usr/bin/codesign',['--verify','--deep','--strict',options.appPath],{label:'App-Signatur prüfen'});
    if (options.open) {
      // One migration restart clears GUI processes left waiting by the old CLI probes.
      // Subsequent minute checks keep the resident credential owner running.
      if (receipt?.maintenanceVersion !== 1) {
        await requireUnlockedLoginKeychain(runner);
        await stopMonitorApps(options.bundleId,runner,pause,undefined,true);
      }
      await openMonitorApp(options.appPath,options.bundleId,runner,pause);
    }
    await writeReceipt(recorded,false);
    log(before ? 'Max Monitor ist aktuell; die vorhandenen Einstellungen bleiben erhalten.'
      : 'Max Monitor ist aktuell; bestehende Verbindung in der laufenden App noch prüfen.');
    return {schema:1,mode:'existing',...(before || {bindingVerification:'required'})};
  }
  // A locked keychain also prevents a usable signed replacement. Do not spend
  // CPU on a native build/download that cannot be installed; recheck at swap.
  await requireUnlockedLoginKeychain(runner);
  let bundle = options.appBundle;
  const artifact = !bundle ? await artifactReader(revision,runner) : null;
  bundle ||= artifact;
  if (!bundle) {
    // Back-off: the same native code with the same compiler failed recently.
    // The installed app stays as it is; the reason stays build_failed.
    const nativeKey = await nativeSourceKey(revision,runner);
    const swiftcVersion = await swiftToolchain(runner);
    const failed = receipt?.buildFailure, failedAt = Date.parse(failed?.at);
    if (nativeKey && failed?.nativeKey === nativeKey && failed.swiftcVersion === swiftcVersion &&
        Number.isFinite(failedAt) && now() - failedAt >= 0 && now() - failedAt < BUILD_RETRY_MS) {
      // A deliberate deferral, not a failure (A14-02, Fehleraudit 17.10.2026): no
      // error exit, so the minute check does not report an error for six hours.
      // RS-Skills reads the JSON result; the reason stays build_failed.
      const retryAt = new Date(failedAt + BUILD_RETRY_MS).toISOString();
      log(`Max Monitor bauen zurückgestellt: derselbe native Stand ist mit diesem Swift-Compiler um ${new Date(failedAt).toISOString()} fehlgeschlagen${failed.cause ? ` (${failed.cause})` : ''}; neuer Versuch ab ${retryAt}, mit neuem Code oder neuem Compiler früher. Die installierte App bleibt unverändert.`);
      return {schema:1,mode:'deferred',deferred:true,reason:'build_failed',failedAt:new Date(failedAt).toISOString(),retryAt,
        ...(typeof failed.cause === 'string' ? {cause:failed.cause} : {})};
    }
    log('Max Monitor: aktuelle App aus dem Repo bauen.');
    try { bundle = await buildApp(runner, options); }
    catch (error) {
      if (nativeKey) await writeReceipt(recorded,false,{nativeKey,swiftcVersion,at:new Date(now()).toISOString(),
        ...(typeof error.buildCause === 'string' ? {cause:error.buildCause} : {})}).catch(()=>{});
      throw error;
    }
  }
  const built = await appReader(bundle,runner,options.bundleId);
  if (!built) throw new Error('App-Version: Die aktuelle Monitor-App ist ungültig.');
  if (artifact && releaseCurrent && built.version !== release.version)
    throw new Error('App-Version: Die Monitor-Release-Version stimmt nicht.');
  await requireUnlockedLoginKeychain(runner);
  await preserveExistingSigningIdentity(options.appPath,bundle,runner);
  const original = await runningMonitorApps(options.bundleId,runner);
  let install;
  try {
    await stopMonitorApps(options.bundleId,runner,pause,original,true);
    // Shutdown can flush settings changed by the resident GUI. Preserve that
    // durable snapshot rather than treating its own flush as an installer write.
    if (!options.codeOnly) before = await storedMonitorPreferences(options.bundleId,runner);
    install = await installBundle(bundle,options.appPath,runner);
    app = await appReader(options.appPath,runner,options.bundleId);
    if (!app || app.version !== built.version) throw new Error('App-Version: Installierte Monitor-App stimmt nicht.');
    const after = options.codeOnly ? null : await storedMonitorPreferences(options.bundleId,runner);
    if (before && ['deviceId','serverURL','teamId','workerId','memberId','role'].some(key => after[key] !== before[key]))
      throw new Error('Bestehender älterer Monitor-Zugang nach dem Update nicht vollständig bestätigt.');
    if (options.open) await openMonitorApp(options.appPath,options.bundleId,runner,pause);
    await writeReceipt(artifact && releaseCurrent ? release.sourceRevision : revision,true);
    await install.finish().catch(()=>{});
    log(after ? 'Max Monitor aktualisiert; die vorhandenen Einstellungen bleiben erhalten.'
      : 'Max Monitor App-Code aktualisiert; Bindung noch nicht bestätigt. Bestehende Verbindung in der laufenden App prüfen.');
    return {schema:1,mode:'installed',...(after || {bindingVerification:'required'})};
  } catch (error) {
    if (install) await stopMonitorApps(options.bundleId,runner,pause);
    await install?.rollback();
    await restoreMonitorApps(original,options.bundleId,runner);
    throw error;
  }
}

function defaultReceiptPath(options) {
  return path.join(os.homedir(), 'Library', 'Application Support',
    options.bundleId && options.bundleId !== BUNDLE_ID ? options.bundleId : 'Max Monitor', 'Worker Setup', 'installation.json');
}

// Every failed background update (--update-only) keeps its cause in the receipt,
// from the worker profile and release manifest on, not only failures of the app
// update itself: the sporadic Mac 5 failures had no build failure (A14-02,
// Fehleraudit 17.10.2026). An interactive enrollment never records one.
export async function setup(options, dependencies = {}) {
  if (!options.updateOnly || options.dryRun) return setupSteps(options, dependencies);
  const receiptPath = dependencies.receiptPath ?? defaultReceiptPath(options);
  const now = dependencies.now ?? Date.now;
  try { return await setupSteps(options, {...dependencies, receiptPath}); }
  catch (error) {
    await recordUpdateFailure(receiptPath, error, new Date(now()).toISOString()).catch(()=>{});
    throw error;
  }
}

async function setupSteps(options, { runner = run, workerReader = readWorker,
  appReader = appInformation, artifactReader = workerArtifactBundle, manifestReader = workerArtifactManifest,
  platform = process.platform, log = console.log, pause = delay, now = Date.now,
  receiptPath = defaultReceiptPath(options) } = {}) {
  if (platform !== 'darwin' && !options.dryRun) throw new Error('Max Monitor benötigt macOS.');
  const worker = await workerReader(options);
  if (options.dryRun) return {schema:1,mode:'dry-run',workerId:worker.workerId,
    appPath:options.appPath,hubHost:worker.hubHost,
    steps:['App installieren','Eigenen Mitglieds-Token über Hub beziehen','Team und Worker-ID speichern','Autostart aktivieren','App öffnen']};
  const revision = await sourceRevision(runner);
  const release = options.updateOnly && !options.appBundle ? await manifestReader() : null;
  // Stop the automatic path before any artifact/source comparison, fallback
  // build, preference/credential read or app action. Explicit local canary
  // bundles still go through their normal identity and installation guards.
  if (release?.paused === true) {
    log('Automatisches Max-Monitor-Update angehalten; installierte App bleibt erhalten.');
    return {schema:1,mode:'deferred',deferred:true,reason:'release_paused'};
  }
  const releaseCurrent = release ? await artifactMatchesSource(release,revision,runner) : false;
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); } catch {}
  let app = await appReader(options.appPath, runner, options.bundleId, options.updateOnly);
  if (!app && options.updateOnly) {
    const running = await runningMonitorApps(options.bundleId, runner);
    const paths = [...new Set(running.map(value => value.bundlePath))];
    if (paths.length > 1) throw new Error('Mehrere Monitor-Installationen laufen – App-Pfad zuerst eindeutig festlegen.');
    for (const candidate of [...paths, '/Applications/Max Monitor.app']) {
      const found = await appReader(candidate, runner, options.bundleId, true);
      if (found) { options = {...options, appPath:candidate}; app = found; break; }
    }
  }
  if (options.updateOnly) return updateExistingMonitor(options,{worker,app,revision,release,releaseCurrent,
    receipt,receiptPath,runner,appReader,artifactReader,log,pause,now});
  let initialStatus = null;
  if (app && !app.legacy) {
    try { initialStatus = await appStatus(app, true, runner); } catch {
      try { initialStatus = await appStatus(app, false, runner); } catch (error) {
        if (!options.updateOnly) throw error;
        // An older/broken status CLI is inspected with the new binary before replacement.
        app = {...app,legacy:true};
      }
    }
    if (initialStatus) {
    if (!options.updateOnly && initialStatus.configured && initialStatus.role && initialStatus.role !== 'member')
      throw new Error('Dieser Monitor nutzt bereits einen Inhaber- oder Admin-Zugang. Bestehende Verbindung zuerst in der App prüfen.');
    if (options.check) {
      if (!healthy(initialStatus, worker)) throw new Error('Monitor ist noch nicht vollständig mit diesem Worker verbunden.');
      if (receipt?.sourceRevision !== revision) throw new Error('Die Monitor-App muss auf die aktuelle Repo-Version aktualisiert werden.');
      return {schema:1,mode:'check',...startupSummary(initialStatus, options.launchAtLogin, null)};
    }
    // Never take over an existing owner/personal connection or another worker.
    if (!options.updateOnly && initialStatus.configured && !initialStatus.workerId)
      throw new Error('Dieser Monitor hat noch keine Worker-Kennung – vorhandenen Zugang prüfen.');
    if (initialStatus.configured && (initialStatus.workerId || !options.updateOnly) && initialStatus.workerId !== worker.workerId)
      throw new Error('Dieser Monitor gehört bereits zu einer anderen Einrichtung. Verbindung zuerst in der App prüfen.');
    }
  } else if (options.check) throw new Error('Die neue Max-Monitor-Version ist noch nicht installiert.');
  if (options.updateOnly && (!app || (!app.legacy && !initialStatus?.configured)))
    throw new Error('Kein eingerichteter Monitor vorhanden – zuerst die Worker-Einrichtung ausführen.');
  const connected = Boolean(app) && (options.updateOnly
    ? initialStatus?.verified === true && initialStatus?.fleetAvailable === true
    : healthy(initialStatus, worker));
  if (app && connected && !options.appBundle && (!releaseCurrent || app.version === release.version) &&
      (receipt?.sourceRevision === revision ||
      await nativeCodeUnchanged(receipt?.sourceRevision, revision, runner))) {
    if (receipt.sourceRevision !== revision) {
      const updated = {...receipt,sourceRevision:revision,
        binarySourceRevision:receipt.binarySourceRevision || receipt.sourceRevision,checkedAt:new Date().toISOString()};
      const temporary = receiptPath + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(updated,null,2)+'\n',{mode:0o600});
      await fs.rename(temporary,receiptPath);
    }
    log('Max Monitor ist bereits mit diesem Worker verbunden.');
    if (options.open) await openMonitorApp(options.appPath, options.bundleId, runner, pause);
    return {schema:1,mode:'existing',...startupSummary(initialStatus, options.launchAtLogin, log)};
  }
  // Detect a missing/unupgraded central service before an expensive local build.
  if (!options.updateOnly) {
  await fs.access(worker.identityFile); await fs.access(worker.knownHostsFile);
  log('Max Monitor: zentralen Hub prüfen.');
  const preflight = parseJson(await runner('ssh', hubArguments(worker, options, true), {label:'Hub-Konfiguration prüfen'}), 'Hub-Prüfung');
  if (preflight.ok !== true || preflight.schema !== 1) throw new Error('Max Monitor ist auf dem Hub noch nicht bereitgestellt.');
  }
  let bundle = options.appBundle;
  const artifact = !bundle && options.updateOnly ? await artifactReader(revision,runner) : null;
  bundle ||= artifact;
  if (!bundle) {
    log('Max Monitor: aktuelle App aus dem Repo bauen.');
    bundle = await buildApp(runner, options);
  }
  const built = await appReader(bundle, runner, options.bundleId);
  if (!built) throw new Error('Die App unterstützt die automatische Worker-Einrichtung noch nicht.');
  if (artifact && built.version !== release.version) throw new Error('App-Version: Die Monitor-Release-Version stimmt nicht.');
  if (options.updateOnly && app?.legacy) {
    // Only non-secret preferences are read before replacement. Source-path binaries
    // have a different Keychain access context from the registered installed app.
    initialStatus = await storedMonitorPreferences(options.bundleId,runner);
    if (initialStatus.configured !== true ||
        (initialStatus.workerId && initialStatus.workerId !== worker.workerId))
      throw new Error('Bestehender älterer Monitor-Zugang nicht vollständig bestätigt – App bleibt erhalten.');
  }
  const stoppedApps = await runningMonitorApps(options.bundleId, runner);
  let install;
  try {
    await stopMonitorApps(options.bundleId, runner, pause, stoppedApps);
    install = await installBundle(bundle, options.appPath, runner);
    app = await appReader(options.appPath, runner, options.bundleId);
    const identity = await appStatus(app, false, runner, 180000);
    // An older app had no status command; inspect its preserved preferences only after upgrading.
    if (!options.updateOnly && identity.configured && identity.role && identity.role !== 'member')
      throw new Error('Dieser Monitor nutzt bereits einen Inhaber- oder Admin-Zugang. Bestehende Verbindung zuerst in der App prüfen.');
    if (identity.configured && (identity.workerId || !options.updateOnly) && identity.workerId !== worker.workerId)
      throw new Error('Dieser Monitor gehört bereits zu einer anderen Einrichtung. Verbindung zuerst in der App prüfen.');
    if (!/^[0-9a-f-]{36}$/i.test(identity.deviceId)) throw new Error('Keine gültige Mac-Kennung verfügbar.');
    let verified;
    if (options.updateOnly) {
      verified = await appStatus(app, true, runner, 180000);
      const keys = ['deviceId','serverURL','teamId','workerId','memberId','role'];
      if (verified.configured !== true || verified.verified !== true || verified.fleetAvailable !== true ||
          keys.some(key => verified[key] !== initialStatus[key]))
        throw new Error('Bestehender älterer Monitor-Zugang nach dem Update nicht vollständig bestätigt.');
    } else {
    const request = {workerId:worker.workerId,deviceId:identity.deviceId,name:os.hostname()};
    const enrollment = validateEnrollment(parseJson(await runner('ssh', hubArguments(worker,options), {
      input:JSON.stringify(request),label:'Eigenen Monitor-Zugang einrichten'}), 'Hub-Registrierung'),
      worker.workerId,identity.deviceId,options.allowLoopback);
    let loginTimedOut = false;
    try {
      parseJson(await runner(app.executable,['--enroll'],{
        input:JSON.stringify({...enrollment,launchAtLogin:options.launchAtLogin}),timeout:60000,
        onProgress:stage => log(`Max Monitor: ${ENROLLMENT_STAGES[stage]}.`),
        progressTimeouts:{relay:35000,credentials:180000,settings:15000,login:15000,complete:15000},
        label:'Monitor-Verbindung speichern'}),'Monitor-Einrichtung');
    } catch (error) {
      // Autostart runs after durable credential/settings writes. Recheck those writes
      // instead of rolling back a valid connection merely because macOS stalled here.
      if (!error.timedOut || error.stage !== 'login') throw error;
      loginTimedOut = true;
    }
    verified = await appStatus(app,true,runner);
    if (!healthy(verified,worker) || (loginTimedOut &&
        ['deviceId','serverURL','teamId','memberId'].some(key => verified[key] !== enrollment[key])))
      throw new Error('Monitor wurde gespeichert, aber der gemeinsame Server ist noch nicht erreichbar.');
    if (loginTimedOut) log('Max Monitor: Autostart hat zu lange gedauert; die gespeicherte Geräteverbindung wurde separat bestätigt.');
    }
    if (options.open) await openMonitorApp(options.appPath, options.bundleId, runner, pause);
    await fs.mkdir(path.dirname(receiptPath),{recursive:true,mode:0o700});
    const safeReceipt = {schema:1,sourceRevision:revision,appPath:options.appPath,
      workerId:worker.workerId,deviceId:verified.deviceId,serverURL:verified.serverURL,teamId:verified.teamId,installedAt:new Date().toISOString()};
    await fs.writeFile(receiptPath,JSON.stringify(safeReceipt,null,2)+'\n',{mode:0o600});
    // Cleanup must never undo an already configured and verified installation.
    await install.finish().catch(()=>{});
    log('Max Monitor ist verbunden; Geräteberichte laufen jede Minute.');
    const startup = startupSummary(verified, options.launchAtLogin, log);
    log('Das eigene Claude-Konto einmal in Max Monitor anmelden, damit dessen Kontingente erscheinen.');
    return {schema:1,mode:'installed',...startup};
  } catch (error) {
    if (install) {
      // Never remove a bundle while its newly launched process still runs.
      try { await stopMonitorApps(options.bundleId, runner, pause); }
      catch { throw new Error('Laufende Monitor-App lässt sich nicht schließen. Installation wurde beibehalten; App schließen und Setup erneut ausführen.'); }
    }
    await install?.rollback();
    await restoreMonitorApps(stoppedApps, options.bundleId, runner);
    throw error;
  }
}

async function defaultObserver(options) {
  const { ensureWorkerObserver } = await import('./install-worker-observer.mjs');
  return ensureWorkerObserver(options, { runner: run });
}

// A deferred build (mode 'deferred') is no failure: exit 0 and one JSON line on
// stdout ({deferred:true, reason:'build_failed', failedAt, retryAt, cause}).
export async function main(args = process.argv.slice(2), { setupImpl = setup, observerImpl = defaultObserver,
  out = value => console.log(value), err = value => console.error(value) } = {}) {
  try {
    const options = optionsFrom(args);
    if (options.help) {
      out('Max Monitor automatisch für diesen Newsletter-Worker einrichten.\n' +
        'setup-mac-monitor.sh --worker-root PATH [--check | --dry-run | --update-only]\n' +
        'Optional: --app-bundle PATH --app-path PATH --no-open --no-launch-at-login\n' +
        '--update-only --code-only: nur vorhandene App austauschen; Verbindung danach in der laufenden App prüfen.\n' +
        'Server und eigener Mitglieds-Token kommen über den bestehenden Hub-Zugang.');
      return;
    }
    const result = await setupImpl(options);
    if (!options.check && !options.dryRun && !options.codeOnly) {
      const observer = await observerImpl(options);
      if (observer.installed) out('Worker-Beobachter aktiv; direkte Meldungen alle 15 Sekunden, Wartung jede Minute.');
    }
    if (options.check && result.loginActionRequired) err(result.loginHint);
    if (options.check || options.dryRun || options.codeOnly || result?.deferred === true) out(JSON.stringify(result));
  } catch (error) { err(`Max Monitor: ${error.message}`); process.exitCode = 1; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
