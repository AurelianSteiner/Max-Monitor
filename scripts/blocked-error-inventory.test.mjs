import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildBlockedErrors, collectSnapshot, createClaimReader, listClaims, RESERVATION_LAG_PHASE, BLOCKER_GRACE_PHASE } from './newsletter-monitor-bridge.mjs';
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
    metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind, worker: 'mac-1', stage: 'update' } },
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

test('current tasks own the pipeline; old Slack errors cannot undo completions', t => {
  const { store, directory } = storeFor(t);
  const stale = task('blocked', 'old-clickup-tag');
  store.updateQueue('TEAM1234', { source, tasks: [stale] });
  const previous = store.snapshot('TEAM1234').queue.tasks[0];
  store.completeTask('TEAM1234', {}, { taskId: previous.id, taskVersion: previous.taskVersion });
  const blockedErrors = buildBlockedErrors([error()], channel, [task()]);
  store.updateQueue('TEAM1234', { source, tasks: [stale, task('completed'), task('failed', 'sales:canceled')], blockedErrors });
  const snap = createFleetStore(directory, () => now).snapshot('TEAM1234');
  assert.equal(snap.queue.tasks.filter(row => row.status === 'blocked').length, 0);
  assert.equal(snap.queue.tasks.find(row => row.id === stale.id).completion, 'manual');
  assert.equal(snap.queue.tasks.find(row => row.id === task().id).status, 'completed');
  assert.equal(snap.queue.tasks.find(row => row.id === 'sales:canceled').status, 'failed');
  assert.equal(snap.queue.errors[0].id, blockedErrors[0].id);
  assert.ok(snap.events.some(event => event.entityId === blockedErrors[0].id && event.type === 'task_blocked'));
  store.updateQueue('TEAM1234', { source, tasks: [stale], blockedErrors: [] });
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'completed');
  assert.ok(store.snapshot('TEAM1234').events.some(event => event.entityId === blockedErrors[0].id && event.type === 'task_removed'));
});

test('source failures and malformed error inventory cannot turn open errors into a false zero', t => {
  const { store } = storeFor(t);
  const blockedErrors = buildBlockedErrors([error()], channel);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors });
  store.updateQueue('TEAM1234', { source: { name: source.name, error: 'Slack unavailable' }, blockedErrors: [] });
  assert.equal(store.snapshot('TEAM1234').queue.errors.length, 1);
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].status, 'blocked');
  assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: [] }), e => e.status === 409);
  assert.equal(store.snapshot('TEAM1234').queue.tasks.length, 1);
  for (const mutation of [{ errorUrl: 'javascript:alert(1)' }, { errorUrl: 'https://example.com/archives/x/p1' }, { status: 'completed' }, { id: 'random' }]) {
    assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: [], blockedErrors: [{ ...blockedErrors[0], ...mutation }] }), e => e.status === 400);
    assert.equal(store.snapshot('TEAM1234').queue.tasks.length, 1);
  }
});

test('Sales lifecycle remains visible independently of the Slack error inventory', t => {
  const { store, directory } = storeFor(t);
  const sales = ['queued', 'running', 'blocked', 'failed', 'completed'].map((status, i) => ({
    id: `sales:1791753700.00000${i}`, title: `Sales ${status}`, workflow: 'sales', status,
    sourceStatus: status === 'blocked' ? 'aborted' : status, updatedAt: new Date(now).toISOString(),
  }));
  for (const messages of [[error()], []]) {
    store.updateQueue('TEAM1234', { source, tasks: sales, blockedErrors: buildBlockedErrors(messages, channel) });
    const snapshot = createFleetStore(directory, () => now).snapshot('TEAM1234');
    assert.deepEqual(snapshot.queue.tasks.filter(row => row.workflow === 'sales').map(row => [row.id, row.status]),
      sales.map(row => [row.id, row.status]));
    assert.equal(snapshot.queue.tasks.filter(row => row.id.startsWith('slack-error:')).length, 0);
    assert.equal(snapshot.queue.errors.length, messages.length);
  }
  store.updateQueue('TEAM1234', { source: { name: source.name, error: 'Slack unavailable' } });
  assert.equal(store.snapshot('TEAM1234').queue.tasks.filter(row => row.workflow === 'sales').length, sales.length);
});

test('a retry counts once as running while its old error is retained only as history', t => {
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors: buildBlockedErrors([error()], channel) });
  store.workerReport('TEAM1234', { schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'busy', acceptingTasks: true,
      runs: [{ id: task().id, runId: 'retry', title: 'Mail', workflow: 'newsletter', status: 'running' }] } });
  const snapshot = store.snapshot('TEAM1234');
  assert.deepEqual(snapshot.queue.tasks.map(row => row.status), ['running']);
  assert.equal(snapshot.queue.tasks[0].blockedReason, undefined);
  assert.equal(snapshot.queue.tasks[0].errorUrl, undefined);
  assert.equal(snapshot.queue.errors.length, 1);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors: [] });
  assert.deepEqual(store.snapshot('TEAM1234').queue.tasks.map(row => row.status), ['running']);
});

test('snapshot carries the Slack inventory only after a complete configured error-channel scan', async () => {
  let fail = false;
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { errors: channel }, hub: {} };
  const collect = () => collectSnapshot({ config, now, fleetReader: async () => [], hubFetch: async target => {
    const url = new URL(target);
    return { ok: true, json: async () => url.hostname !== 'slack.com' ? { spaces: [], tasks: [] }
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

// #ai-fehler nur bei menschlichem Handlungsbedarf (Till, 17.10.2026, Fehleraudit):
// one post per customer and cause may name several orders (task_ids). Max Monitor
// shows one row per order, all linking to the same post.
test('a cause post naming three orders becomes three rows with the same Slack link', t => {
  const jobs = ['abc@123', 'def@124-klaviyo', 'korrektur-cu-ghi@125-extern'];
  const runs = jobs.map((job, i) => `20261017T08000${i}Z-${job}`);
  const message = error('abc@123', '1791823000.000009');
  message.metadata.event_payload = { ...message.metadata.event_payload, run_id: runs[0], grund: 'stammdaten',
    ursache: 'f'.repeat(64), task_ids: [...jobs, jobs[0], 'not a job!'], run_ids: [...runs, runs[0], 'x'] };
  const queue = [task(), { id: 'clickup:upload:def', title: 'Upload Def', workflow: 'upload', status: 'blocked', url: 'https://app.clickup.com/t/def' }];
  const rows = buildBlockedErrors([message], channel, queue);
  assert.deepEqual(rows.map(row => [row.id, row.workflow, row.attemptId]), [
    [`slack-error:${channel}:1791823000.000009`, 'newsletter', runs[0]],
    [`slack-error:${channel}:1791823000.000009#${jobs[1]}`, 'upload', runs[1]],
    [`slack-error:${channel}:1791823000.000009#${jobs[2]}`, 'correction', runs[2]],
  ]);
  assert.equal(new Set(rows.map(row => row.errorUrl)).size, 1);
  assert.ok(rows.every(row => row.status === 'blocked' && row.blockedReason === 'Übergabe fehlgeschlagen' && row.phase === 'Offen in #ai-fehler'));
  assert.deepEqual(rows.map(row => row.url), ['https://app.clickup.com/t/abc', 'https://app.clickup.com/t/def', 'https://app.clickup.com/t/ghi']);
  assert.equal(rows[1].title, 'Upload Def');
  // A manual upload is left out, like a single copy of it.
  assert.equal(buildBlockedErrors([message], channel, queue, { manualUploadIds: new Set(['def']) }).length, 2);
  // The relay accepts these rows, enriches the matching task and keeps the permalink check.
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, tasks: queue, blockedErrors: rows });
  const snapshot = store.snapshot('TEAM1234');
  assert.equal(snapshot.queue.errors.length, 3);
  assert.equal(snapshot.queue.tasks.find(row => row.id === 'clickup:upload:def').errorUrl, rows[1].errorUrl);
  assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: queue,
    blockedErrors: [{ ...rows[1], errorUrl: `https://ruegamer-steiner.slack.com/archives/${channel}/p1791823000000001` }] }), e => e.status === 400);
  assert.throws(() => store.updateQueue('TEAM1234', { source, tasks: queue, blockedErrors: [{ ...rows[1], id: `${rows[0].id}#bad job` }] }), e => e.status === 400);
});

test('a complete error-channel scan hands the copies\' metadata to the cleanup; a partial one hands none', async () => {
  let fail = false;
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { errors: channel }, hub: {} };
  const reply = { ...error('abc@123', '1791823000.000002'), thread_ts: '1791823000.000001' };
  const collect = errorPayloads => collectSnapshot({ config, now, errorPayloads, fleetReader: async () => [], hubFetch: async target => {
    const url = new URL(target);
    return { ok: true, json: async () => url.hostname !== 'slack.com' ? { spaces: [], tasks: [] }
      : url.searchParams.get('channel') === channel ? { ok: true, messages: [error(), reply], has_more: fail }
      : { ok: true, messages: [], has_more: false } };
  } });
  const payloads = new Map([['stale', {}]]);
  await collect(payloads);
  assert.deepEqual([...payloads.keys()], ['1791823000.000001']);
  assert.equal(payloads.get('1791823000.000001').run_id, 'attempt-abc@123');
  fail = true;
  await collect(payloads);
  assert.equal(payloads.size, 0);
});

// KOR-10: a copy the worker rewrote for a withdrawn order („🛑 Abgebrochen:
// ClickUp-Status zurückgezogen“, state abgebrochen_tag_entfernt) is no open
// error. It never shows as blocked; under the 17.10. policy the worker deletes it.
test('a copy rewritten for a withdrawn order is no blocked row', () => {
  const withdrawn = error('korrektur-cu-abc@123-extern', '1791823000.000010');
  withdrawn.text = '*Korrektur · Kunde*\n🛑 Abgebrochen: ClickUp-Status zurückgezogen · keine automatische Fortsetzung: <https://app.clickup.com/t/abc|Mail>';
  withdrawn.metadata.event_payload = { ...withdrawn.metadata.event_payload, state: 'abgebrochen_tag_entfernt' };
  const open = error('abc@123', '1791823000.000011');
  open.metadata.event_payload = { ...open.metadata.event_payload, state: 'blockiert' };
  assert.deepEqual(buildBlockedErrors([withdrawn, open], channel, [task()]).map(row => row.id), [`slack-error:${channel}:1791823000.000011`]);
});

// Review D12-07: the relay rejects a whole snapshot when one row breaks its
// bounds (task.id <= 160, task.attemptId <= 200 characters). A cause row whose
// ID or run would exceed them is left out instead of stopping the queue.
test('cause rows stay within the relay bounds, so one long job never rejects the snapshot', t => {
  const long = 'x'.repeat(118) + '@1';
  const message = error('abc@123', '1791823000.000012');
  message.metadata.event_payload = { ...message.metadata.event_payload, grund: 'stammdaten',
    task_ids: ['abc@123', long, 'def@124'], run_ids: ['attempt-abc@123', `20261017T080000Z-${long}`, `20261017T080001Z-${'d'.repeat(200)}`] };
  const rows = buildBlockedErrors([message], channel, [task()]);
  assert.deepEqual(rows.map(row => row.id), [`slack-error:${channel}:1791823000.000012`, `slack-error:${channel}:1791823000.000012#def@124`]);
  assert.ok(rows.every(row => row.id.length <= 160 && (row.attemptId === undefined || row.attemptId.length <= 200)));
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, tasks: [task()], blockedErrors: rows });
  assert.equal(store.snapshot('TEAM1234').queue.errors.length, 2);
});

// The relay recognises the bridge's lag phase: the Mac's own report without the
// run turns it into a pending worker check (review D11-M2).
test('the relay knows the bridge\'s lagging-reservation phase', t => {
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, blockedErrors: [], tasks: [{ ...task('queued'), workerId: 'mac-1', attemptId: 'run-a', phase: RESERVATION_LAG_PHASE }] });
  store.workerReport('TEAM1234', { schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'idle', acceptingTasks: true, runs: [] } });
  assert.equal(store.snapshot('TEAM1234').queue.tasks[0].phase, 'Worker-Abgleich ausstehend');
});

// Fehleraudit 19.10.2026: the result grace keeps its phase when the Mac's own
// report no longer lists the just finished run.
test('the relay keeps the bridge\'s result-grace phase after the Mac stops reporting the run', t => {
  const { store } = storeFor(t);
  store.updateQueue('TEAM1234', { source, blockedErrors: [], tasks: [{ ...task('queued'), workerId: 'mac-1', attemptId: 'run-a', phase: BLOCKER_GRACE_PHASE }] });
  store.workerReport('TEAM1234', { schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'idle', acceptingTasks: true, runs: [] } });
  const [row] = store.snapshot('TEAM1234').queue.tasks;
  assert.deepEqual([row.status, row.phase], ['queued', BLOCKER_GRACE_PHASE]);
});

test('an #ai-fehler copy names its own owner and never inherits the queue row blocker fields', () => {
  const copy = (payload, reason, ts = '1791823000.000001') => ({ ts,
    text: `*Klaviyo-Upload · Kunde*\n:warning: Technisch blockiert: <https://app.clickup.com/t/abc|Mail>\nGrund: ${reason}`,
    metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind: 'lauf', worker: 'mac-1', task_id: 'abc@123-klaviyo',
      run_id: 'attempt-1', state: 'technisch_blockiert', ...payload } } });
  const queued = { id: 'clickup:upload:abc', title: 'Mail', workflow: 'upload', status: 'blocked', url: 'https://app.clickup.com/t/abc',
    reasonCode: 'blocker_context_missing', responsibleRole: 'Technik', nextStep: 'Old step', blockerKind: 'technical_failure',
    blockerOwner: 'technik', blockerSource: 'checkpoint', blockerSourceHash: 'a'.repeat(64), blockerRecordedAt: new Date(now).toISOString(), pmOwner: 'Ben Schulte' };
  const key = 'Klaviyo-Quellenbindung: Klaviyo-Schlüssel fehlt im RS Hub (KEY_NOT_SET) für uficell; Upload wartet auf den Schlüssel.';
  const [data] = buildBlockedErrors([copy({ grund: 'stammdaten' }, key)], channel, [queued]);
  assert.deepEqual([data.reasonCode, data.responsibleRole, data.blockerKind], ['master_data_missing', 'Stammdaten (RS Hub/ClickUp)', 'waiting_human']);
  for (const field of ['blockerOwner', 'blockerSource', 'blockerSourceHash', 'blockerRecordedAt']) assert.equal(data[field], undefined, field);
  assert.equal(data.pmOwner, 'Ben Schulte'); assert.equal(data.blockedReason, key);
  const [pm] = buildBlockedErrors([copy({ owner: 'pm', grund: 'mensch' }, 'Saved acceptance finding')], channel, [queued]);
  assert.equal(pm.responsibleRole, 'PM');
  const [title] = buildBlockedErrors([copy({ grund: 'eingabe' }, 'Kunde nicht eindeutig im RS Hub zugeordnet. Markt im Aufgabentitel eindeutig angeben, z. B. „· Europa“')], channel, [queued]);
  assert.equal(title.responsibleRole, 'PM', 'eingabe has no owner of its own; the text fallback decides');
  const [technical] = buildBlockedErrors([copy({ grund: 'erschoepft' }, 'Saved acceptance finding')], channel, [queued]);
  assert.deepEqual([technical.responsibleRole, technical.blockerKind], ['Technik', 'technical_failure']);
  const battery = { ts: '1791823000.000009', text: ':battery: `Pink` läuft auf Akku (29 %); Ladegerät anschließen.',
    metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind: 'system', worker: 'pink', stage: 'strom' } } };
  const [system] = buildBlockedErrors([battery], channel, [queued]);
  for (const field of ['reasonCode', 'responsibleRole', 'nextStep', 'blockerKind', 'blockerReason']) assert.equal(system[field], undefined, field);
});
