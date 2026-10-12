#!/usr/bin/env node
// Independent launchd SSH transport; never restarts or modifies a newsletter run.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readWorker, run } from './setup-mac-monitor.mjs';
import { publicKey, validateEntry, WORKER_ID } from './worker-remote-hub.mjs';

const LABEL = 'de.rs.max-monitor.remote';
const HELPER = 'node /opt/max-monitor/scripts/worker-remote-hub.mjs --stdin';
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = v => "'" + String(v).replace(/'/g, "'\\''") + "'";

export function hubArgs(worker) {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(worker.hubHost)) throw new Error('Ungültiger Hub.');
  return ['-i', worker.identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile="${worker.knownHostsFile}"`, '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
}

export function tunnelArgs(worker, entry) {
  validateEntry(entry);
  return [...hubArgs(worker), '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-R', `127.0.0.1:${entry.port}:127.0.0.1:22`, worker.hubHost];
}

export function launchAgent(worker, entry, log) {
  const args = ['/usr/bin/ssh', ...tunnelArgs(worker, entry)].map(v => `<string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;
}

export function authorizedLine(operatorKey, workerId) {
  if (!WORKER_ID.test(workerId || '')) throw new Error('Ungültige Worker-ID.');
  return `from="127.0.0.1,::1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${publicKey(operatorKey)} max-monitor-remote-${workerId}`;
}

export function updateAuthorized(existing, line, previous) {
  const lines = existing.split('\n').filter(value => value !== previous && value !== line);
  while (lines.at(-1) === '') lines.pop();
  if (line) lines.push(line);
  return lines.length ? lines.join('\n') + '\n' : '';
}

export async function writePrivate(file, value) {
  try { if (!(await fs.lstat(file)).isFile()) throw new Error('Datei ist keine reguläre Datei: ' + file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + `.tmp-${process.pid}`;
  try { await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function readable(file) {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('Datei ist keine reguläre Datei: ' + file);
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export async function discoverRoot({ home = os.homedir(), exec = execFileSync } = {}) {
  try {
    const plist = JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(home, 'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const entry = plist.ProgramArguments?.find(v => typeof v === 'string' && v.endsWith('/src/cli.js'));
    if (entry) return path.dirname(path.dirname(entry));
  } catch {}
  for (const root of [path.join(home, '.local/share/ai-newsletter-production'), path.join(home, 'Documents/AI Newsletter Creation')]) {
    try { await fs.access(path.join(root, 'config/worker.local.json')); return root; } catch {}
  }
  throw new Error('Aktiver Newsletter-Worker nicht gefunden; --worker-root angeben.');
}

async function localSshReady() {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 22 });
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', () => { socket.destroy(); reject(new Error('macOS-Fernanmeldung fehlt. Systemeinstellungen → Allgemein → Teilen → Entfernte Anmeldung einschalten und diesen Benutzer zulassen.')); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Lokaler SSH-Dienst antwortet nicht.')); });
  });
}

export async function hubRequest(worker, body, execute = run) {
  const value = JSON.parse(await execute('/usr/bin/ssh', [...hubArgs(worker), worker.hubHost, HELPER], { input: JSON.stringify(body), timeout: 20000 }));
  const entry = validateEntry(value);
  if (value.schema !== 1 || entry.workerId !== body.workerId) throw new Error('Hub-Antwort passt nicht zum angefragten Mac.');
  return { ...entry, ...(value.operatorKey ? { operatorKey: publicKey(value.operatorKey) } : {}) };
}

export async function localHostKey(file, execute = run) {
  try { return publicKey((await fs.readFile(file, 'utf8')).trim()); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // macOS generates host keys lazily on the first sshd connection. Complete
    // a local SSH handshake rather than assuming a TCP listener has done so.
    const scanned = await execute('/usr/bin/ssh-keyscan', ['-T', '5', '-t', 'ed25519', '127.0.0.1']);
    const keys = [...new Set(scanned.split('\n').filter(line => line.startsWith('127.0.0.1 ssh-ed25519 '))
      .map(line => publicKey(line.slice('127.0.0.1 '.length))))];
    if (keys.length !== 1) throw new Error('Lokaler SSH-Hostschlüssel konnte nicht eindeutig geprüft werden.');
    return keys[0];
  }
}

export async function install(worker, { home = os.homedir(), username = os.userInfo().username, uid = process.getuid(), execute = run,
  preflight = localSshReady, hostKeyFile = '/etc/ssh/ssh_host_ed25519_key.pub', platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Error('Worker-Fernzugriff wird nur auf macOS installiert.');
  if (uid === 0) throw new Error('Als angemeldeter Worker-Benutzer ausführen, nicht mit sudo.');
  await preflight(); // No key/registry/launchd changes before macOS permission is granted.
  const hostKey = await localHostKey(hostKeyFile, execute);
  const entry = await hubRequest(worker, { operation: 'enroll', workerId: worker.workerId, username, hostKey }, execute);
  if (!entry.operatorKey) throw new Error('Freigegebener Wartungsschlüssel fehlt.');
  const state = path.join(home, '.local/share/max-monitor-remote');
  const profileFile = path.join(state, 'profile.json');
  const previousText = await readable(profileFile);
  const previous = previousText ? JSON.parse(previousText) : null;
  const authorizedFile = path.join(home, '.ssh/authorized_keys');
  // Read only regular files; do not follow a pre-existing symlink.
  try { if (!(await fs.lstat(authorizedFile)).isFile()) throw new Error('authorized_keys ist keine reguläre Datei.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const authorized = await readable(authorizedFile);
  const line = authorizedLine(entry.operatorKey, worker.workerId);
  const plist = path.join(home, 'Library/LaunchAgents', LABEL + '.plist');
  const oldPlist = await readable(plist);
  await writePrivate(authorizedFile, updateAuthorized(authorized, line, previous?.authorizedLine));
  try {
    await writePrivate(profileFile, JSON.stringify({ schema: 1, ...entry, authorizedLine: line, installedAt: new Date().toISOString() }, null, 2) + '\n');
    await writePrivate(plist, launchAgent(worker, entry, path.join(state, 'tunnel.log')));
    await execute('/usr/bin/plutil', ['-lint', plist]);
    try { await execute('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`]); } catch {}
    await execute('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]);
    return { workerId: entry.workerId, port: entry.port, installed: true, verified: false, detail: 'Tunnel installiert. Verbindung vom Wartungs-Mac mit check verifizieren.' };
  } catch (error) {
    try { await execute('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`]); } catch {}
    await writePrivate(authorizedFile, authorized);
    if (previousText) await writePrivate(profileFile, previousText); else await fs.rm(profileFile, { force: true });
    if (oldPlist) { await writePrivate(plist, oldPlist); try { await execute('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]); } catch {} }
    else await fs.rm(plist, { force: true });
    throw error;
  }
}

export function connectionArgs(worker, entry, { identityFile, knownHostsFile, check = false, command = [] }) {
  validateEntry(entry);
  const proxy = ['/usr/bin/ssh', ...hubArgs(worker), '-W', `127.0.0.1:${entry.port}`, worker.hubHost].map(quote).join(' ');
  return ['-i', identityFile, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${knownHostsFile}"`,
    '-o', `HostKeyAlias=max-monitor-${entry.workerId}`, '-o', 'ConnectTimeout=10', '-o', `ProxyCommand=${proxy}`,
    ...(check ? ['-o', 'BatchMode=yes', '-T'] : []), `${entry.username}@127.0.0.1`, ...(check ? ['/usr/bin/id -un'] : command)];
}

export async function uninstall({ home = os.homedir(), uid = process.getuid(), execute = run } = {}) {
  const file = path.join(home, '.local/share/max-monitor-remote/profile.json');
  const profile = JSON.parse(await readable(file));
  validateEntry(profile);
  try { await execute('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`]); }
  catch (error) {
    try { await execute('/bin/launchctl', ['print', `gui/${uid}/${LABEL}`]); } catch { /* already stopped */ return remove(); }
    throw error;
  }
  return remove();
  async function remove() {
    const authorizedFile = path.join(home, '.ssh/authorized_keys');
    await writePrivate(authorizedFile, updateAuthorized(await readable(authorizedFile), null, profile.authorizedLine));
    await fs.rm(path.join(home, 'Library/LaunchAgents', LABEL + '.plist'), { force: true });
    await fs.rm(file);
    return { uninstalled: true, workerId: profile.workerId };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv.shift();
  if (!['install', 'connect', 'check', 'uninstall'].includes(mode)) throw new Error('Aufruf: worker-remote.mjs install|check <worker-id>|connect <worker-id>|uninstall [--worker-root Pfad] [--identity-file Pfad]');
  const workerId = ['connect', 'check'].includes(mode) ? argv.shift() : null;
  if (workerId !== null && !WORKER_ID.test(workerId || '')) throw new Error('Worker-ID fehlt oder ist ungültig.');
  let root, identity = path.join(os.homedir(), '.ssh/max_monitor_remote_ed25519');
  let command = [];
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--') { command = argv; break; }
    if (!['--worker-root', '--identity-file'].includes(flag) || !argv[0]) throw new Error('Ungültige Option.');
    const value = argv.shift();
    if (flag === '--worker-root') root = path.resolve(value); else identity = path.resolve(value);
  }
  if (mode === 'uninstall') { console.log(JSON.stringify(await uninstall())); return; }
  const worker = await readWorker({ workerRoot: root || await discoverRoot(), updateOnly: true });
  if (mode === 'install') { console.log(JSON.stringify(await install(worker))); return; }
  await fs.access(identity);
  const entry = await hubRequest(worker, { operation: 'lookup', workerId });
  const knownHostsFile = path.join(os.homedir(), '.local/share/max-monitor-remote', `${workerId}.known_hosts`);
  await writePrivate(knownHostsFile, `max-monitor-${workerId} ${entry.hostKey}\n`);
  const args = connectionArgs(worker, entry, { identityFile: identity, knownHostsFile, check: mode === 'check', command });
  if (mode === 'check') {
    const username = (await run('/usr/bin/ssh', args, { timeout: 25000 })).trim();
    if (username !== entry.username) throw new Error('SSH-Verbindung meldet einen anderen Benutzer.');
    console.log(JSON.stringify({ workerId, username, verified: true })); return;
  }
  const child = spawn('/usr/bin/ssh', args, { stdio: 'inherit', shell: false });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }); });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`Max Monitor Fernzugriff: ${error.message}\n`); process.exitCode = 1; });
}
