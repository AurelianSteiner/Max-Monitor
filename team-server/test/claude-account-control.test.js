const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const controls = require('../claude-account-control');
const deviceId = '12345678-1234-4234-8234-123456789abc';

test('locks survive reloads, combine independently, bind the device and fail closed on corrupt storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-locks-'));
  try {
    const change = (accountId, disabled) => controls.save(dir, {workerId: 'mac-test', deviceId, accountId, disabled});
    change('primary', true); change('account-2', true); change('primary', false);
    assert.deepEqual(controls.control(dir, 'mac-test', deviceId).disabledAccountIds, ['account-2']);
    assert.deepEqual(controls.control(dir, 'mac-other', deviceId).disabledAccountIds, []);
    assert.deepEqual(controls.control(dir, 'mac-test', 'different').disabledAccountIds, []);
    assert.throws(() => change('other', true)); assert.throws(() => change('primary', 'true'));
    fs.writeFileSync(path.join(dir, 'claude-account-control.json'), '{}');
    assert.throws(() => controls.control(dir, 'mac-test', deviceId), /nicht gelesen/);
    assert.throws(() => change('primary', false), /nicht gelesen/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('HTTP account locks require admin and exact device, persist through fresh reports and reach the admission helper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-lock-api-'));
  process.env.DATA_DIR = dir; process.env.TEAM_TOKEN = 'account-lock-test-owner'; delete process.env.TEAM_TOKENS;
  const {server} = require('../server'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/v1/teams/RSMACS01`;
  const call = async (route, method = 'GET', body, token = process.env.TEAM_TOKEN) => {
    const r = await fetch(base + route, { method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}) });
    return {status: r.status, body: await r.json()};
  };
  try {
    const member = (await call('/workers/enroll', 'POST', {workerId: 'mac-test', deviceId})).body.member;
    const route = '/workers/mac-test/claude-accounts/control', body = {deviceId, accountId: 'primary', disabled: true};
    assert.equal((await call(route, 'PATCH', body, member.token)).status, 403);
    assert.equal((await call(route, 'PATCH', {...body, deviceId: '12345678-1234-4234-8234-123456789abd'})).status, 409);
    assert.equal((await call(route, 'PATCH', {...body, disabled: 'true'})).status, 400);
    assert.equal((await call(route, 'PATCH', {...body, accountId: 'account-2'})).status, 409);
    assert.equal((await call(route, 'PATCH', body)).status, 200);
    assert.deepEqual((await call('/workers/mac-test/control')).body.disabledClaudeAccountIds, ['primary']);
    const sampledAt = new Date().toISOString();
    assert.equal((await call('/heartbeat', 'POST', {deviceId, workerId: 'mac-test', name: 'Test Mac', reportedAt: sampledAt, limits: []}, member.token)).status, 200);
    const report = {schema: 1, workerId: 'mac-test', deviceId, sampledAt, service: {running: true, lastPollAt: sampledAt},
      activity: {state: 'idle', acceptingTasks: true, runs: []}, claudeAccounts: {selectedAccountId: 'primary',
        accounts: ['primary', 'account-2'].map(id => ({id, name: `${id}@example.test`, status: 'ready', updatedAt: sampledAt, windows: []}))}};
    assert.equal((await call('/workers/mac-test/report', 'POST', report)).status, 200);
    assert.equal((await call(route, 'PATCH', {...body, accountId: 'account-2'})).status, 200);
    assert.deepEqual((await call('/workers/mac-test/control')).body.disabledClaudeAccountIds, ['primary', 'account-2']);
    assert.deepEqual((await call('/fleet')).body.machines.find(m => m.workerId === 'mac-test').claudeAccountControl.disabledAccountIds, ['primary', 'account-2']);
    assert.equal((await call('/workers/mac-test/report', 'POST', report)).status, 200);
    assert.deepEqual((await call('/workers/mac-test/control')).body.disabledClaudeAccountIds, ['primary', 'account-2']);
    await call(route, 'PATCH', {...body, disabled: false});
    assert.deepEqual((await call('/workers/mac-test/control')).body.disabledClaudeAccountIds, ['account-2']);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, {recursive: true, force: true}); }
});
