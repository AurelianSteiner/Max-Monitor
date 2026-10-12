#!/usr/bin/env node
// Trusted SSH-only helper. No HTTP command endpoint or owner token on a Mac.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkWorkerControl } from './check-worker-control.mjs';
import { loadConfiguration } from './enroll-monitor-worker.mjs';

export const WORKER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/i;

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
  return { workerId: value.workerId, username: value.username, port: value.port, hostKey: publicKey(value.hostKey) };
}

export function registryAt(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024 || (stat.mode & 0o077)) throw new Error('Fernzugriffs-Register muss eine private Datei sein.');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (registry.schema !== 1 || !Array.isArray(registry.workers)) throw new Error('Ungültiges Fernzugriffs-Register.');
    const workers = registry.workers.map(validateEntry);
    if (new Set(workers.map(v => v.workerId)).size !== workers.length || new Set(workers.map(v => v.port)).size !== workers.length) throw new Error('Doppelte Fernzugriffs-Zuordnung.');
    return { schema: 1, workers };
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, workers: [] };
    throw error;
  }
}

export async function handle(body, { settings = loadConfiguration(), file = '/etc/max-monitor/remote-access.json',
  operatorFile = '/etc/max-monitor/remote-operator.pub', permission = checkWorkerControl } = {}) {
  if (!['enroll', 'lookup'].includes(body?.operation) || !WORKER_ID.test(body?.workerId || '')) throw new Error('Ungültige Fernzugriffs-Anfrage.');
  const control = await permission(settings, body.workerId);
  // A deliberately disabled worker still needs maintenance access.
  if (!['enabled', 'disabled'].includes(control.reason)) throw new Error('Worker ist nicht eindeutig im Max Monitor registriert.');
  if (body.operation === 'lookup') {
    const entry = registryAt(file).workers.find(v => v.workerId === body.workerId);
    if (!entry) throw new Error('Fernzugriff auf diesem Mac noch nicht eingerichtet.');
    return { schema: 1, ...entry };
  }
  if (!USERNAME.test(body.username || '')) throw new Error('Ungültiger Mac-Benutzer.');
  const hostKey = publicKey(body.hostKey);
  const operatorKey = publicKey(fs.readFileSync(operatorFile, 'utf8').trim());
  const lock = file + '.lock';
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const registry = registryAt(file);
    let entry = registry.workers.find(v => v.workerId === body.workerId);
    if (entry && (entry.hostKey !== hostKey || entry.username !== body.username)) throw new Error('Mac-Identität hat sich geändert; bestehende Zuordnung zuerst prüfen.');
    if (!entry) {
      const used = new Set(registry.workers.map(v => v.port));
      let port = 23000;
      while (used.has(port) && port <= 23999) port++;
      entry = validateEntry({ workerId: body.workerId, username: body.username, hostKey, port });
      registry.workers.push(entry);
      const temporary = file + `.tmp-${process.pid}`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    return { schema: 1, ...entry, operatorKey };
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
