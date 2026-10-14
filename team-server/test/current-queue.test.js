const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFleetStore } = require('../fleet');
const now = Date.parse('2026-10-13T02:50:00Z');
const at = offset => new Date(now + offset).toISOString();
const mail = (id, overrides = {}) => ({ id: `clickup:newsletter:${id}`, title: id, workflow: 'newsletter',
  status: 'blocked', url: `https://app.clickup.com/t/${id}`, updatedAt: at(-10000), ...overrides });
let errorSequence = 0;
const error = (id, offset, overrides = {}) => {
  const ts = `${(now + offset) / 1000}.${String(++errorSequence).padStart(6, '0')}`;
  return { ...mail(id), id: `slack-error:CERROR:${ts}`,
    errorUrl: `https://app.slack.com/archives/CERROR/p${ts.replace('.', '')}`,
    blockedReason: `error ${offset}`, updatedAt: at(offset), ...overrides };
};
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'current-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory, () => now);
  const update = (tasks, errors = []) => store.updateQueue('TEAM1234', { tasks, blockedErrors: errors,
    source: { name: 'ClickUp · Slack', lastSuccessAt: at(0) } });
  const report = (runs, offset = 0) => store.workerReport('TEAM1234', { schema: 1, workerId: 'mac-1', sampledAt: at(offset),
    service: { running: true, lastPollAt: at(offset) }, activity: { state: runs.length ? 'busy' : 'idle', acceptingTasks: true, runs } });
  return { store, update, report };
}

test('repeated errors enrich one current blocker; running, paused and completed tasks never count again as blocked', t => {
  const { store, update, report } = setup(t);
  update([mail('blocked'), mail('retry'), mail('paused', { status: 'queued', tags: ['pre gen · pausiert'] }),
    mail('done', { status: 'completed' }), mail('missing-error')],
    [error('blocked', -5000), error('blocked', -2000), error('retry', -5000), error('paused', -5000), error('done', -5000), error('orphan', -5000)]);
  report([{ id: mail('retry').id, title: 'retry', runId: 'new', workflow: 'newsletter', status: 'running' }]);
  const { tasks, errors } = store.snapshot('TEAM1234').queue;
  assert.equal(tasks.length, 5);
  assert.equal(new Set(tasks.map(row => row.id)).size, 5);
  assert.equal(tasks.filter(row => row.status === 'blocked').length, 2);
  assert.equal(tasks.find(row => row.id === mail('blocked').id).blockedReason, 'error -2000');
  assert.equal(tasks.find(row => row.id === mail('retry').id).status, 'running');
  assert.equal(tasks.find(row => row.id === mail('paused').id).status, 'paused');
  assert.equal(tasks.find(row => row.id === mail('done').id).status, 'completed');
  assert.equal(errors.length, 6);
});

test('a downstream human review overrides leftover running and blocking Pre-Gen tags', t => {
  const { store, update } = setup(t);
  update([mail('blog', { status: 'running', sourceStatus: 'approval intern', tags: ['pre gen · läuft'] }),
    mail('review', { sourceStatus: 'design revision extern' })], [error('review', -2000)]);
  for (const row of store.snapshot('TEAM1234').queue.tasks) {
    assert.equal(row.status, 'completed');
    assert.equal(row.progress, 100);
    assert.equal(row.blockedReason, undefined);
  }
});

test('a later pause or completion survives an older live report; a fresh resumed run overrides the old pause', t => {
  const { store, update, report } = setup(t);
  const run = { id: mail('paused').id, title: 'paused', runId: 'retry', workflow: 'newsletter', status: 'running' };
  report([run], -10000);
  update([mail('paused', { status: 'queued', updatedAt: at(-5000), phase: 'Pausiert · automatische Fortsetzung' })]);
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'paused');
  report([run], 0);
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'running');
  report([{ ...run, step: 'Pausiert: warte auf Zugang' }], 0);
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'paused');
});

test('an explicit fresh idle report removes a stale running assignment without creating a new marked task', t => {
  const { store, update, report } = setup(t);
  update([mail('old-run', { status: 'running', workerId: 'mac-1' })]);
  report([]);
  const row = store.snapshot('TEAM1234').queue.tasks[0];
  assert.equal(row.status, 'queued');
  assert.equal(row.workerId, null);
  assert.equal(row.phase, 'Worker-Abgleich ausstehend');
});

test('diagnoses do not cross correction jobs, workflow boundaries or newer blocking attempts', t => {
  const { store, update } = setup(t);
  const correction = job => ({ id: `correction:${job}`, title: 'Mail correction', workflow: 'correction', status: 'blocked',
    url: 'https://app.clickup.com/t/abc', attemptId: `20261013T020000Z-${job}` });
  const jobs = ['korrektur-cu-abc@123-intern', 'korrektur-cu-abc@124-extern'];
  update([correction(jobs[0]), correction(jobs[1]), mail('abc', { attemptId: 'new' })],
    [error('abc', -1000, { workflow: 'correction', attemptId: correction(jobs[0]).attemptId }), error('abc', -2000, { attemptId: 'old' })]);
  const rows = store.snapshot('TEAM1234').queue.tasks;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].blockedReason, 'error -1000');
  assert.equal(rows[1].blockedReason, undefined);
  assert.equal(rows[2].blockedReason, undefined);
});
