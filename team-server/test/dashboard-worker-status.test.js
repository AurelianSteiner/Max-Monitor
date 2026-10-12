const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the dashboard's real status functions, stopping before DOM initialization.
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.statusUnderTest = { machineDisplayStatus, workerFailureReason, machineAttentionReasons }; return;\n' + marker), context);
const status = context.statusUnderTest;
const healthy = () => ({ status: 'online', workerId: 'studio', workerStatus: 'online',
  telemetrySource: 'app', pendingClickup: 0, usageUpdatedAt: new Date().toISOString(),
  limits: [{ kind: 'session', percent: 20 }] });

test('pending ClickUp synchronization never turns a reachable worker into a blocked Mac', () => {
  for (const pendingClickup of [0, 1, 100]) {
    const machine = { ...healthy(), pendingClickup };
    assert.equal(status.machineDisplayStatus(machine), 'online');
    assert.equal(status.workerFailureReason(machine), null);
    assert.deepEqual(Array.from(status.machineAttentionReasons(machine)), []);
  }
});

test('real worker errors and lost worker heartbeats remain visible independently of synchronization', () => {
  const error = { ...healthy(), pendingClickup: 1, workerIssues: [
    { severity: 'error', stage: 'clickup_list', message: 'HTTP 401', reportedAt: new Date().toISOString() },
  ] };
  assert.equal(status.machineDisplayStatus(error), 'failed');
  assert.match(status.workerFailureReason(error), /ClickUp-Abfrage: HTTP 401/);
  assert.equal(status.machineDisplayStatus({ ...healthy(), workerStatus: 'offline' }), 'offline');
  assert.equal(status.machineDisplayStatus({ ...healthy(), status: 'offline', pendingClickup: 1 }), 'offline');
});
