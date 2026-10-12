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
