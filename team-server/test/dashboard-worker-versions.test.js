const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.versionsUnderTest = { latestWorkerVersion, compareWorkerVersion, workerVersionFresh }; return;\n' + marker), context);
const { latestWorkerVersion, compareWorkerVersion, workerVersionFresh } = context.versionsUnderTest;
const now = Date.now();
const worker = (version = 'V1.10', extra = {}) => ({ workerId: 'mac-1', workerVersion: version,
  workerRevision: 'a'.repeat(40), workerLastSeenAt: new Date(now).toISOString(), workerStatus: 'online', ...extra });

test('the header chooses the highest numeric worker version, without using app or skill versions', () => {
  const latest = worker('V1.100');
  assert.equal(latestWorkerVersion([worker('V1.99'), latest, worker('V1.9'),
    { appVersion: '9.99' }, worker('unknown'), worker('V9.99', { workerId: undefined })]), latest);
  assert.equal(latestWorkerVersion([]), null);
  assert.equal(latestWorkerVersion([worker(undefined, { workerVersion: undefined })]), null);
});

test('fresh matching versions and revisions are current; older releases and different revisions are visible', () => {
  const latest = worker();
  assert.equal(compareWorkerVersion(worker('v1.10.0'), latest).state, 'current');
  assert.equal(compareWorkerVersion(worker('V1.9'), latest).label, 'Update ausstehend');
  assert.equal(compareWorkerVersion(worker('V1.10', { workerRevision: 'b'.repeat(40) }), latest).label, 'Abweichende Revision');
  assert.equal(compareWorkerVersion(worker('V1.10', { workerRevision: undefined }), latest).state, 'unknown');
});

test('stale, stopped, missing and unrecognized reports never claim an up-to-date running worker', () => {
  const stale = worker('V1.11', { workerLastSeenAt: new Date(now - 181000).toISOString() });
  assert.equal(latestWorkerVersion([worker(), stale]), stale, 'retain the known higher version even when stale');
  assert.equal(compareWorkerVersion(worker(), stale).state, 'unknown');
  assert.equal(compareWorkerVersion(stale, worker()).state, 'unknown');
  assert.equal(compareWorkerVersion({ workerId: 'mac-2' }, worker()).label, 'Nicht gemeldet');
  assert.equal(compareWorkerVersion(worker('branch-build'), worker()).state, 'unknown');
  const development = worker('V1.12-dev');
  assert.equal(latestWorkerVersion([worker(), development]), development);
  assert.equal(compareWorkerVersion(development, development).state, 'unknown', 'local changes are never treated as a released version');
  assert.equal(workerVersionFresh(worker('V1.10', { workerLastSeenAt: undefined, lastSeenAt: new Date(now).toISOString(), status: 'online' })), false,
    'a fresh native app heartbeat cannot refresh an unknown worker version');
  for (const extra of [{ service: { running: false } }, { agentStatus: 'silent' },
    { workerVersionReportedAt: new Date(now - 46000).toISOString() }]) {
    const direct = worker('V1.10', { workerVersionSource: 'agent', workerVersionReportedAt: new Date(now).toISOString(), agentStatus: 'online', service: { running: true }, ...extra });
    assert.equal(compareWorkerVersion(direct, worker()).state, 'unknown');
  }
});

test('equal version references prefer the newest observation and retain Hub-only compatibility', () => {
  const newer = worker('V1.10', { workerRevision: 'b'.repeat(40), workerVersionSource: 'agent', workerVersionReportedAt: new Date(now + 1000).toISOString(),
    agentStatus: 'online', service: { running: true } });
  assert.equal(latestWorkerVersion([worker(), newer]), newer);
  assert.equal(workerVersionFresh(worker('V1.10', { telemetrySource: 'worker', workerStatus: undefined,
    workerLastSeenAt: undefined, lastSeenAt: new Date(now).toISOString(), status: 'online' })), true);
});
