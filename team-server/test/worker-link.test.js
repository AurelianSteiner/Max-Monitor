const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { controlForWorker } = require('../worker-control');

// 09.10.2026: the app on "Macbook 2" was connected by hand without a Worker ID.
// Its worker macbook-2 ran two newsletters, but the dashboard showed the Mac as
// "frei" and hid the unenrolled worker row. The worker already proves which app
// runs beside it: every admission check carries the app's random device UUID.
test('a worker-reported device link names the Mac and its work without changing admission', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-link-'));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = 'private-test-owner';
  delete process.env.TEAM_TOKENS;
  const { server } = require('../server');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/v1/teams/LINK1234`;
  const call = async (route, method = 'GET', body, token = process.env.TEAM_TOKEN) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const manual = (await call('/members', 'POST', { name: 'Macbook 2', role: 'member' })).body.member;
  const other = (await call('/members', 'POST', { name: 'Zweiter Mac', role: 'member' })).body.member;
  const device = '610be10e-8a00-4e00-b000-000000000081';
  const otherDevice = '610be10e-8a00-4e00-b000-000000000082';
  const explicitDevice = '610be10e-8a00-4e00-b000-000000000083';
  const beat = (deviceId, extra = {}) => ({ deviceId, name: 'Macbook 2', limits: [], reportedAt: new Date().toISOString(), ...extra });
  assert.equal((await call('/heartbeat', 'POST', beat(device), manual.token)).status, 200);
  assert.equal((await call('/heartbeat', 'POST', beat(otherDevice, { name: 'Zweiter Mac' }), other.token)).status, 200);
  assert.equal((await call('/heartbeat', 'POST', beat(explicitDevice, { name: 'Eigener Mac', workerId: 'mac-explicit' }), other.token)).status, 200);
  const seen = new Date().toISOString();
  assert.equal((await call('/queue', 'POST', {
    tasks: [{ id: 'clickup:newsletter:a', title: 'Raumteiler', workflow: 'newsletter', status: 'running', workerId: 'macbook-2' }],
    observedWorkers: [{ workerId: 'macbook-2', name: 'macbook-2', lastSeenAt: seen, workerVersion: 'V1.74' }],
    source: { name: 'ClickUp', lastSuccessAt: seen },
  })).status, 200);
  const fleet = async () => (await call('/fleet', 'GET', undefined, manual.token)).body;
  const byDevice = async id => (await fleet()).machines.find(machine => machine.deviceId === id);

  let before = await fleet();
  assert.equal(before.machines.find(machine => machine.deviceId === device).workerId, undefined);
  assert.ok(!before.machines.some(machine => machine.workerId === 'macbook-2'), 'unenrolled Hub row stays hidden');

  const control = (await call(`/workers/macbook-2/control?deviceId=${device}`)).body;
  assert.deepEqual(control, { schema: 1, workerId: 'macbook-2', enabled: true, reason: 'enabled' });
  const linked = await byDevice(device);
  assert.deepEqual([linked.workerId, linked.name, linked.deviceName, linked.workerIdSource, linked.telemetrySource],
    ['macbook-2', 'macbook-2', 'Macbook 2', 'worker', 'app']);
  assert.equal(linked.workerStatus, 'online', 'Hub worker heartbeat merges into the app row');
  assert.equal(linked.workerVersion, 'V1.74');
  assert.equal((await fleet()).machines.filter(machine => machine.workerId === 'macbook-2').length, 1);
  // Workers check about every 40 seconds; an unchanged link must not rewrite state or wake every dashboard.
  const file = path.join(directory, 'LINK1234', 'fleet.json');
  const stamp = fs.statSync(file).mtimeMs; const bytes = fs.readFileSync(file, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 20));
  await call(`/workers/macbook-2/control?deviceId=${device}`);
  assert.equal(fs.statSync(file).mtimeMs, stamp); assert.equal(fs.readFileSync(file, 'utf8'), bytes);

  // Admission is exactly as before the link: switching off the app's member stops the worker.
  await call(`/members/${manual.id}`, 'PATCH', { macWorker: false });
  assert.equal((await call(`/workers/macbook-2/control?deviceId=${device}`)).body.reason, 'disabled');
  await call(`/members/${manual.id}`, 'PATCH', { macWorker: true });
  // The worker moves to another app (reinstall, new UUID): admission follows that app, the link moves along.
  assert.equal((await call(`/workers/macbook-2/control?deviceId=${otherDevice}`)).body.enabled, true);
  assert.equal((await byDevice(device)).workerId, undefined);
  assert.equal((await byDevice(otherDevice)).workerId, 'macbook-2');
  // An app's own Worker ID always wins and is never overwritten by a worker report.
  assert.equal((await call(`/workers/macbook-2/control?deviceId=${explicitDevice}`)).body.reason, 'ambiguous');
  assert.equal((await byDevice(explicitDevice)).workerId, 'mac-explicit');
  assert.equal((await byDevice(otherDevice)).workerId, undefined, 'a report for another Mac clears the old link');
  // Unknown devices and checks without a device create nothing.
  await call('/workers/macbook-2/control?deviceId=610be10e-8a00-4e00-b000-000000000099');
  await call('/workers/macbook-2/control');
  assert.ok(!(await fleet()).machines.some(machine => machine.workerId === 'macbook-2'));

  // Once the app reports the Worker ID itself, the link is redundant and explicit.
  await call(`/workers/macbook-2/control?deviceId=${device}`);
  assert.equal((await call('/heartbeat', 'POST', beat(device, { workerId: 'macbook-2' }), manual.token)).status, 200);
  const explicit = await byDevice(device);
  assert.deepEqual([explicit.workerId, explicit.workerIdSource], ['macbook-2', undefined]);

  // Deleting the Mac drops its link; only identities the app reported itself are deny-listed.
  assert.equal((await call(`/workers/macbook-2/control?deviceId=${otherDevice}`)).status, 200);
  assert.equal((await call(`/members/${other.id}`, 'DELETE')).status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'LINK1234', 'fleet.json'), 'utf8'));
  assert.deepEqual(stored.workerLinks, []);
  assert.ok(!stored.deletedWorkers.includes('macbook-2'));
});

test('admission ignores worker-reported links and keeps app and enrollment identities authoritative', () => {
  const members = [{ id: 'a', role: 'member' }, { id: 'b', role: 'member', macWorker: false }];
  const linked = [{ deviceId: '610be10e-8a00-4e00-b000-000000000081', workerId: 'mac-old', workerIdSource: 'worker', memberId: 'a' }];
  // Without the link field this would be "ambiguous" (device bound to another worker).
  assert.equal(controlForWorker('mac-new', members, linked, linked[0].deviceId).reason, 'enabled');
  assert.equal(controlForWorker('mac-old', members, linked).reason, 'unregistered', 'a link alone never registers a worker');
});
