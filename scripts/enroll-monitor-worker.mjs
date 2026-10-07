#!/usr/bin/env node
// Run on the trusted RS Hub over an already authenticated SSH connection.
// Owner credentials stay here; stdout is a single captured bootstrap JSON object.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import enrollment from '../team-server/enrollment.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_CONFIG = '/etc/max-monitor/enrollment.json';

export function configuration(values) {
  let url;
  try { url = new URL(values.serverURL); } catch { throw new Error('MAX_MONITOR_SERVER_URL fehlt oder ist ungültig.'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))) {
    throw new Error('Monitor-Server muss HTTPS verwenden (lokales HTTP erlaubt).');
  }
  const teamId = String(values.teamId || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(teamId)) throw new Error('MAX_MONITOR_TEAM_ID fehlt oder ist ungültig.');
  if (typeof values.ownerToken !== 'string' || !values.ownerToken.trim() || values.ownerToken.length > 4096 || /[\r\n\x00]/.test(values.ownerToken)) {
    throw new Error('MAX_MONITOR_OWNER_TOKEN fehlt oder ist ungültig.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { serverURL: url.toString().replace(/\/$/, ''), teamId, ownerToken: values.ownerToken.trim() };
}

export function loadConfiguration({ env = process.env, configPath, readFile = fs.readFileSync, stat = fs.lstatSync } = {}) {
  const file = configPath || env.MAX_MONITOR_ENROLLMENT_CONFIG || DEFAULT_CONFIG;
  let fromFile = {};
  try {
    const metadata = stat(file);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024) throw new Error('Enrollment-Konfiguration muss eine private Datei sein (chmod 600).');
    let parsed;
    try { parsed = JSON.parse(readFile(file, 'utf8')); } catch { throw new Error('Enrollment-Konfiguration enthält kein gültiges JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Enrollment-Konfiguration muss ein Objekt sein.');
    fromFile = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT' || configPath || env.MAX_MONITOR_ENROLLMENT_CONFIG) throw error;
  }
  return configuration({
    serverURL: env.MAX_MONITOR_SERVER_URL ?? fromFile.serverURL,
    teamId: env.MAX_MONITOR_TEAM_ID ?? fromFile.teamId,
    ownerToken: env.MAX_MONITOR_OWNER_TOKEN ?? fromFile.ownerToken,
  });
}

function endpoint(settings, path) {
  return `${settings.serverURL}/v1/teams/${settings.teamId}${path}`;
}

async function request(settings, route, { body, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(endpoint(settings, route), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${settings.ownerToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Monitor-Server ist nicht erreichbar; Registrierung wurde nicht bestätigt.');
  }
  if (!response.ok) {
    // Do not echo an upstream body: it may contain tokens or proxy configuration.
    const message = response.status === 404 ? 'Monitor-Server unterstützt automatische Registrierung noch nicht.'
      : response.status === 409 ? 'Mac oder Worker-ID ist bereits anders registriert; Team-Inhaber muss die Zuordnung prüfen.'
        : response.status === 401 || response.status === 403 ? 'Enrollment-Konfiguration hat keine Inhaber-Berechtigung.'
          : 'Monitor-Registrierung wurde vom Server abgelehnt.';
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  try { return await response.json(); } catch { throw new Error('Monitor-Server lieferte keine gültige JSON-Antwort.'); }
}

export async function checkEnrollment(settings, { fetchImpl = fetch } = {}) {
  const capability = await request(settings, '/workers/enroll', { fetchImpl });
  if (capability.schema !== 1 || capability.role !== 'member') throw new Error('Monitor-Server unterstützt die benötigte Worker-Registrierung nicht.');
  const snapshot = await request(settings, '/fleet', { fetchImpl });
  if (snapshot.schema !== 1 || !Array.isArray(snapshot.machines) || !Array.isArray(snapshot.queue?.tasks)) throw new Error('Monitor-Server stellt keine gemeinsame Fleet-Übersicht bereit.');
  return { schema: 1, ok: true, serverURL: settings.serverURL, teamId: settings.teamId, role: 'member', enrollmentAvailable: true, fleetAvailable: true };
}

export async function enrollMonitorWorker(settings, body, { fetchImpl = fetch } = {}) {
  const identity = enrollment.validateEnrollment(body);
  const result = await request(settings, '/workers/enroll', { body: identity, fetchImpl });
  const member = result.member;
  if (result.schema !== 1 || !member || member.role !== 'member' || !/^[a-z0-9-]{1,64}$/.test(member.id) ||
      typeof member.token !== 'string' || !/^[0-9a-f]{32}$/.test(member.token) || member.token === settings.ownerToken ||
      member.enrollment?.workerId !== identity.workerId || member.enrollment?.deviceId !== identity.deviceId) {
    throw new Error('Monitor-Server lieferte keine gültige Mitglieds-Zuordnung.');
  }
  return { schema: 1, serverURL: settings.serverURL, teamId: settings.teamId, token: member.token,
    memberId: member.id, workerId: identity.workerId, deviceId: identity.deviceId };
}

export function parseArguments(argv) {
  const options = { check: false, stdin: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--stdin') options.stdin = true;
    else if (argument === '--help') options.help = true;
    else if (argument === '--config' && argv[index + 1] && !argv[index + 1].startsWith('--')) options.configPath = argv[++index];
    else throw new Error('Ungültige Enrollment-Option; siehe --help.');
  }
  if (!options.help && options.check === options.stdin) throw new Error('Genau eine Option --check oder --stdin ist erforderlich.');
  return options;
}

async function stdinIdentity(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('Registrierungsanfrage ist zu groß.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('stdin muss ein JSON-Objekt mit workerId, deviceId und optional name enthalten.'); }
}

export async function main(argv = process.argv.slice(2), { env = process.env, input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    output.write('RS Hub: node scripts/enroll-monitor-worker.mjs --check|--stdin [--config <private-json>]\n' +
      'stdin: {"workerId":"mac-5","deviceId":"<FleetSettings UUID>","name":"Mac 5"}\n' +
      'Server-Konfiguration: MAX_MONITOR_SERVER_URL, MAX_MONITOR_TEAM_ID, MAX_MONITOR_OWNER_TOKEN\n' +
      'oder private Datei /etc/max-monitor/enrollment.json: {serverURL,teamId,ownerToken}.\n');
    return;
  }
  const settings = loadConfiguration({ env, configPath: options.configPath });
  const result = options.check ? await checkEnrollment(settings, { fetchImpl })
    : await enrollMonitorWorker(settings, await stdinIdentity(input), { fetchImpl });
  output.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    // A single diagnostic without private configuration, token or request output.
    process.stderr.write('Max Monitor Enrollment fehlgeschlagen. Server-Konfiguration, Berechtigung und Worker-Zuordnung prüfen.\n');
    process.exitCode = 1;
  });
}
