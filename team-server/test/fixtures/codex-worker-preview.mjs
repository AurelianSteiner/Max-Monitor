// Local-only visual review against the real relay/dashboard, with invented accounts.
// Run: node team-server/test/fixtures/codex-worker-preview.mjs [--ready]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const ready = process.argv.includes('--ready');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-worker-preview-'));
process.env.DATA_DIR = directory;
process.env.TEAM_TOKEN = 'preview-codex-local-only';
delete process.env.TEAM_TOKENS;
const { server } = require('../../server.js');
server.listen(Number(process.env.PREVIEW_PORT || 8946), '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`, teamId = 'CORAL123';
const base = `${origin}/v1/teams/${teamId}`;
async function call(route, body, token = process.env.TEAM_TOKEN) {
  const response = await fetch(base + route, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return response.json();
}
const workerId = 'hausdraches-macbook-air-f1e2b4ad', deviceId = 'af722b73-9a39-4025-909c-64590db06d1c';
const member = (await call('/workers/enroll', { workerId, deviceId })).member;
const rot = (await call('/workers/enroll', { workerId: 'macbook-1', deviceId: '00000000-0000-4000-8000-000000000001' })).member;
async function sample() {
  const at = new Date().toISOString(), reset = new Date(Date.now() + 3 * 86400000).toISOString();
  await call('/heartbeat', { deviceId, workerId, name: 'Hausdraches MacBook Air', reportedAt: at,
    batteryPercent: 84, powerSource: 'ac', isAwake: true, stayAwakeEnabled: true, appVersion: '2.17.0',
    accounts: [], limits: [] }, member.token);
  await call(`/workers/${workerId}/report`, { schema: 1, workerId, workerKind: 'codex-repair', deviceId,
    sampledAt: at, workerVersion: '2.17.0', service: { running: true, lastPollAt: at, lastPollOk: true },
    activity: { state: 'idle', acceptingTasks: ready, runs: [], occupiedTasks: 0, maxTasks: 1 },
    codexAccount: ready ? { status: 'ready', accountId: 'invented-codex-account', name: 'Koralle Codex',
      email: 'koralle@example.test', checkedAt: at, updatedAt: at,
      windows: [{ kind: 'session', percent: 12, reset: new Date(Date.now() + 7200000).toISOString() },
        { kind: 'weekly', percent: 37, reset }] }
      : { status: 'not_configured', checkedAt: at, windows: [] } });
  await call('/heartbeat', { deviceId: rot.enrollment.deviceId, workerId: 'macbook-1', name: 'Newsletter Mac', reportedAt: at,
    monitoringAccountId: 'invented-claude-account', batteryPercent: 92, powerSource: 'ac',
    accounts: [{ accountId: 'invented-claude-account', name: 'newsletter@example.test', provider: 'claude', usageUpdatedAt: at }],
    limits: [{ accountId: 'invented-claude-account', label: '5 h', kind: 'session', percent: 24, resetsAt: reset, usageUpdatedAt: at },
      { accountId: 'invented-claude-account', label: 'Woche', kind: 'weekly', percent: 53, resetsAt: reset, usageUpdatedAt: at }] }, rot.token);
  await call('/workers/macbook-1/report', { schema: 1, workerId: 'macbook-1', deviceId: rot.enrollment.deviceId,
    sampledAt: at, service: { running: true, lastPollAt: at, lastPollOk: true },
    activity: { state: 'idle', acceptingTasks: true, runs: [], occupiedTasks: 0, maxTasks: 4 } });
  await call('/queue', { source: { name: 'Lokale visuelle Prüfung', lastSuccessAt: at }, tasks: [] });
}
await sample();
const timer = setInterval(() => sample().catch(error => console.error(error.message)), 20000);
function stop() { clearInterval(timer); server.closeAllConnections(); server.close(() => {
  fs.rmSync(directory, { recursive: true, force: true }); process.exit();
}); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log(JSON.stringify({ url: `${origin}/fleet?view=overview`, teamId,
  token: process.env.TEAM_TOKEN, mode: ready ? 'ready' : 'waiting-for-login' }));
