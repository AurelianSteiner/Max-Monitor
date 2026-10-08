const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { controlForWorker } = require('../worker-control');

test('control uses exact identity bindings and fails closed for unknown or ambiguous workers', () => {
  const members = [{ id: 'a', role: 'member', enrollment: { workerId: 'mac-a' } },
    { id: 'b', role: 'guest', macWorker: true, enrollment: { workerId: 'mac-b' } },
    { id: 'team-owner', role: 'super', macWorker: false }];
  assert.equal(controlForWorker('mac-a', members, []).enabled, true);
  assert.equal(controlForWorker('mac-b', members, []).enabled, true);
  assert.equal(controlForWorker('mac-missing', members, []).reason, 'unregistered');
  assert.equal(controlForWorker('mac-a', members, [{ workerId: 'mac-a', memberId: 'team-owner' }]).enabled, false);
  assert.equal(controlForWorker('mac-a', members, [{ workerId: 'mac-a', memberId: null }]).enabled, false, 'legacy owner identity');
  assert.equal(controlForWorker('mac-a', members, [{ workerId: 'mac-a', memberId: 'missing' }]).enabled, false);
  assert.equal(controlForWorker('mac-a', members, [{ workerId: 'mac-a', memberId: 'a' }, { workerId: 'mac-a', memberId: 'b' }]).reason, 'ambiguous');
  assert.equal(controlForWorker('mac-missing', members, [{ workerId: 'mac-missing', telemetrySource: 'worker' }]).enabled, false);
  assert.equal(controlForWorker('mac-b', [...members, { id: 'c', role: 'member', enrollment: { workerId: 'mac-b' } }], []).reason, 'ambiguous');
});

test('HTTP control follows saved member/owner switches and reassignment without emitting credentials', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-control-'));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = 'private-test-owner';
  delete process.env.TEAM_TOKENS;
  const { server } = require('../server');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/v1/teams/CTRL1234`;
  const call = async (route, method = 'GET', body, token = process.env.TEAM_TOKEN) => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const deviceId = '610be10e-8a00-4e00-b000-000000000072';
  const member = (await call('/workers/enroll', 'POST', { workerId: 'mac-a', deviceId })).body.member;
  assert.equal((await call('/workers/mac-a/control')).body.enabled, true, 'enrollment works before first heartbeat');
  await call(`/members/${member.id}`, 'PATCH', { macWorker: false });
  const disabled = await call('/workers/mac-a/control');
  assert.deepEqual(disabled.body, { schema: 1, workerId: 'mac-a', enabled: false, reason: 'disabled' });
  assert.equal(disabled.cache, 'no-store');
  assert.ok(!JSON.stringify(disabled).includes(member.token));
  assert.equal((await call('/workers/mac-a/control', 'GET', undefined, member.token)).status, 403);
  assert.equal((await call('/workers/mac-missing/control')).body.enabled, false);
  await call(`/members/${member.id}`, 'PATCH', { macWorker: true });
  const heartbeat = { deviceId, workerId: 'mac-a', name: 'Mac A', limits: [], reportedAt: new Date().toISOString() };
  assert.equal((await call('/heartbeat', 'POST', heartbeat, member.token)).status, 200);
  await call('/members/team-owner', 'PATCH', { macWorker: true });
  assert.equal((await call('/heartbeat', 'POST', heartbeat)).status, 200);
  await call('/members/team-owner', 'PATCH', { macWorker: false });
  assert.equal((await call('/workers/mac-a/control')).body.enabled, false, 'superseded enabled enrollment cannot override disabled current owner');
  await call('/members/team-owner', 'PATCH', { macWorker: true });
  assert.equal((await call('/workers/mac-a/control')).body.enabled, true);
  // Manual app connection predating worker enrollment: resolve its exact app UUID.
  const legacy = (await call('/members', 'POST', { name: 'Legacy Mac', role: 'member' })).body.member;
  const legacyDevice = '610be10e-8a00-4e00-b000-000000000073';
  assert.equal((await call('/heartbeat', 'POST', { ...heartbeat, deviceId: legacyDevice, workerId: undefined }, legacy.token)).status, 200);
  const legacyRoute = `/workers/mac-legacy/control?deviceId=${legacyDevice}`;
  assert.equal((await call(legacyRoute)).body.enabled, true);
  await call(`/members/${legacy.id}`, 'PATCH', { macWorker: false });
  assert.equal((await call(legacyRoute)).body.enabled, false);
  assert.equal((await call(`/workers/mac-a/control?deviceId=${legacyDevice}`)).body.reason, 'ambiguous');
  assert.equal((await call('/workers/mac-a/control?deviceId=bad')).status, 400);
  await call(`/members/${legacy.id}`, 'DELETE');
  assert.equal((await call(legacyRoute)).body.enabled, false);
  fs.writeFileSync(path.join(directory, 'CTRL1234', 'owner.json'), 'corrupt');
  assert.equal((await call('/workers/mac-a/control')).status, 503);
});
