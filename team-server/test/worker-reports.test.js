const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateReport, publicReport } = require('../worker-reports');
const { createFleetStore } = require('../fleet');
const now = Date.now();
const report = () => ({ schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
  service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'idle', acceptingTasks: true, runs: [] } });
test('direct observations expire in 45 seconds and cannot claim idle without local evidence', () => {
  const accepted = validateReport(report(), now);
  assert.equal(publicReport(accepted, now + 44000).activity.fresh, true);
  assert.equal(publicReport(accepted, now + 46000).activity.fresh, false);
  assert.throws(() => validateReport({ ...report(), service: { running: false } }, now));
  assert.throws(() => validateReport({ ...report(), sampledAt: new Date(now + 60000).toISOString() }, now));
  assert.throws(() => validateReport({ ...report(), activity: { state: 'busy', acceptingTasks: true, runs: [{ id:'x',runId:'r',title:'x',workflow:'sales',status:'running',url:'https://user:secret@example.com' }] } }, now));
});
test('reports persist independently of minute queue snapshots and reject out-of-order observations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-reports-')); let clock = now;
  try {
    const store = createFleetStore(directory, () => clock);
    store.workerReport('TEAM1234', report());
    store.updateQueue('TEAM1234', { source: { name: 'test', lastSuccessAt: new Date(now).toISOString() }, tasks: [] });
    assert.equal(store.workerReportStatus('TEAM1234', 'mac-1').activity.fresh, true);
    assert.equal(store.workerReport('TEAM1234', { ...report(), sampledAt: new Date(now - 1000).toISOString() }).accepted, false);
    clock += 46000;
    assert.equal(createFleetStore(directory, () => clock).workerReportStatus('TEAM1234', 'mac-1').activity.fresh, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('running worker versions reach the fleet, prefer newer observations and preserve legacy Hub reports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-versions-')); let clock = now;
  try {
    const store = createFleetStore(directory, () => clock);
    const queue = version => ({ source: { name: 'test' }, tasks: [], observedWorkers: [{ workerId: 'mac-1',
      name: 'mac-1', lastSeenAt: new Date(clock).toISOString(), workerVersion: version, workerRevision: 'a'.repeat(40) }] });
    store.updateQueue('TEAM1234', queue('V1.9'));
    store.workerReport('TEAM1234', { ...report(), workerVersion: 'V1.10', workerRevision: 'b'.repeat(40) });
    let machine = store.snapshot('TEAM1234').machines[0];
    assert.equal(machine.workerVersion, 'V1.10');
    assert.equal(machine.workerRevision, 'b'.repeat(40));
    assert.equal(machine.workerVersionReportedAt, new Date(now).toISOString());
    assert.equal(machine.workerVersionSource, 'agent');
    clock += 1000;
    store.updateQueue('TEAM1234', queue('V1.11'));
    machine = store.snapshot('TEAM1234').machines[0];
    assert.equal(machine.workerVersion, 'V1.11', 'an older observer cannot overwrite a newer Hub report');
    assert.equal(machine.workerVersionReportedAt, new Date(clock).toISOString());
    assert.equal(machine.workerVersionSource, 'hub');
    const versionReportedAt = machine.workerVersionReportedAt;
    clock += 200000;
    store.workerReport('TEAM1234', { ...report(), sampledAt: new Date(clock).toISOString(),
      service: { running: true, lastPollAt: new Date(clock).toISOString() } });
    machine = store.snapshot('TEAM1234').machines[0];
    assert.equal(machine.workerVersion, 'V1.11', 'legacy observers retain Hub version evidence');
    assert.equal(machine.workerVersionReportedAt, versionReportedAt, 'a versionless live observation cannot refresh old version evidence');
    assert.equal(machine.workerLastSeenAt, new Date(clock).toISOString());
    assert.equal(publicReport(validateReport(report(), now), now).workerVersion, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('local active runs replace old completed tags in the live queue without inventing 100 percent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-queue-'));
  try {
    const store = createFleetStore(directory, () => now);
    store.updateQueue('TEAM1234', { source: { name: 'test', lastSuccessAt: new Date(now).toISOString() },
      tasks: [{ id:'clickup:newsletter:t',title:'Mail',workflow:'newsletter',status:'completed',progress:100 }] });
    store.workerReport('TEAM1234', { ...report(), activity: { state:'busy',acceptingTasks:false,
      runs:[{ id:'clickup:newsletter:t',runId:'new-attempt',title:'Mail',workflow:'newsletter',status:'running' }] } });
    const current = store.snapshot('TEAM1234').queue.tasks[0];
    assert.equal(current.status, 'running'); assert.equal(current.workerId, 'mac-1'); assert.equal(current.progress, undefined);
  } finally { fs.rmSync(directory, { recursive:true,force:true }); }
});

test('blocked corrections survive idle reports and restart, but a newer live attempt clears the old diagnosis', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-corrections-'));
  let clock = now;
  const source = { name: 'test', lastSuccessAt: new Date(now).toISOString() };
  const correction = { id: 'correction:job', title: 'Warm Up Kampagne', workflow: 'correction', status: 'blocked',
    workerId: 'mac-1', phase: 'Korrektur blockiert', blockedReason: 'Wochenfassung fehlt', attemptId: 'old', updatedAt: new Date(now).toISOString() };
  try {
    let store = createFleetStore(directory, () => clock);
    store.updateQueue('TEAM1234', { source, tasks: [correction] });
    store.workerReport('TEAM1234', report());
    store = createFleetStore(directory, () => clock);
    let row = store.snapshot('TEAM1234').queue.tasks[0];
    assert.equal(row.status, 'blocked'); assert.equal(row.workerId, 'mac-1'); assert.equal(row.blockedReason, 'Wochenfassung fehlt');
    assert.equal(store.workerReportStatus('TEAM1234', 'mac-1').activity.state, 'idle');
    const version = row.taskVersion;
    store.completeTask('TEAM1234', { role: 'super' }, { taskId: row.id, taskVersion: version });
    store.updateQueue('TEAM1234', { source, tasks: [{ ...correction, attemptId: 'new' }] });
    row = store.snapshot('TEAM1234').queue.tasks[0];
    assert.equal(row.status, 'blocked'); assert.notEqual(row.taskVersion, version);
    clock += 1000;
    store.workerReport('TEAM1234', { ...report(), sampledAt: new Date(clock).toISOString(), activity: { state: 'busy', acceptingTasks: true,
      runs: [{ id: correction.id, runId: 'retry', title: correction.title, workflow: 'correction', status: 'running' }] } });
    row = store.snapshot('TEAM1234').queue.tasks[0];
    assert.equal(row.status, 'running'); assert.equal(row.blockedReason, undefined);
    // A cached active report cannot overwrite a later confirmed block.
    store.updateQueue('TEAM1234', { source, tasks: [{ ...correction, updatedAt: new Date(clock + 1000).toISOString() }] });
    assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'blocked');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the correction upgrade preserves completion signatures of existing ordinary tasks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-completions-'));
  try {
    const store = createFleetStore(directory, () => now);
    store.updateQueue('TEAM1234', { source: { name: 'test' }, tasks: [
      { id: 'existing', title: 'Mail', workflow: 'newsletter', status: 'blocked', phase: 'Blockiert oder pausiert', workerId: 'mac-1' },
    ] });
    // Signature written by the deployed release before correction diagnoses existed.
    const existingVersion = require('node:crypto').createHash('sha256').update('["blocked","Blockiert oder pausiert","mac-1",null]').digest('hex');
    assert.equal(store.snapshot('TEAM1234').queue.tasks[0].taskVersion, existingVersion);
    store.completeTask('TEAM1234', { role: 'super' }, { taskId: 'existing', taskVersion: existingVersion });
    assert.equal(createFleetStore(directory, () => now).snapshot('TEAM1234').queue.tasks[0].status, 'completed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Figma evidence survives activity reports without refreshing its observation time or crossing devices', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-reports-')); let clock = now;
  try {
    const store = createFleetStore(directory, () => clock);
    const figmaAccount = { email: 'figma@example.com', observedAt: new Date(now - 3600000).toISOString(), source: 'worker-whoami' };
    const queue = { source: { name: 'test' }, tasks: [], observedWorkers: [{ workerId: 'mac-1', name: 'Mac', lastSeenAt: new Date(now).toISOString() }] };
    store.updateQueue('TEAM1234', queue);
    store.workerReport('TEAM1234', { ...report(), figmaAccount: { ...figmaAccount, accessToken: 'never-store' } });
    assert.deepEqual(store.snapshot('TEAM1234').machines[0].figmaAccount, figmaAccount);
    clock += 1000;
    store.workerReport('TEAM1234', { ...report(), sampledAt: new Date(clock).toISOString() });
    assert.deepEqual(store.snapshot('TEAM1234').machines[0].figmaAccount, figmaAccount);
    assert.throws(() => validateReport({ ...report(), figmaAccount: { ...figmaAccount, email: 'bad' } }, now));
    assert.throws(() => validateReport({ ...report(), figmaAccount: { ...figmaAccount, observedAt: new Date(now + 60000).toISOString() } }, now));
    const live = { ...figmaAccount, observedAt: new Date(now).toISOString(), source: 'mcp-whoami' };
    assert.deepEqual(publicReport(validateReport({ ...report(), figmaAccount: { ...live, accessToken: 'never-store' } }, now), now).figmaAccount, live);
    clock += 1000;
    store.workerReport('TEAM1234', { ...report(), deviceId: '00000000-0000-4000-8000-000000000001', sampledAt: new Date(clock).toISOString() });
    assert.equal(store.snapshot('TEAM1234').machines[0].figmaAccount, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
