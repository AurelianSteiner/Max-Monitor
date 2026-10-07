#!/usr/bin/env node
// Enrollment secrets travel only over SSH and child stdin. Never argv or logs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'xyz.fi5h.Usage4Claude';
const DEFAULT_HELPER = '/opt/max-monitor/scripts/enroll-monitor-worker.mjs';

export function optionsFrom(args) {
  const result = { workerRoot: path.join(os.homedir(), 'Documents', 'AI Newsletter Creation'),
    appPath: path.join(os.homedir(), 'Applications', 'Max Monitor.app'),
    hubHelper: DEFAULT_HELPER, bundleId:BUNDLE_ID, check: false, dryRun: false, open: true,
    launchAtLogin: true, allowLoopback: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--check') result.check = true;
    else if (argument === '--dry-run') result.dryRun = true;
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

export function run(command, args, { input, env = process.env, cwd, timeout = 45000,
  label = path.basename(command), outputLimit = 128 * 1024, inherit = false,
  onProgress, progressTimeouts = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false,
      stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'] });
    let stdout = '', tooLarge = false, timedOut = false, stderrBuffer = '', stage = null;
    const stages = Object.keys(ENROLLMENT_STAGES);
    const expire = () => { timedOut = true; child.kill('SIGKILL'); };
    let timer = setTimeout(expire, timeout);
    child.stdout?.on('data', chunk => {
      if (Buffer.byteLength(stdout) + chunk.length > outputLimit) { tooLarge = true; child.kill('SIGKILL'); }
      else stdout += chunk;
    });
    // Raw stderr stays private. Accept only fixed, forward-moving native phase markers.
    child.stderr?.on('data', chunk => {
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
        reject(Object.assign(new Error(`${label} fehlgeschlagen (${reason}).`), { timedOut, stage, exitCode:code }));
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
  const configFile = path.join(options.workerRoot, 'config', 'worker.local.json');
  const { loadConfig } = require(path.join(options.workerRoot, 'src', 'config.js'));
  const config = loadConfig(configFile, { root: options.workerRoot });
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(config.worker_id)) throw new Error('Eine eindeutige Worker-ID fehlt. Newsletter-Setup zuerst ausführen.');
  const hub = config.hub;
  if (!/^[A-Za-z0-9_.@:-]+$/.test(hub.ssh_host)) throw new Error('Ungültiger Hub-Host.');
  return { workerId: config.worker_id, hubHost: hub.ssh_host,
    identityFile: homePath(hub.identity_file), knownHostsFile: hub.known_hosts_file };
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

export async function appInformation(appPath, runner = run, expectedBundleId = BUNDLE_ID) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  try { await fs.access(plist); } catch { return null; }
  const info = parseJson(await runner('/usr/bin/python3', ['-c',
    'import plistlib,json,sys; d=plistlib.load(open(sys.argv[1],"rb")); print(json.dumps({k:d.get(k) for k in ["CFBundleIdentifier","CFBundleExecutable","RSWorkerEnrollmentVersion"]}))', plist],
    {label:'App-Version prüfen'}), 'App-Version');
  if (info.CFBundleIdentifier !== expectedBundleId || info.RSWorkerEnrollmentVersion !== 1 ||
      !/^[A-Za-z0-9_-]+$/.test(info.CFBundleExecutable || '')) return null;
  return { executable: path.join(appPath, 'Contents', 'MacOS', info.CFBundleExecutable) };
}

export async function appStatus(app, verify = false, runner = run) {
  const value = parseJson(await runner(app.executable, ['--enrollment-status', ...(verify ? ['--verify'] : [])],
    {label: verify ? 'Monitor-Verbindung prüfen' : 'Mac-Kennung lesen', timeout:45000}), 'Monitor-Status');
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
  if (action !== 'inventory' && action !== 'terminate') throw new Error('Invalid process action');
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  var result = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var value = {pid:Number(app.processIdentifier), bundleId:ObjC.unwrap(app.bundleIdentifier),
      bundlePath:ObjC.unwrap(app.bundleURL.path), executablePath:ObjC.unwrap(app.executableURL.path)};
    if (action === 'terminate') value.terminationRequested = Boolean(app.terminate);
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

export async function stopMonitorApps(bundleId, runner = run, pause = delay, knownApps) {
  const original = knownApps || await runningMonitorApps(bundleId, runner);
  if (!original.length) return [];
  await runningMonitorApps(bundleId, runner, 'terminate');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await runningMonitorApps(bundleId, runner)).length) return original;
    await pause(250);
  }
  throw new Error('Monitor ist noch geöffnet. App schließen und Setup erneut ausführen.');
}

export async function openMonitorApp(appPath, bundleId, runner = run, pause = delay) {
  const intended = await fs.realpath(appPath);
  const isIntended = app => app.bundlePath === intended &&
    app.executablePath.startsWith(path.join(intended,'Contents','MacOS') + path.sep);
  const active = await runningMonitorApps(bundleId, runner);
  if (active.length === 1 && isIntended(active[0])) return active[0];
  if (active.length) await stopMonitorApps(bundleId, runner, pause, active);
  await runner('/usr/bin/open', ['-g','-n',appPath], {label:'Max Monitor öffnen'});
  for (let attempt = 0; attempt < 20; attempt++) {
    const launched = await runningMonitorApps(bundleId, runner);
    if (launched.length === 1 && isIntended(launched[0])) return launched[0];
    await pause(250);
  }
  throw new Error('Die neu installierte Monitor-App läuft noch nicht. App öffnen und Setup erneut prüfen.');
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

export async function setup(options, { runner = run, workerReader = readWorker,
  appReader = appInformation, platform = process.platform, log = console.log, pause = delay,
  receiptPath = path.join(os.homedir(), 'Library', 'Application Support',
    options.bundleId && options.bundleId !== BUNDLE_ID ? options.bundleId : 'Max Monitor', 'Worker Setup', 'installation.json') } = {}) {
  if (platform !== 'darwin' && !options.dryRun) throw new Error('Max Monitor benötigt macOS.');
  const worker = await workerReader(options);
  if (options.dryRun) return {schema:1,mode:'dry-run',workerId:worker.workerId,
    appPath:options.appPath,hubHost:worker.hubHost,
    steps:['App installieren','Eigenen Mitglieds-Token über Hub beziehen','Team und Worker-ID speichern','Autostart aktivieren','App öffnen']};
  const revision = await sourceRevision(runner);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); } catch {}
  let app = await appReader(options.appPath, runner, options.bundleId);
  let initialStatus = null;
  if (app) {
    try { initialStatus = await appStatus(app, true, runner); } catch { initialStatus = await appStatus(app, false, runner); }
    if (initialStatus.configured && initialStatus.role && initialStatus.role !== 'member')
      throw new Error('Dieser Monitor nutzt bereits einen Inhaber- oder Admin-Zugang. Bestehende Verbindung zuerst in der App prüfen.');
    if (options.check) {
      if (!healthy(initialStatus, worker)) throw new Error('Monitor ist noch nicht vollständig mit diesem Worker verbunden.');
      if (receipt?.sourceRevision !== revision) throw new Error('Die Monitor-App muss auf die aktuelle Repo-Version aktualisiert werden.');
      return {schema:1,mode:'check',...startupSummary(initialStatus, options.launchAtLogin, null)};
    }
    // Never take over an existing owner/personal connection or another worker.
    if (initialStatus.configured && initialStatus.workerId !== worker.workerId)
      throw new Error('Dieser Monitor gehört bereits zu einer anderen Einrichtung. Verbindung zuerst in der App prüfen.');
  } else if (options.check) throw new Error('Die neue Max-Monitor-Version ist noch nicht installiert.');
  if (app && healthy(initialStatus, worker) && receipt?.sourceRevision === revision && !options.appBundle) {
    log('Max Monitor ist bereits mit diesem Worker verbunden.');
    if (options.open) await openMonitorApp(options.appPath, options.bundleId, runner, pause);
    return {schema:1,mode:'existing',...startupSummary(initialStatus, options.launchAtLogin, log)};
  }
  // Detect a missing/unupgraded central service before an expensive local build.
  await fs.access(worker.identityFile); await fs.access(worker.knownHostsFile);
  log('Max Monitor: zentralen Hub prüfen.');
  const preflight = parseJson(await runner('ssh', hubArguments(worker, options, true), {label:'Hub-Konfiguration prüfen'}), 'Hub-Prüfung');
  if (preflight.ok !== true || preflight.schema !== 1) throw new Error('Max Monitor ist auf dem Hub noch nicht bereitgestellt.');
  let bundle = options.appBundle;
  if (!bundle) {
    log('Max Monitor: aktuelle App aus dem Repo bauen.');
    await runner('/bin/bash', [path.join(ROOT, 'scripts','build_without_xcode.sh')], {
      cwd:ROOT, env:{...process.env,U4C_PRODUCT_NAME:'Max Monitor',U4C_BUNDLE_ID:options.bundleId,U4C_APPCAST_URL:''},
      timeout:15*60000, inherit:true, label:'Max Monitor bauen',
    });
    bundle = path.join(ROOT,'build','no-xcode','Max Monitor.app');
  }
  const built = await appReader(bundle, runner, options.bundleId);
  if (!built) throw new Error('Die App unterstützt die automatische Worker-Einrichtung noch nicht.');
  const stoppedApps = await runningMonitorApps(options.bundleId, runner);
  let install;
  try {
    await stopMonitorApps(options.bundleId, runner, pause, stoppedApps);
    install = await installBundle(bundle, options.appPath, runner);
    app = await appReader(options.appPath, runner, options.bundleId);
    const identity = await appStatus(app, false, runner);
    // An older app had no status command; inspect its preserved preferences only after upgrading.
    if (identity.configured && identity.role && identity.role !== 'member')
      throw new Error('Dieser Monitor nutzt bereits einen Inhaber- oder Admin-Zugang. Bestehende Verbindung zuerst in der App prüfen.');
    if (identity.configured && identity.workerId !== worker.workerId)
      throw new Error('Dieser Monitor gehört bereits zu einer anderen Einrichtung. Verbindung zuerst in der App prüfen.');
    if (!/^[0-9a-f-]{36}$/i.test(identity.deviceId)) throw new Error('Keine gültige Mac-Kennung verfügbar.');
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
    const verified = await appStatus(app,true,runner);
    if (!healthy(verified,worker) || (loginTimedOut &&
        ['deviceId','serverURL','teamId','memberId'].some(key => verified[key] !== enrollment[key])))
      throw new Error('Monitor wurde gespeichert, aber der gemeinsame Server ist noch nicht erreichbar.');
    if (loginTimedOut) log('Max Monitor: Autostart hat zu lange gedauert; die gespeicherte Geräteverbindung wurde separat bestätigt.');
    if (options.open) await openMonitorApp(options.appPath, options.bundleId, runner, pause);
    await fs.mkdir(path.dirname(receiptPath),{recursive:true,mode:0o700});
    const safeReceipt = {schema:1,sourceRevision:revision,appPath:options.appPath,
      workerId:worker.workerId,deviceId:verified.deviceId,serverURL:verified.serverURL,teamId:verified.teamId,installedAt:new Date().toISOString()};
    await fs.writeFile(receiptPath,JSON.stringify(safeReceipt,null,2)+'\n',{mode:0o600});
    // Cleanup must never undo an already configured and verified installation.
    await install.finish().catch(()=>{});
    log('Max Monitor ist verbunden; Geräteberichte laufen alle zehn Minuten.');
    const startup = startupSummary(verified, options.launchAtLogin, log);
    log('Das eigene Claude-Konto einmal in Max Monitor anmelden, damit dessen Kontingente erscheinen.');
    return {schema:1,mode:'installed',...startup};
  } catch (error) {
    if (install) {
      // Never remove a bundle while its newly launched process still runs.
      try { await stopMonitorApps(options.bundleId, runner, pause); }
      catch { throw new Error('Monitor ist noch geöffnet. Installation wurde beibehalten; App schließen und Setup erneut ausführen.'); }
    }
    await install?.rollback();
    await restoreMonitorApps(stoppedApps, options.bundleId, runner);
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = optionsFrom(args);
    if (options.help) {
      console.log('Max Monitor automatisch für diesen Newsletter-Worker einrichten.\n' +
        'setup-mac-monitor.sh --worker-root PATH [--check | --dry-run]\n' +
        'Optional: --app-bundle PATH --app-path PATH --no-open --no-launch-at-login\n' +
        'Server und eigener Mitglieds-Token kommen über den bestehenden Hub-Zugang.');
      return;
    }
    const result = await setup(options);
    if (options.check && result.loginActionRequired) console.error(result.loginHint);
    if (options.check || options.dryRun) console.log(JSON.stringify(result));
  } catch (error) { console.error(`Max Monitor: ${error.message}`); process.exitCode = 1; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
