#!/usr/bin/env node
// Fixed Hub-only reader. This publishes identities, never tokens or vault data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfiguration } from './enroll-monitor-worker.mjs';
import { registryAt, teamConfiguration } from './worker-remote-hub.mjs';
import control from '../team-server/worker-control.js';
import kinds from '../team-server/worker-kinds.js';

export const POLICY = 'central-remote-workers/v1';
const MAX_WORKERS = 500;

function privateText(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > maximum) throw Error('Private catalog source unavailable');
  return fs.readFileSync(file, 'utf8');
}

function dataDirectory(file) {
  const matches = [...privateText(file, 16384).matchAll(/^DATA_DIR=(.+)$/gm)];
  const value = matches.length === 1 ? matches[0][1].trim().replace(/^['"]|['"]$/g, '') : '';
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..')) throw Error('Relay data directory unavailable');
  return value;
}

export function workerCatalog({ settings, registryFile = '/etc/max-monitor/remote-access.json',
  policyFile = '/etc/max-monitor/remote-team.json', relayFile = '/etc/max-monitor/relay.env', now = Date.now } = {}) {
  settings ||= loadConfiguration({ configPath: '/etc/max-monitor/enrollment.json', env: {} });
  const dataDir = dataDirectory(relayFile);
  const policy = teamConfiguration(settings, { policyFile, dataDir });
  if (!policy) throw Error('Central remote policy unavailable');
  // registryAt deliberately treats an absent register as empty for bootstrap.
  // The vault contract distinguishes absence from an explicitly empty register.
  privateText(registryFile, 256 * 1024);
  const registry = registryAt(registryFile);
  const directory = path.join(dataDir, settings.teamId);
  const members = JSON.parse(privateText(path.join(directory, 'members.json'), 1024 * 1024));
  const fleet = JSON.parse(privateText(path.join(directory, 'fleet.json'), 16 * 1024 * 1024));
  if (!Array.isArray(members) || members.length > 500 || fleet?.schema !== 1 || !Array.isArray(fleet.machines)
    || fleet.machines.length > MAX_WORKERS || !Array.isArray(fleet.events) || !Array.isArray(fleet.queue?.tasks)) throw Error('Invalid central identities');
  const memberIds = new Set(), enrolledWorkers = new Set(), enrolledDevices = new Set();
  for (const member of members) {
    if (!member || typeof member.id !== 'string' || memberIds.has(member.id)
      || !['member', 'admin', 'guest'].includes(member.role)
      || member.macWorker !== undefined && typeof member.macWorker !== 'boolean') throw Error('Invalid central member');
    memberIds.add(member.id);
    if (member.enrollment !== undefined) {
      const pair = member.enrollment;
      if (!pair || typeof pair.workerId !== 'string' || !control.DEVICE_ID.test(pair.deviceId || '')
        || enrolledWorkers.has(pair.workerId) || enrolledDevices.has(pair.deviceId)) throw Error('Ambiguous central enrollment');
      enrolledWorkers.add(pair.workerId); enrolledDevices.add(pair.deviceId);
    }
  }
  let owner = { macWorker: false };
  try {
    owner = JSON.parse(privateText(path.join(directory, 'owner.json'), 16384));
    if (!owner || typeof owner.macWorker !== 'boolean') throw Error('Invalid central owner');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const identities = [{ id: 'team-owner', role: 'super', macWorker: owner.macWorker === true }, ...members];
  const nativeDevices = new Set();
  const native = fleet.machines.map(machine => {
    if (!machine || !control.DEVICE_ID.test(machine.deviceId || '') || nativeDevices.has(machine.deviceId)) throw Error('Ambiguous native device');
    nativeDevices.add(machine.deviceId);
    const telemetrySource = machine.telemetrySource ?? 'app';
    if (!['app', 'worker'].includes(telemetrySource)) throw Error('Invalid identity provenance');
    return { workerId: machine.workerId, workerIdSource: machine.workerIdSource, deviceId: machine.deviceId,
      memberId: machine.ownerId === '__team_owner__' ? null : machine.ownerId, telemetrySource };
  });
  const tombstones = (field, pattern) => {
    const values = fleet[field] ?? [];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !pattern.test(value))) throw Error('Invalid central deletion record');
    return new Set(values);
  };
  const deletedWorkers = tombstones('deletedWorkers', control.WORKER_ID), deletedDevices = tombstones('deletedDevices', control.DEVICE_ID);
  const candidates = [];
  for (const entry of registry.workers) {
    if (policy.excludedWorkerIds.includes(entry.workerId) || deletedWorkers.has(entry.workerId)) continue;
    const deviceId = entry.deviceId ?? control.registeredDeviceId(entry.workerId, identities, native);
    if (!control.DEVICE_ID.test(deviceId || '') || deletedDevices.has(deviceId)) continue;
    const profile = kinds.workerProfile(entry.workerId);
    const workflow = profile.allowedWorkflows[0];
    if (!workflow || !['newsletter', 'codex-repair'].includes(profile.workerKind)) continue;
    const permission = control.controlForWorker(entry.workerId, identities, native, deviceId, workflow);
    if (permission.enabled !== true || permission.reason !== 'enabled') continue;
    candidates.push({ workerId: entry.workerId, deviceId, workerKind: profile.workerKind,
      provider: profile.provider, allowedWorkflows: [...profile.allowedWorkflows] });
  }
  // A legacy native device cannot become two secret-consuming worker aliases.
  const counts = new Map();
  for (const entry of candidates) counts.set(entry.deviceId, (counts.get(entry.deviceId) || 0) + 1);
  const workers = candidates.filter(entry => counts.get(entry.deviceId) === 1).sort((a, b) => a.workerId.localeCompare(b.workerId));
  if (workers.length > MAX_WORKERS) throw Error('Central worker catalog too large');
  const sampledAt = new Date(now()).toISOString();
  return { schema: 1, policy: POLICY, sampledAt, workers };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, catalog = workerCatalog } = {}) {
  if (argv.length !== 1 || argv[0] !== '--stdin') throw Error('Only --stdin is allowed');
  const chunks = []; let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024) throw Error('Catalog request too large');
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request || request.schema !== 1 || request.op !== 'list'
    || Object.keys(request).sort().join(',') !== 'op,schema') throw Error('Invalid catalog request');
  output.write(JSON.stringify(catalog()) + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { process.stderr.write('Native worker catalog unavailable.\n'); process.exitCode = 1; });
}
