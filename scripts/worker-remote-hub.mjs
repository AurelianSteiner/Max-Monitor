#!/usr/bin/env node
// Trusted SSH-only helper. No HTTP command endpoint or owner token on a Mac.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkWorkerControl } from './check-worker-control.mjs';
import { loadConfiguration } from './enroll-monitor-worker.mjs';
import control from '../team-server/worker-control.js';

export const WORKER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/i;
export const DEVICE_ID = control.DEVICE_ID;

export function publicKey(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\x00]/.test(value)) throw new Error('Ungültiger öffentlicher SSH-Schlüssel.');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value.trim());
  if (!match) throw new Error('Nur einzelne Ed25519-Schlüssel sind erlaubt.');
  const bytes = Buffer.from(match[1], 'base64');
  const algorithm = Buffer.from('ssh-ed25519');
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || !bytes.subarray(4, 15).equals(algorithm)
      || bytes.readUInt32BE(15) !== 32 || bytes.toString('base64') !== match[1]) throw new Error('Ungültiger Ed25519-Schlüssel.');
  return `ssh-ed25519 ${match[1]}`;
}

export function validateEntry(value) {
  if (!value || !WORKER_ID.test(value.workerId || '') || !USERNAME.test(value.username || '')
      || !Number.isInteger(value.port) || value.port < 23000 || value.port > 23999) throw new Error('Ungültige Fernzugriffs-Registrierung.');
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !DEVICE_ID.test(value.deviceId))) throw new Error('Ungültige Gerätekennung.');
  return { workerId: value.workerId, username: value.username, port: value.port, hostKey: publicKey(value.hostKey),
    ...(value.deviceId !== undefined ? { deviceId: value.deviceId } : {}) };
}

export function registryAt(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024 || (stat.mode & 0o077)) throw new Error('Fernzugriffs-Register muss eine private Datei sein.');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (registry.schema !== 1 || !Array.isArray(registry.workers)) throw new Error('Ungültiges Fernzugriffs-Register.');
    const workers = registry.workers.map(validateEntry);
    if (new Set(workers.map(v => v.workerId)).size !== workers.length || new Set(workers.map(v => v.port)).size !== workers.length) throw new Error('Doppelte Fernzugriffs-Zuordnung.');
    const devices = workers.filter(v => v.deviceId).map(v => v.deviceId);
    if (new Set(devices).size !== devices.length) throw new Error('Doppelte Gerätekennung.');
    return { schema: 1, workers };
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, workers: [] };
    throw error;
  }
}

export function teamConfiguration(settings, { policyFile = '/etc/max-monitor/remote-team.json', dataDir = '/var/lib/max-monitor' } = {}) {
  let policy;
  try {
    const stat = fs.lstatSync(policyFile);
    if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077) throw Error('invalid');
    policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Ungültige Team-Fernzugriff-Freigabe.'); }
  if (policy.schema !== 1 || !/^[A-Z0-9]{4,16}$/.test(policy.teamId || '') || policy.teamId !== settings.teamId ||
      typeof policy.hubHost !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(policy.hubHost) ||
      !Array.isArray(policy.excludedWorkerIds) || policy.excludedWorkerIds.some(v => typeof v !== 'string' || !WORKER_ID.test(v))) throw new Error('Ungültige Team-Fernzugriff-Freigabe.');
  const keyFile = path.join(dataDir, policy.teamId, 'remote-ca.pub');
  if (!fs.lstatSync(keyFile).isFile()) throw new Error('Team-Prüfschlüssel ist keine reguläre Datei.');
  return { ...policy, publicKey: publicKey(fs.readFileSync(keyFile, 'utf8').trim()), dataDir };
}

export function syncTeamAccess(settings, { file = '/etc/max-monitor/remote-access.json', bastionKeys = '/var/lib/max-monitor-access/.ssh/authorized_keys', hostKeyFile = '/etc/ssh/ssh_host_ed25519_key.pub', ...options } = {}) {
  const team = teamConfiguration(settings, options);
  if (!team) return null;
  const workers = registryAt(file).workers.filter(v => !team.excludedWorkerIds.includes(v.workerId));
  if (!workers.length) throw new Error('Keine Macs für Team-Fernzugriff eingerichtet.');
  const keys = ['cert-authority', `principals="max-monitor-${team.teamId}-bastion"`, 'restrict', 'port-forwarding',
    'command="/usr/bin/false"', ...workers.map(v => `permitopen="127.0.0.1:${v.port}"`)].join(',') + ` ${team.publicKey} max-monitor-team-access\n`;
  if (!fs.lstatSync(bastionKeys).isFile()) throw new Error('Bastion-Prüfschlüssel ist keine reguläre Datei.');
  const manifest = { schema: 1, enabled: true, teamId: team.teamId, hubHost: team.hubHost, hubUser: 'max-monitor-access',
    hubHostKey: publicKey(fs.readFileSync(hostKeyFile, 'utf8').trim()),
    workers: workers.map(({ workerId, username, port, hostKey }) => ({ workerId, username, port, hostKey })) };
  const target = path.join(team.dataDir, team.teamId, 'remote-access.json');
  for (const [output, value] of [[bastionKeys, keys], [target, JSON.stringify(manifest, null, 2) + '\n']]) {
    try { if (!fs.lstatSync(output).isFile()) throw new Error('Team-Konfiguration ist keine reguläre Datei.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = output + `.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, value, { mode: 0o644, flag: 'wx' });
      fs.renameSync(temporary, output);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return team;
}

export async function handle(body, { settings = loadConfiguration(), file = '/etc/max-monitor/remote-access.json',
  operatorFile = '/etc/max-monitor/remote-operator.pub', permission = checkWorkerControl, teamOptions = {} } = {}) {
  if (!['enroll', 'lookup'].includes(body?.operation) || !WORKER_ID.test(body?.workerId || '')) throw new Error('Ungültige Fernzugriffs-Anfrage.');
  if (body.deviceId !== undefined && (typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId))) throw new Error('Ungültige Gerätekennung.');
  const saved = registryAt(file).workers.find(v => v.workerId === body.workerId);
  if (saved?.deviceId && body.deviceId && saved.deviceId !== body.deviceId) throw new Error('Mac-Identität hat sich geändert; bestehende Zuordnung zuerst prüfen.');
  // Legacy apps are bound by their existing UUID; display names never grant access.
  const deviceId = saved?.deviceId || body.deviceId || null;
  const allowed = await permission(settings, body.workerId, { deviceId });
  // A deliberately disabled worker still needs maintenance access.
  if (!['enabled', 'disabled'].includes(allowed.reason)) throw new Error('Worker ist nicht eindeutig im Max Monitor registriert.');
  if (body.operation === 'lookup') {
    if (!saved) throw new Error('Fernzugriff auf diesem Mac noch nicht eingerichtet.');
    return { schema: 1, ...saved };
  }
  if (!USERNAME.test(body.username || '')) throw new Error('Ungültiger Mac-Benutzer.');
  const hostKey = publicKey(body.hostKey);
  const operatorKey = publicKey(fs.readFileSync(operatorFile, 'utf8').trim());
  const lock = file + '.lock';
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const registry = registryAt(file);
    let entry = registry.workers.find(v => v.workerId === body.workerId);
    if (entry && (entry.hostKey !== hostKey || entry.username !== body.username ||
        (entry.deviceId && entry.deviceId !== deviceId))) throw new Error('Mac-Identität hat sich geändert; bestehende Zuordnung zuerst prüfen.');
    if (deviceId && registry.workers.some(v => v.workerId !== body.workerId && v.deviceId === deviceId)) throw new Error('Gerätekennung gehört bereits zu einem anderen Wartungszugang.');
    let changed = false;
    if (!entry) {
      const used = new Set(registry.workers.map(v => v.port));
      let port = 23000;
      while (used.has(port) && port <= 23999) port++;
      entry = validateEntry({ workerId: body.workerId, username: body.username, hostKey, port,
        ...(deviceId ? { deviceId } : {}) });
      registry.workers.push(entry);
      changed = true;
    } else if (deviceId && !entry.deviceId) {
      entry.deviceId = deviceId;
      changed = true;
    }
    if (changed) {
      const temporary = file + `.tmp-${process.pid}`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const team = syncTeamAccess(settings, { ...teamOptions, file });
    const teamAuthority = team && !team.excludedWorkerIds.includes(entry.workerId) ? { teamId: team.teamId, publicKey: team.publicKey } : null;
    return { schema: 1, ...entry, operatorKey, ...(teamAuthority ? { teamAuthority } : {}) };
  } finally { fs.rmdirSync(lock); }
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, ...options } = {}) {
  if (argv.length !== 1 || argv[0] !== '--stdin') throw new Error('Nur --stdin ist erlaubt.');
  let data = '';
  for await (const chunk of input) {
    data += chunk;
    if (Buffer.byteLength(data) > 4096) throw new Error('Fernzugriffs-Anfrage zu groß.');
  }
  output.write(JSON.stringify(await handle(JSON.parse(data), options)) + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`Max Monitor Fernzugriff: ${error.message}\n`); process.exitCode = 1; });
}
