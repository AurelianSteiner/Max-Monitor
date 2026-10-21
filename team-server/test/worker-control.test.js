const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { controlForWorker, registeredDeviceId } = require('../worker-control');

test('account inbox bootstrap uses one exact native or enrolled device and never an observer-invented link', () => {
  const first='610be10e-8a00-4e00-b000-000000000072',second='610be10e-8a00-4e00-b000-000000000073';
  const enrolled=[{id:'a',enrollment:{workerId:'mac-a',deviceId:first}}];
  assert.equal(registeredDeviceId('mac-a',enrolled,[]),first);
  assert.equal(registeredDeviceId('mac-a',[],[{workerId:'mac-a',deviceId:first}]),first);
  assert.equal(registeredDeviceId('mac-a',[],[{workerId:'mac-a',deviceId:first,telemetrySource:'worker'}]),undefined);
  assert.equal(registeredDeviceId('mac-a',[],[{workerId:'mac-a',deviceId:first,workerIdSource:'worker'}]),undefined);
  assert.equal(registeredDeviceId('mac-a',enrolled,[{workerId:'mac-a',deviceId:second}]),second,'native identity supersedes old enrollment');
  assert.equal(registeredDeviceId('mac-a',enrolled,[{workerId:'mac-a',deviceId:first},{workerId:'mac-a',deviceId:second}]),undefined);
  assert.equal(registeredDeviceId('mac-a',[...enrolled,{id:'b',enrollment:{workerId:'mac-a',deviceId:second}}],[]),undefined);
  assert.equal(registeredDeviceId('mac-a',[],[{workerId:'mac-a',deviceId:'invalid'}]),undefined);
});

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

test('switching off the Mac\'s own row stops it even while its app reports as another identity', () => {
  // 09.10.2026: macbook-till-main's app reports as the team owner (macWorker
  // true), the user switched off the Mac's own row — it must stop taking work.
  const members = [{ id: 'mac-row', role: 'member', macWorker: false, enrollment: { workerId: 'mac-a' } },
    { id: 'team-owner', role: 'super', macWorker: true }];
  const native = [{ workerId: 'mac-a', memberId: null }];
  assert.deepEqual(controlForWorker('mac-a', members, native), { schema: 1, workerId: 'mac-a', enabled: false, reason: 'disabled' });
  members[0].macWorker = true;
  assert.equal(controlForWorker('mac-a', members, native).enabled, true, 'both switches on → enabled');
  members[1].macWorker = false;
  assert.equal(controlForWorker('mac-a', members, native).reason, 'disabled', 'owner switch still counts');
  members[1].macWorker = true;
  delete members[0].macWorker;
  assert.equal(controlForWorker('mac-a', members, native).enabled, true, 'member default (role member) allows');
  members[0].role = 'guest';
  assert.equal(controlForWorker('mac-a', members, native).reason, 'disabled', 'guest row without switch does not allow');
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
  const sampledAt = new Date().toISOString();
  const directReport = { schema: 1, workerId: 'mac-a', sampledAt,
    service: { running: true, lastPollAt: sampledAt }, activity: { state: 'idle', acceptingTasks: true, runs: [] } };
  assert.equal((await call('/workers/mac-a/report', 'POST', directReport, member.token)).status, 403);
  const bootstrap=(await call('/workers/mac-a/report', 'POST', directReport)).body;
  assert.equal(bootstrap.accepted, true);
  assert.equal(bootstrap.deviceId,deviceId,'an enrolled Mac receives its binding before its first native heartbeat');
  assert.equal((await call('/workers/mac-a/report')).body.activity.fresh, true);
  assert.equal((await call('/workers/mac-missing/report', 'POST', { ...directReport, workerId: 'mac-missing' })).status, 409);
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
  const legacyReport = { ...directReport, workerId: 'mac-legacy', deviceId: legacyDevice, sampledAt: new Date().toISOString() };
  assert.equal((await call('/workers/mac-legacy/report', 'POST', { ...legacyReport, deviceId: undefined })).status, 409);
  assert.equal((await call('/workers/mac-legacy/report', 'POST', legacyReport)).body.accepted, true);
  assert.equal((await call('/fleet')).body.machines.find(m => m.deviceId === legacyDevice).activity.fresh, true);
  assert.equal((await call('/workers/mac-a/report', 'POST', { ...directReport, deviceId: legacyDevice })).status, 409);
  await call(`/members/${legacy.id}`, 'PATCH', { macWorker: false });
  assert.equal((await call(legacyRoute)).body.enabled, false);
  assert.equal((await call(`/workers/mac-a/control?deviceId=${legacyDevice}`)).body.reason, 'ambiguous');
  assert.equal((await call('/workers/mac-a/control?deviceId=bad')).status, 400);
  await call(`/members/${legacy.id}`, 'DELETE');
  assert.equal((await call(legacyRoute)).body.enabled, false);
  fs.writeFileSync(path.join(directory, 'CTRL1234', 'owner.json'), 'corrupt');
  assert.equal((await call('/workers/mac-a/control')).status, 503);
});
