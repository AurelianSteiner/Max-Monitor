const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { createFleetStore } = require('../fleet');
const now = Date.parse('2026-10-21T16:00:00Z'), at = n => new Date(now + n).toISOString();
const report = extra => ({ schema: 1, workerId: 'mac-a', sampledAt: at(0),
  service: { running: true, lastPollAt: at(0) }, activity: { state: 'idle', acceptingTasks: true, runs: [] }, ...extra });
const receipt = extra => ({ schema: 'rs-hub-capabilities/v1', checkedAt: at(0), connected: true,
  fullAccess: true, writesEnabled: true, scope: 'all-customers', reasonCode: null,
  contracts: { incidents: 1, blockers: 1, release: 1 }, ...extra });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-audit-regressions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createFleetStore(directory, () => now) };
}

test('unknown observation preserves the running owner across restart; confirmed idle can clear it', t => {
  const { directory, store } = fixture(t);
  store.updateQueue('DEMO1234', { source: { name: 'fixture', lastSuccessAt: at(0) },
    tasks: [{ id: 'task', title: 'Mail', workflow: 'newsletter', status: 'running', workerId: 'mac-a', updatedAt: at(-1000) }] });
  store.workerReport('DEMO1234', report({ activity: { state: 'unknown', acceptingTasks: false, runs: [] } }));
  for (const current of [store, createFleetStore(directory, () => now)]) {
    const task = current.snapshot('DEMO1234').queue.tasks[0];
    assert.equal(task.status, 'running'); assert.equal(task.workerId, 'mac-a');
  }
  store.workerReport('DEMO1234', report());
  assert.equal(store.snapshot('DEMO1234').queue.tasks[0].workerId, null);
});

test('nested-only and conflicting capability evidence keeps the newest probe through persistence', t => {
  const { directory, store } = fixture(t);
  const contract = rsHubMcp => ({ schema: 1, worker: { version: 'V1', revision: 'a'.repeat(40) }, rsHubMcp });
  store.workerReport('DEMO1234', report({ integrationContract: contract(receipt()) }));
  let saved = createFleetStore(directory, () => now).workerReportStatus('DEMO1234', 'mac-a');
  assert.equal(saved.rsHubMcp.ready, true); assert.equal(saved.integrationContract.rsHubMcp.ready, true);
  const failed = receipt({ checkedAt: at(1000), connected: false, fullAccess: null, writesEnabled: null, reasonCode: 'network' });
  store.workerReport('DEMO1234', report({ sampledAt: at(1000), rsHubMcp: receipt({ checkedAt: at(-1000) }), integrationContract: contract(failed) }));
  saved = store.workerReportStatus('DEMO1234', 'mac-a');
  assert.equal(saved.rsHubMcp.reasonCode, 'network'); assert.equal(saved.integrationContract.rsHubMcp.reasonCode, 'network');
});

test('a registered native Mac retains its linked Worker ID against a different device', t => {
  const { store } = fixture(t);
  const deviceId = '610be10e-8a00-4e00-b000-000000000051';
  store.heartbeat('DEMO1234', { role: 'member', member: { id: 'native', name: 'Native' } },
    { deviceId, name: 'Fixture', reportedAt: at(0), limits: [] });
  store.linkWorker('DEMO1234', 'mac-a', deviceId);
  assert.throws(() => store.heartbeat('DEMO1234', { role: 'member', member: { id: 'other', name: 'Other' } },
    { deviceId: '610be10e-8a00-4e00-b000-000000000052', workerId: 'mac-a', name: 'Other', reportedAt: at(0), limits: [] }), /verbunden/);
});

test('deleting a registered Mac purges its report and order while preserving other Macs and tasks', t => {
  const { directory, store } = fixture(t);
  const deviceId = '610be10e-8a00-4e00-b000-000000000051';
  const member = { id: 'member-a', enrollment: { workerId: 'mac-a', deviceId } };
  store.workerReport('DEMO1234', report({ deviceId }));
  store.workerReport('DEMO1234', report({ workerId: 'mac-b' }));
  store.updateQueue('DEMO1234', { source: { name: 'fixture' }, tasks: [{ id: 'shared', title: 'Shared', workflow: 'newsletter', status: 'queued' }] });
  const orders = path.join(directory, 'DEMO1234', 'claude-account-orders'); fs.mkdirSync(orders, { recursive: true });
  fs.writeFileSync(path.join(orders, 'mac-a.json'), '{}'); fs.writeFileSync(path.join(orders, 'mac-b.json'), '{}');
  store.removeMember('DEMO1234', member);
  const restarted = createFleetStore(directory, () => now);
  assert.equal(restarted.workerReportStatus('DEMO1234', 'mac-a').activity, undefined);
  assert.equal(restarted.workerReportStatus('DEMO1234', 'mac-b').activity.fresh, true);
  assert.equal(fs.existsSync(path.join(orders, 'mac-a.json')), false);
  assert.equal(fs.existsSync(path.join(orders, 'mac-b.json')), true);
  assert.equal(restarted.snapshot('DEMO1234').queue.tasks.length, 1);
});

test('enrollment reservations, linked identities and delayed requests remain consistent over the HTTP API', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-audit-http-'));
  process.env.DATA_DIR = directory; process.env.TEAM_TOKEN = 'isolated-audit-owner'; delete process.env.TEAM_TOKENS;
  const { server } = require('../server');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port + '/v1/teams/DEMO1234';
  const call = async (route, method = 'GET', body, token = process.env.TEAM_TOKEN) => {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const deviceA = '610be10e-8a00-4e00-b000-000000000051', deviceB = '610be10e-8a00-4e00-b000-000000000052';
  const enrolled = (await call('/workers/enroll', 'POST', { workerId: 'mac-a', deviceId: deviceA })).body.member;
  const manual = (await call('/members', 'POST', { name: 'Manual', role: 'member' })).body.member;
  const beat = { deviceId: deviceB, workerId: 'mac-a', name: 'Fixture', reportedAt: new Date().toISOString(), limits: [] };
  assert.equal((await call('/heartbeat', 'POST', beat, manual.token)).status, 409);
  assert.equal((await call('/heartbeat', 'POST', { ...beat, deviceId: deviceA }, enrolled.token)).status, 200);
  assert.equal((await call('/members/' + manual.id, 'DELETE')).status, 200);
  assert.equal((await call('/heartbeat', 'POST', { ...beat, deviceId: deviceA }, enrolled.token)).status, 200);
  assert.equal((await call('/workers/enroll', 'POST', { workerId: 'mac-a', deviceId: deviceA })).status, 200);

  async function delayed(route, method, body, member, revoke) {
    const raw = JSON.stringify(body);
    let observed;
    const started = new Promise(resolve => { observed = req => { if (req.url.endsWith(route) && req.method === method) resolve(); }; server.on('request', observed); });
    let finish;
    const result = new Promise((resolve, reject) => {
      const req = http.request(base + route, { method, headers: { Authorization: 'Bearer ' + member.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } },
        res => { let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) })); });
      req.setTimeout(5000, () => req.destroy(new Error('fixture timeout'))); req.on('error', reject);
      req.write(raw.slice(0, 1)); finish = () => req.end(raw.slice(1));
    });
    await started; server.off('request', observed); await revoke(); finish(); return result;
  }
  const admin = (await call('/members', 'POST', { name: 'Admin', role: 'admin' })).body.member;
  const first = await call('/effort', 'PATCH', { revision: 0, phases: { newsletter: 'high' } }, admin.token);
  assert.equal(first.status, 200); assert.equal(first.body.policy.updated_by, admin.id);
  for (const [route, method, body] of [
    ['/effort', 'PATCH', { revision: 1, phases: { newsletter: 'low' } }],
    ['/fleet/tasks/clarification', 'POST', {}], ['/workers/mac-a/claude-accounts', 'POST', {}],
  ]) {
    await call('/members/' + admin.id, 'PATCH', { role: 'admin' });
    assert.equal((await delayed(route, method, body, admin, () => call('/members/' + admin.id, 'PATCH', { role: 'member' }))).status, 403);
  }
  const reader = (await call('/members', 'POST', { name: 'Reader', role: 'member' })).body.member;
  assert.equal((await delayed('/fleet/tasks/complete', 'POST', {}, reader, () => call('/members/' + reader.id, 'DELETE'))).status, 401);
});
