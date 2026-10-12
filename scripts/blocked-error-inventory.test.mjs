import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildBlockedErrors, collectSnapshot, createClaimReader, listClaims } from './newsletter-monitor-bridge.mjs';
const { createFleetStore } = createRequire(import.meta.url)('../team-server/fleet.js');
const channel = 'C0C8HK2NDFE';
const now = Date.parse('2026-10-12T17:00:00Z');
const source = { name: 'ClickUp · Slack', lastSuccessAt: new Date(now).toISOString() };
const error = (job = 'abc@123', ts = '1791823000.000001', kind = 'lauf') => ({ ts,
  text: '*Newsletter Creation · Kunde*\n:warning: Technisch blockiert: <https://app.clickup.com/t/abc|Mail>\nGrund: Übergabe fehlgeschlagen\n<https://ruegamer-steiner.slack.com/archives/CSTATUS/p1|Original>',
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind, worker: 'mac-1', task_id: job, run_id: `attempt-${job}`, stage: 'update' } } });
const task = (status = 'blocked', id = 'clickup:newsletter:abc') => ({ id, title: 'Mail', workflow: 'newsletter', status, tags: ['pre gen · blockiert'] });
function storeFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-blockers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createFleetStore(directory, () => now) };
}

test('each error message maps to its exact workflow/attempt, even without a ClickUp row', () => {
  const jobs = ['abc@123', 'abc@123-klaviyo', 'abc@123-uebersetzung-en', 'korrektur-cu-abc@123-extern-file-b4f04c596092ebf32f72858ee3994969'];
  const messages = jobs.map((job, i) => error(job, `1791823000.00000${i}`));
  const rows = buildBlockedErrors([...messages, messages[0], { ts: '1791823000.1', subtype: 'channel_join' },
    { ...error(), ts: '1791823000.2', thread_ts: '1791823000.1' }], channel, [task()]);
  assert.deepEqual(rows.map(row => row.workflow), ['newsletter', 'upload', 'translation', 'correction']);
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
  assert.equal(rows[0].company, 'Kunde');
  assert.equal(rows[0].blockedReason, 'Übergabe fehlgeschlagen');
  assert.equal(rows[0].errorUrl, `https://ruegamer-steiner.slack.com/archives/${channel}/p1791823000000000`);
  assert.equal(rows[3].attemptId, `attempt-${jobs[3]}`);
  assert.equal(rows[3].url, 'https://app.clickup.com/t/abc');
});

test('system/update errors are represented individually, and diagnostics redact credentials', () => {
  const messages = ['system', 'update'].map((kind, i) => ({ ...error('', `1791823000.00000${i}`, kind),
    text: 'Worker-Fehler\n```HTTP 503 Bearer private-token token=private-key```' }));
  const rows = buildBlockedErrors(messages, channel);
  assert.deepEqual(rows.map(row => row.workflow), ['worker-errors', 'worker-errors']);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /private-token|private-key/);
});

test('full inventory reads have no age cutoff, page completely and retain cached run errors', async () => {
  const requests = [];
  const oldError = error('abc@123', '1691823000.000001');
  const reader = createClaimReader();
  const fetcher = async target => {
    const url = new URL(target); requests.push(url);
    return { ok: true, json: async () => url.searchParams.has('cursor')
      ? { ok: true, messages: [oldError], has_more: false }
      : { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'next' } } };
  };
  for (const at of [now, now + 1000]) {
    const messages = [];
    await reader(fetcher, channel, { now: at, lookbackDays: null, onMessage: message => messages.push(message) });
    assert.equal(buildBlockedErrors(messages, channel).length, 1);
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => !url.searchParams.has('oldest')));
  await assert.rejects(listClaims(async () => ({ ok: true, json: async () => ({ ok: true, messages: [oldError], has_more: true }) }), channel,
    { now, lookbackDays: null }), /Cursor fehlt/);
});

test('Slack errors determine all current blockers and are not replaced by old tags or manual completions', t => {
  const { store, directory } = storeFor(t);
  const stale = task('blocked', 'old-clickup-tag');
  store.updateQueue('TEAM1234', { source, tasks: [stale] });
  const previous = store.snapshot('TEAM1234').queue.tasks[0];
  store.completeTask('TEAM1234', {}, { taskId: previous.id, taskVersion: previous.taskVersion });
  const blockedErrors = buildBlockedErrors([error()], channel, [task()]);
  store.updateQueue('TEAM1234', { source, tasks: [stale, task('completed'), task('failed', 'sales:canceled')], blockedErrors });
  const snap = createFleetStore(directory, () => now).snapshot('TEAM1234');
  assert.equal(snap.queue.tasks.filter(row => row.status === 'blocked').length, 1);
  assert.equal(snap.queue.tasks.some(row => row.id === stale.id), false);
  assert.equal(snap.queue.tasks.some(row => row.id === 'sales:canceled'), false);
  const blocker = snap.queue.tasks.find(row => row.status === 'blocked');
  assert.equal(blocker.id, blockedErrors[0].id);
  assert.throws(() => store.completeTask('TEAM1234', {}, { taskId: blocker.id, taskVersion: blocker.taskVersion }),
    e => e.status === 409 && /#ai-fehler/.test(e.message));
  store.updateQueue('TEAM1234', { source, tasks: [stale], blockedErrors: [] });
  assert.deepEqual(store.snapshot('TEAM1234').queue.tasks, []);
  assert.ok(store.snapshot('TEAM1234').events.some(event => event.entityId === blocker.id && event.type === 'task_removed'));
});

test('source failures and malformed error inventory cannot turn open errors into a false zero', t => {
  const { store } = storeFor(t);
  const blockedErrors = buildBlockedErrors([error()], channel);
  store.updateQueue('TEAM1234', { source, tasks: [], blockedErrors });
  store.updateQueue('TEAM1234', { source: { name: source.name, error: 'Slack unavailable' }, blockedErrors: [] });
  assert.equal(store.snapshot('TEAM1234').queue.tasks.length, 1);
  assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: [] }), e => e.status === 409);
  assert.equal(store.snapshot('TEAM1234').queue.tasks.length, 1);
  for (const mutation of [{ errorUrl: 'javascript:alert(1)' }, { errorUrl: 'https://example.com/archives/x/p1' }, { status: 'completed' }, { id: 'random' }]) {
    assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: [], blockedErrors: [{ ...blockedErrors[0], ...mutation }] }), e => e.status === 400);
    assert.equal(store.snapshot('TEAM1234').queue.tasks.length, 1);
  }
});

test('a retry stays running without erasing its old error until Slack removes that message', t => {
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors: buildBlockedErrors([error()], channel) });
  store.workerReport('TEAM1234', { schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'busy', acceptingTasks: true,
      runs: [{ id: task().id, runId: 'retry', title: 'Mail', workflow: 'newsletter', status: 'running' }] } });
  assert.deepEqual(store.snapshot('TEAM1234').queue.tasks.map(row => row.status).sort(), ['blocked', 'running']);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors: [] });
  assert.deepEqual(store.snapshot('TEAM1234').queue.tasks.map(row => row.status), ['running']);
});

test('snapshot carries the Slack inventory only after a complete configured error-channel scan', async () => {
  let fail = false;
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { errors: channel }, hub: {} };
  const collect = () => collectSnapshot({ config, now, fleetReader: async () => [], hubFetch: async target => {
    const url = new URL(target);
    return { ok: true, json: async () => url.hostname !== 'slack.com' ? { spaces: [] }
      : url.searchParams.get('channel') === channel ? { ok: true, messages: [error()], has_more: fail }
      : { ok: true, messages: [], has_more: false } };
  } });
  assert.equal((await collect()).blockedErrors.length, 1);
  fail = true;
  const partial = await collect();
  assert.match(partial.source.error, /Cursor fehlt/);
  assert.equal(Object.hasOwn(partial, 'blockedErrors'), false);
  assert.equal(Object.hasOwn(partial, 'tasks'), false);
});

test('conflicting live owners keep accepted work visible without adding a non-Slack blocker', t => {
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, tasks: [], blockedErrors: [] });
  for (const workerId of ['mac-1', 'mac-2']) store.workerReport('TEAM1234', { schema: 1, workerId, sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'busy', acceptingTasks: true,
      runs: [{ id: task().id, runId: 'attempt', title: 'Mail', workflow: 'newsletter', status: 'running' }] } });
  const rows = store.snapshot('TEAM1234').queue.tasks;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'running');
  assert.equal(rows[0].phase, 'Mehrere Worker melden denselben Auftrag');
});
