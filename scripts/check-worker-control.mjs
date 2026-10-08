#!/usr/bin/env node
// Read-only Hub command. Owner credentials never leave the Hub.
import { pathToFileURL } from 'node:url';
import { loadConfiguration } from './enroll-monitor-worker.mjs';
import control from '../team-server/worker-control.js';

export async function checkWorkerControl(settings, workerId, { fetchImpl = fetch, deviceId = null } = {}) {
  if (typeof workerId !== 'string' || !control.WORKER_ID.test(workerId)) throw new Error('Ungültige Worker-ID.');
  if (deviceId !== null && (typeof deviceId !== 'string' || !control.DEVICE_ID.test(deviceId))) throw new Error('Ungültige Geräte-ID.');
  const url = `${settings.serverURL}/v1/teams/${settings.teamId}/workers/${workerId}/control` + (deviceId ? `?deviceId=${deviceId}` : '');
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${settings.ownerToken}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Worker-Freigabe konnte nicht geprüft werden.');
  const result = await response.json();
  if (result?.schema !== 1 || result.workerId !== workerId || typeof result.enabled !== 'boolean' ||
      !['enabled', 'disabled', 'unregistered', 'ambiguous'].includes(result.reason) || result.enabled !== (result.reason === 'enabled')) {
    throw new Error('Ungültige Worker-Freigabe.');
  }
  return { schema: 1, workerId, enabled: result.enabled, reason: result.reason };
}

export async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, settings, fetchImpl = fetch } = {}) {
  if (argv.length !== 1 || argv[0] !== '--stdin') throw new Error('Nur --stdin ist erlaubt.');
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 1024) throw new Error('Anfrage zu groß.');
    chunks.push(Buffer.from(chunk));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = await checkWorkerControl(settings || loadConfiguration(), body?.workerId, { fetchImpl, deviceId: body?.deviceId ?? null });
  output.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('Max Monitor Worker-Freigabe nicht erreichbar oder ungültig.\n');
    process.exitCode = 1;
  });
}
