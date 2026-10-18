#!/usr/bin/env node
// Trusted Hub bridge: member/owner tokens stay here; only public tickets leave.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfiguration } from './enroll-monitor-worker.mjs';
import access from '../team-server/remote-access.js';
import { WORKER_ID, DEVICE_ID } from './worker-remote-hub.mjs';

async function request(settings, route, token, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${settings.serverURL}/v1/teams/${settings.teamId}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
  } catch { throw Error('Max Monitor ist nicht erreichbar.'); }
  if (!response.ok) throw Error(`Max Monitor verweigert den Wartungszugriff (HTTP ${response.status}).`);
  try { return await response.json(); } catch { throw Error('Ungültige Max-Monitor-Antwort.'); }
}

export async function maintenance(body, { settings = loadConfiguration(), fetchImpl = fetch,
  authorize = access.authorizeClient, dataDir = '/var/lib/max-monitor', readMembers } = {}) {
  if (!body || !['list', 'ticket'].includes(body.operation) || !WORKER_ID.test(body.sourceWorkerId || '') ||
      body.deviceId !== undefined && !DEVICE_ID.test(body.deviceId || '') || body.operation === 'ticket' && !WORKER_ID.test(body.workerId || '')) {
    throw Error('Ungültige Wartungsanfrage.');
  }
  const publicKey = access.publicKey(body.publicKey);
  // The public member endpoint intentionally omits enrollment bindings. Read the
  // authoritative private record on the Hub; no membership writes or token export.
  let members;
  if (readMembers) members = readMembers();
  else {
    const file = path.join(dataDir, settings.teamId, 'members.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.mode & 0o022) throw Error('Mitglieds-Zuordnung ist nicht verfügbar.');
    members = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const matching = Array.isArray(members) ? members.filter(member => member.enrollment?.workerId === body.sourceWorkerId &&
    DEVICE_ID.test(member.enrollment?.deviceId || '') && (body.deviceId === undefined || member.enrollment.deviceId === body.deviceId)) : [];
  if (matching.length !== 1 || typeof matching[0].token !== 'string' || !/^[0-9a-f]{32}$/.test(matching[0].token)) {
    throw Error('Dieser Quell-Mac ist nicht eindeutig im Max Monitor registriert.');
  }
  const member = matching[0];
  const source = authorize(path.join(dataDir, settings.teamId), settings.teamId, member.id, publicKey);
  if (source !== body.sourceWorkerId) throw Error('Dieser Quell-Mac hat keine Wartungsfreigabe.');
  if (body.operation === 'ticket') {
    const ticket = await request(settings, '/remote-access/certificate', member.token,
      { workerId: body.workerId, publicKey }, fetchImpl);
    // Never forward incidental upstream fields or credential material.
    return Object.fromEntries(['schema', 'teamId', 'memberId', 'worker', 'hubHost', 'hubUser', 'hubHostKey', 'certificate', 'expiresAt']
      .map(key => [key, ticket[key]]));
  }
  const targets = await request(settings, '/remote-access', member.token, undefined, fetchImpl);
  const fleet = await request(settings, '/fleet', member.token, undefined, fetchImpl);
  if (!Array.isArray(targets.workers) || !Array.isArray(fleet.machines)) throw Error('Max-Monitor-Zielliste fehlt.');
  return { schema: 1, teamId: settings.teamId, sourceWorkerId: source, generatedAt: fleet.generatedAt,
    workers: targets.workers.map(target => {
      const machine = fleet.machines.find(machine => machine.workerId === target.workerId) || {};
      return { workerId: target.workerId, username: target.username, name: machine.name || target.workerId,
        status: machine.status || 'unknown', lastSeenAt: machine.workerLastSeenAt || machine.lastSeenAt,
        service: machine.service, maintenance: machine.maintenance,
        // An online process may have stopped accepting work (for example at its
        // quota). Keep the relay's direct observation and capacity provenance so
        // maintenance can distinguish an available worker from liveness alone.
        ...(machine.activity ? { activity: {
          state: machine.activity.state, fresh: machine.activity.fresh,
          acceptingTasks: machine.activity.acceptingTasks, sampledAt: machine.activity.sampledAt,
        } } : {}),
        ...(machine.load ? { load: {
          occupied: machine.load.occupied, max: machine.load.max, fresh: machine.load.fresh,
          source: machine.load.source, observedAt: machine.load.observedAt,
        } } : {}),
        ...(machine.workerRevision ? { workerRevision: machine.workerRevision,
          workerVersionObservedAt: machine.workerVersionObservedAt } : {}),
        activeRuns: (machine.activity?.runs || []).map(run => ({ id: run.id, title: run.title, status: run.status, progress: run.progress })),
        issues: (machine.workerIssues || []).map(issue => ({ stage: issue.stage, severity: issue.severity, message: issue.message })) };
    }) };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, ...options } = {}) {
  if (argv.length !== 1 || argv[0] !== '--stdin') throw Error('Nur --stdin ist erlaubt.');
  let text = '';
  for await (const chunk of input) {
    text += chunk;
    if (Buffer.byteLength(text) > 4096) throw Error('Wartungsanfrage zu groß.');
  }
  const settings = options.settings || loadConfiguration();
  process.env.MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE ||= `/etc/max-monitor-remote-policy/${settings.teamId}.json`;
  output.write(JSON.stringify(await maintenance(JSON.parse(text), { ...options, settings })) + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { process.stderr.write('Max Monitor: Wartungsfreigabe fehlt oder Hub nicht erreichbar.\n'); process.exitCode = 1; });
}
