import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import policy from './task-state.cjs';
import { buildQueue, DEFAULT_WORKFLOWS, parseClaim, selectCurrentClaim, collectSnapshot, applyStoredCheckpoints } from './newsletter-monitor-bridge.mjs';
import { createStatusAudit, saveStatusAudit, STATUS_AUDIT_INTERVAL_MS } from './status-reconciliation.mjs';

const now = Date.parse('2026-10-16T00:00:00Z');
const task = (id, status = 'approval intern', tags = ['pre gen · fertig']) => ({ id, name: id,
  tags: tags.map(name => ({ name })), status: { status }, date_updated: String(now - 1000) });
const claim = (ts, state, overrides = {}) => ({ taskId: '12451cu7umh', jobId: '12451cu7umh',
  runId: 'run-' + ts, ts: String(ts) + '.000001', workflow: 'newsletter', state, heartbeat: now / 1000, ...overrides });

test('both observed Uficell cases stay completed despite old portable pause claims', () => {
  for (const [id, status] of [['12451cu7umh', 'approval intern'], ['12451cu7uu1', 'revision intern']]) {
    const paused = claim(100, 'running', { taskId: id, paused: true, portable: true });
    const finished = claim(200, 'final', { taskId: id, outcome: 'completed' });
    for (const claims of [[paused, finished], [finished, paused]]) {
      const [row] = buildQueue([task(id, status)], claims, DEFAULT_WORKFLOWS, { now });
      assert.equal(row.status, 'completed');
      assert.equal(row.attemptId, finished.runId);
      assert.equal(row.progress, 100);
      assert.ok(row.completedAt);
      assert.equal(policy.auditTaskStates([row]).length, 0);
    }
  }
});

test('latest terminal attempt retires old active owners while actual retries keep earliest-owner ordering', () => {
  const old = claim(100, 'running', { paused: true, portable: true });
  const ended = claim(200, 'final', { outcome: 'completed' });
  const first = claim(300, 'running'), contender = claim(400, 'running');
  assert.equal(selectCurrentClaim([old, ended], now), ended);
  assert.equal(selectCurrentClaim([old, ended, contender, first], now), first);
  const [retry] = buildQueue([task(old.taskId, 'pre-gen', ['pre gen · läuft'])], [old, ended, first], DEFAULT_WORKFLOWS, { now });
  assert.equal(retry.status, 'running');
  assert.equal(retry.attemptId, first.runId);
  assert.equal(retry.completedAt, undefined);
  assert.equal(retry.completionSource, undefined);
});

test('a portable pause and retry schedule never conceal the technical source blocker', () => {
  const paused = claim(100, 'running', { paused: true, portable: true });
  const [row] = buildQueue([task(paused.taskId, 'pre-gen', ['pre gen · blockiert'])], [paused], DEFAULT_WORKFLOWS, { now });
  assert.equal(row.status, 'blocked');
  applyStoredCheckpoints([row], [{ task_id: paused.jobId, run_id: 'foreign', ready_at: now }]);
  assert.equal(row.status, 'blocked');
  applyStoredCheckpoints([row], [{ task_id: paused.jobId, run_id: paused.runId, ready_at: now }]);
  assert.equal(row.status, 'blocked');
  assert.equal(row.phase, 'Blockiert · Fortschritt im RS Hub gesichert');
});

test('retry reservation and pause telemetry cannot replace a known technical failure', () => {
  const task={status:'blocked',attemptId:'20261023T103732Z-job',updatedAt:'2026-10-23T10:38:00Z'};
  for(const runId of [task.attemptId,'20261023T110000Z-job']){
    for(const run of [{status:'queued'},{status:'running',step:'Pausiert · automatische Fortsetzung'}])
      assert.equal(policy.reportMayReplace(task,{...run,runId},'2026-10-23T11:01:00Z'),false);
  }
  assert.equal(policy.reportMayReplace(task,{status:'running',runId:'20261023T110000Z-job'},'2026-10-23T11:01:00Z'),true);
});

test('terminal success outranks leftover paused metadata for every claim kind', () => {
  for (const [event, jobId] of [['ai_newsletter_claim', 'abc'], ['ai_klaviyo_upload_claim', 'abc-klaviyo'],
    ['ai_translation_claim', 'abc-uebersetzung-en'], ['ai_korrektur_claim', 'korrektur-cu-abc@123-intern']]) {
    const parsed = parseClaim({ ts: '100.000001', reactions: [{ name: 'white_check_mark' }],
      metadata: { event_type: event, event_payload: { task_id: jobId, run_id: 'r', worker: 'mac-1', state: 'final', paused: true, portable: true, heartbeat: now / 1000 } } });
    assert.equal(parsed.outcome, 'completed');
    if (event === 'ai_korrektur_claim') {
      const [row] = buildQueue([], [parsed], DEFAULT_WORKFLOWS, { now });
      assert.equal(row.status, 'completed');
    }
  }
});

test('live heartbeat cannot reopen a bound completion or dispatch an unanswered PM question', () => {
  const done = { id: 'x', workflow: 'upload', status: 'completed', attemptId: 'finished', completedAt: new Date(now - 5000).toISOString() };
  for (const runId of ['finished', 'old', 'unproved-new']) assert.equal(policy.reportMayReplace(done, { runId }, new Date(now).toISOString()), false);
  assert.equal(policy.reportMayReplace({ ...done, workflow: 'newsletter', sourceStatus: 'revision extern' }, { runId: 'new' }, new Date(now).toISOString()), false);
  assert.equal(policy.reportMayReplace({ status: 'queued', phase: 'Wartet · PM-Rückfrage' }, { runId: 'new' }, new Date(now).toISOString()), false);
  // Only an actual new source order reopens work; it has no old completion fields.
  assert.equal(policy.reportMayReplace({ status: 'queued', sourceStatus: 'pre-gen' }, { runId: 'new' }, new Date(now).toISOString()), true);
});

test('projection preserves manual decisions, separate corrections and real waiting work', () => {
  const manual = { id: 'manual', status: 'completed', completion: 'manual', phase: 'Manuell erledigt' };
  assert.deepEqual(policy.reconcileTask(manual), { ...manual, progress: 100,
    step: undefined, blockedReason: undefined, errorUrl: undefined });
  for (const workflow of ['upload', 'correction', 'translation', 'sales']) {
    const waiting = { id: workflow, workflow, status: 'queued', sourceStatus: 'revision intern', phase: 'Wartet · Fortsetzung in der zentralen Queue' };
    assert.equal(policy.reconcileTask(waiting).status, 'queued');
  }
  const current = policy.reconcileTask({ id: 'x', workflow: 'upload', status: 'running', completedAt: new Date(now).toISOString(), completionSource: 'slack' });
  assert.equal(current.status, 'running');
  assert.equal(current.completedAt, undefined);
});

test('manual completion clears stale blocker details while preserving the source and completion evidence', () => {
  const manual = { id: 'sales:1791753755.856959', workflow: 'sales', status: 'completed',
    phase: 'Manuell erledigt', sourceStatus: 'blocked', workerId: 'mac-worker',
    attemptId: 'same-source-attempt', taskVersion: 'same-source-version',
    completion: 'manual', completionSource: 'manual', completedAt: new Date(now - 5000).toISOString(),
    blockedReason: 'Mail 3 hat die Endabnahme nicht bestanden', step: 'QA blockiert',
    errorUrl: 'https://app.slack.com/archives/CERROR/p1791753755856959', progress: 65 };
  const original = structuredClone(manual);
  assert.deepEqual(policy.auditTaskStates([manual]).map(finding => finding.code), ['stale_terminal_details']);
  const result = policy.reconcileTask(manual);
  assert.equal(result.status, 'completed');
  assert.equal(result.phase, 'Manuell erledigt');
  assert.equal(result.progress, 100);
  for (const field of ['blockedReason', 'step', 'errorUrl']) assert.equal(result[field], undefined);
  for (const field of ['id', 'workflow', 'sourceStatus', 'workerId', 'attemptId', 'taskVersion',
    'completion', 'completionSource', 'completedAt']) assert.equal(result[field], manual[field]);
  assert.deepEqual(manual, original);
  assert.deepEqual(policy.auditTaskStates([result]), []);
  assert.deepEqual(policy.reconcileTask(result), result);
  assert.equal(policy.reportMayReplace(result, { runId: manual.attemptId }, new Date(now).toISOString()), false);
  const review = policy.reconcileTask({ ...manual, workflow: 'newsletter', sourceStatus: 'approval intern' });
  assert.equal(review.phase, 'Manuell erledigt');
  assert.equal(review.completionSource, 'manual');
  assert.deepEqual(policy.auditTaskStates([review]), []);
});

test('a fresh complete status audit records the manual blocker display as repaired', async () => {
  const sourceAt = new Date(now).toISOString();
  const manual = { id: 'sales:1791753755.856959', workflow: 'sales', status: 'completed',
    phase: 'Manuell erledigt', completion: 'manual', completionSource: 'manual',
    completedAt: new Date(now - 5000).toISOString(), blockedReason: 'Previous QA blocker' };
  let rows = [manual], saved;
  const audit = createStatusAudit({ now: () => now,
    readFleet: async () => ({ queue: { tasks: rows, source: { lastSuccessAt: sourceAt } } }),
    save: async report => { saved = report; } });
  await audit.begin();
  rows = rows.map(policy.reconcileTask);
  const report = await audit.finish({ source: { lastSuccessAt: sourceAt }, tasks: [
    { id: manual.id, workflow: 'sales', status: 'blocked', blockedReason: 'Previous QA blocker' },
  ] });
  assert.equal(report, saved);
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.repaired.map(entry => [entry.taskId, entry.code]),
    [[manual.id, 'stale_terminal_details']]);
  assert.equal(rows[0].completion, 'manual');
  assert.equal(rows[0].completedAt, manual.completedAt);
  assert.deepEqual(policy.auditTaskStates([{ id: 'stale', status: 'completed', blockedReason: 'real conflict' }])
    .map(finding => finding.code), ['stale_terminal_details']);
});

test('half-hour audit rereads the saved fleet, records repairs and waits a full interval', async () => {
  let time = now, refreshed = 0, reads = 0;
  const reports = [], sourceAt = new Date(now).toISOString();
  const broken = { id: 'x', workflow: 'newsletter', status: 'queued', sourceStatus: 'approval intern' };
  let rows = [broken];
  const audit = createStatusAudit({ now: () => time, readFleet: async () => { reads++; return { queue: { tasks: rows, source: { lastSuccessAt: sourceAt } } }; }, save: async report => reports.push(report) });
  await audit.begin(() => refreshed++);
  assert.equal(refreshed, 1);
  await audit.finish({ source: { error: 'partial' } });
  await audit.finish({ tasks: rows, source: { lastSuccessAt: sourceAt } }, { fresh: false });
  assert.equal(reports.length, 0);
  rows = rows.map(policy.reconcileTask);
  await audit.finish({ tasks: rows, source: { lastSuccessAt: sourceAt } });
  assert.equal(reports[0].ok, true);
  assert.equal(reports[0].tasksChecked, 1);
  assert.equal(reports[0].repaired[0].code, 'finished_pre_gen_reopened');
  assert.equal(reports[0].intervalSeconds, 1800);
  time += STATUS_AUDIT_INTERVAL_MS - 1;
  await audit.begin(() => refreshed++);
  assert.equal(reads, 2);
  time++;
  await audit.begin(() => refreshed++);
  assert.equal(refreshed, 2);
});

test('audit never certifies a concurrent source update or a missing/reopened publication', async () => {
  const reports = [], expected = { id: 'x', status: 'completed' };
  let sourceAt = 'newer', rows = [];
  const audit = createStatusAudit({ readFleet: async () => ({ queue: { tasks: rows, source: { lastSuccessAt: sourceAt } } }), save: async report => reports.push(report) });
  await audit.begin();
  await audit.finish({ tasks: [expected], source: { lastSuccessAt: 'old' } });
  assert.equal(reports.length, 0);
  sourceAt = 'old';
  await audit.finish({ tasks: [expected], source: { lastSuccessAt: 'old' } });
  assert.equal(reports[0].ok, false);
  assert.equal(reports[0].findings[0].code, 'published_task_missing');
  rows = [{ ...expected, status: 'running' }];
  await audit.finish({ tasks: [expected], source: { lastSuccessAt: 'old' } });
  assert.equal(reports[1].ok, false);
  assert.equal(reports[1].findings[0].code, 'published_completion_reopened');
});

test('audit evidence is atomic, private and bounded to 96 checks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'status-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'status-reconciliation.jsonl'), Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join('\n'));
  const report = { ok: true, tasksChecked: 728 };
  await saveStatusAudit(dir, report);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'status-reconciliation.json'))), report);
  assert.equal((await fs.readFile(path.join(dir, 'status-reconciliation.jsonl'), 'utf8')).trim().split('\n').length, 96);
  assert.equal((await fs.stat(path.join(dir, 'status-reconciliation.json'))).mode & 0o077, 0);
});

test('an unreadable continuation inventory retains the previous queue rather than guessing status', async () => {
  const snapshot = await collectSnapshot({ now,
    config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'claims' }, hub: {} },
    hubFetch: async () => ({ ok: true, status: 200, json: async () => ({ spaces: [], tasks: [], last_page: true }) }),
    claimReader: async () => [], fleetReader: async () => [],
    checkpointReader: async () => { throw new Error('Checkpoint inventory unavailable'); } });
  assert.match(snapshot.source.error, /Checkpoint inventory unavailable/);
  assert.equal(snapshot.tasks, undefined);
});
