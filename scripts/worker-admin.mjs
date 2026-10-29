#!/usr/bin/env node
// AI Newsletter maintenance reuses Max Monitor's source policy and SSH client.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverRoot, hubArgs, readMonitorDeviceId } from './worker-remote.mjs';
import { readWorker, run } from './setup-mac-monitor.mjs';
import { WORKER_ID, publicKey, validateEntry } from './worker-remote-hub.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));

export async function sourceDeviceId(worker, { home = os.homedir() } = {}) {
  const cached = await readMonitorDeviceId(worker.monitorDeviceIdFile);
  if (cached) return cached;
  // Worker runtime updates may remove the cache. Reuse the exact identity already
  // bound by Max Monitor's remote installer, never generate another device UUID.
  const file = path.join(home, '.local/share/max-monitor-remote/profile.json');
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16 * 1024) throw Error('Geschuetztes Max-Monitor-Profil fehlt.');
  const entry = validateEntry(JSON.parse(await fs.readFile(file, 'utf8')));
  if (entry.workerId !== worker.workerId) throw Error('Max-Monitor-Profil passt nicht zum Quell-Mac.');
  return entry.deviceId || null;
}

export function parseArguments(argv) {
  const args = [...argv], operation = args.shift();
  if (['--help', '-h', undefined].includes(operation)) return { operation: 'help' };
  if (!['list', 'check', 'diagnose', 'exec', 'shell'].includes(operation)) throw Error('Unbekannter Wartungsbefehl.');
  const workerId = operation === 'list' ? null : args.shift();
  if (workerId !== null && !WORKER_ID.test(workerId || '')) throw Error('Exakte Worker-ID fehlt. Zuerst list ausführen.');
  let root, command, forwardStdin = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--worker-root' && args[0]) root = path.resolve(args.shift());
    else if (flag === '--stdin' && operation === 'exec' && !forwardStdin) forwardStdin = true;
    else if (flag === '--' && operation === 'exec' && args.length === 1 && args[0] && !args[0].includes('\0')) command = args.shift();
    else throw Error('Ungültige Option. exec braucht nach -- genau einen zitierten Fernbefehl.');
  }
  if (operation === 'exec' && !command) throw Error('Fernbefehl fehlt.');
  return { operation, workerId, root, command, forwardStdin };
}

export function connectWithTicket(options, result, identity, { spawnImpl = spawn } = {}) {
  const args = [path.join(directory, 'member-remote.py'), options.operation === 'check' ? 'check' : 'connect', options.workerId,
    '--team-id', result.teamId, '--identity-file', identity,
    ...(options.forwardStdin ? ['--ticket-fd', '3'] : ['--ticket-stdin']), ...(options.command ? ['--', options.command] : [])];
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/python3', args, { stdio: options.forwardStdin ? ['inherit', 'inherit', 'inherit', 'pipe'] : ['pipe', 'inherit', 'inherit'] });
    child.once('error', () => reject(Error('Max-Monitor-SSH-Client konnte nicht gestartet werden.')));
    child.once('close', code => resolve(code ?? 1));
    const control = options.forwardStdin ? child.stdio[3] : child.stdin;
    control.on('error', () => {}); control.end(JSON.stringify(result) + '\n');
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.operation === 'help') {
    console.log('Max Monitor Worker-Wartung: list | check <worker-id> | diagnose <worker-id> | exec <worker-id> [--stdin] -- "Fernbefehl" | shell <worker-id>');
    return 0;
  }
  const root = options.root || process.env.MAX_MONITOR_WORKER_ROOT || await discoverRoot();
  const worker = await readWorker({ workerRoot: root, updateOnly: true });
  const identity = path.join(os.homedir(), '.ssh/max_monitor_remote_ed25519');
  const stat = await fs.lstat(identity);
  if (!stat.isFile() || stat.mode & 0o077) throw Error('Freigegebener lokaler Quell-Mac-Schlüssel fehlt.');
  const key = publicKey(execFileSync('/usr/bin/ssh-keygen', ['-y', '-f', identity], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const deviceId = await sourceDeviceId(worker);
  const result = JSON.parse(await run('/usr/bin/ssh', [...hubArgs(worker), worker.hubHost,
    'node /opt/max-monitor/scripts/worker-admin-hub.mjs --stdin'], {
    input: JSON.stringify({ operation: options.operation === 'list' ? 'list' : 'ticket',
      sourceWorkerId: worker.workerId, ...(deviceId ? { deviceId } : {}), publicKey: key, ...(options.workerId ? { workerId: options.workerId } : {}) }), timeout: 60_000,
  }));
  if (options.operation === 'list') { console.log(JSON.stringify(result, null, 2)); return 0; }
  let command = options.command;
  if (options.operation === 'diagnose') {
    const source = await fs.readFile(path.join(directory, 'worker-diagnose.py'), 'utf8');
    command = "python3 - <<'MAX_MONITOR_WORKER_DIAG'\n" + source + '\nMAX_MONITOR_WORKER_DIAG';
  }
  return connectWithTicket({ ...options, command }, result, identity);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Max Monitor: Wartungszugriff fehlgeschlagen. list und Quell-Mac-Freigabe prüfen.\n'); process.exitCode = 1;
  });
}
