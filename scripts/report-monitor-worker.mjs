#!/usr/bin/env node
// Fixed Hub ingress: existing authenticated SSH, owner credentials stay here.
import { loadConfiguration } from './enroll-monitor-worker.mjs';
import reports from '../team-server/worker-reports.js';
import { pathToFileURL } from 'node:url';

export async function reportWorker(raw, { settings = loadConfiguration(), fetchImpl = fetch } = {}) {
  const report = reports.validateReport(raw);
  const response = await fetchImpl(`${settings.serverURL}/v1/teams/${settings.teamId}/workers/${report.workerId}/report`, {
    method: 'POST', headers: { Authorization: `Bearer ${settings.ownerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report), redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Worker-Bericht wurde nicht angenommen');
  const result = await response.json();
  if (result?.ok !== true || typeof result.accepted !== 'boolean') throw new Error('Ungültige Bestätigung');
  return { schema: 1, accepted: result.accepted, ...(result.accountCommand ? {accountCommand:result.accountCommand} : {}) };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== '--stdin') throw new Error('Nur --stdin ist erlaubt');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024) throw new Error('Anfrage zu groß'); chunks.push(chunk); }
  process.stdout.write(JSON.stringify(await reportWorker(JSON.parse(Buffer.concat(chunks)))) + '\n');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => { process.stderr.write('Worker-Bericht nicht angenommen.\n'); process.exitCode = 1; });
