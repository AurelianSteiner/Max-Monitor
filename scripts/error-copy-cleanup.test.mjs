import test from 'node:test';
import assert from 'node:assert/strict';
import { errorTaskKey, cleanupDecision, cleanupErrorCopies, createErrorCleanupWriter } from './error-copy-cleanup.mjs';
import { argumentsFrom } from './newsletter-monitor-bridge.mjs';
const channel = 'C0C8HK2NDFE';
const now = Date.parse('2026-10-13T20:20:00Z');
const auth = { ok: true, user_id: 'UBOT', bot_id: 'BBOT' };
const payload = { kind: 'lauf', task_id: 'abc@123', run_id: '20261013T202000Z-abc@123' };
const error = { id: `slack-error:${channel}:1791922800.123456`, workflow: 'newsletter', attemptId: payload.run_id };
const parent = { ts: '1791922800.123456', user: auth.user_id, bot_id: auth.bot_id,
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: payload } };
const task = (status = 'completed') => ({ id: 'clickup:newsletter:abc', title: 'Mail', workflow: 'newsletter', status });
const fleet = (tasks = [task()]) => ({ queue: { tasks, errors: [error], source: { status: 'fresh', stale: false,
  lastSuccessAt: new Date(now).toISOString() } } });

test('task binding preserves workflow, translation language and exact correction status/file identity', () => {
  assert.equal(errorTaskKey(payload), 'clickup:newsletter:abc');
  assert.equal(errorTaskKey({ task_id: 'abc@123-klaviyo' }), 'clickup:upload:abc');
  assert.equal(errorTaskKey({ task_id: 'abc@123-uebersetzung-en' }), 'clickup:translation-en:abc');
  const job = 'korrektur-cu-abc@123-extern-file-' + 'a'.repeat(32);
  assert.equal(errorTaskKey({ task_id: job }), 'correction:' + job);
  assert.equal(cleanupDecision({ task_id: job }, fleet([{ id: 'correction:korrektur-cu-abc@124-extern', status: 'completed' }]), now).reason, 'unknown-task');
  assert.equal(cleanupDecision({ task_id: 'abc@123-uebersetzung-en' }, fleet([{ id: 'clickup:translation-it:abc', status: 'completed' }]), now).remove, false);
  assert.equal(cleanupDecision(payload, fleet([{ id: 'clickup:upload:abc', status: 'completed' }]), now).remove, false);
});

test('only running or completed work clears copies; open, stale, unknown and currently blocked tasks remain', () => {
  for (const state of ['running', 'completed'])
    assert.equal(cleanupDecision(payload, fleet([task(state)]), now).remove, true);
  // ablauf.md (Till, 13.10.): a pause stays visible in #ai-fehler; a mere queue
  // acceptance, a marker or an open PM question never replaces the open copy.
  for (const state of ['queued', 'marked', 'paused', 'clarification'])
    assert.deepEqual([cleanupDecision(payload, fleet([task(state)]), now).remove, cleanupDecision(payload, fleet([task(state)]), now).reason], [false, 'still-open']);
  for (const state of ['blocked', 'failed', 'unknown'])
    assert.equal(cleanupDecision(payload, fleet([task(state)]), now).remove, false);
  assert.equal(cleanupDecision(payload, fleet([]), now).remove, false);
  const stale = fleet(); stale.queue.source.lastSuccessAt = new Date(now - 91000).toISOString();
  assert.equal(cleanupDecision(payload, stale, now).reason, 'source-not-fresh');
  stale.queue.source.error = 'ClickUp unavailable';
  assert.equal(cleanupDecision(payload, stale, now).remove, false);
});

test('cleanup deletes the owned mirror and bot replies across pages, preserving its source task and blocked upload', async () => {
  const snapshot = fleet([task(), { id: 'clickup:upload:def', workflow: 'upload', status: 'blocked' }]);
  snapshot.queue.errors.push({ id: `slack-error:${channel}:1791922800.222222`, workflow: 'upload', attemptId: '20261013T202000Z-def@1-klaviyo' });
  const writes = [], archived = [];
  const result = await cleanupErrorCopies({ now: () => now, errorChannel: channel, readFleet: async () => snapshot,
    hubFetch: async url => ({ ok: true, json: async () => new URL(url).searchParams.has('cursor')
      ? { ok: true, messages: [{ ts: '1791922800.654321', user: 'UBOT', bot_id: 'BBOT' }], has_more: false }
      : { ok: true, messages: [parent], has_more: true, response_metadata: { next_cursor: 'next' } } }),
    slackWrite: async (method, body) => { if (method === 'auth.test') return auth; writes.push(body); return { ok: true }; },
    archive: async entry => archived.push(entry) });
  assert.deepEqual(writes.map(row => row.ts), ['1791922800.654321', parent.ts]);
  assert.ok(writes.every(row => row.channel === channel));
  assert.deepEqual(result.deleted, [error.id]);
  assert.equal(result.kept[0].reason, 'still-blocked');
  assert.equal(archived.length, 1);
  assert.equal(snapshot.queue.tasks[0].status, 'completed');
});

test('open tasks keep their copy without authenticating or reading Slack', async () => {
  for (const state of ['queued', 'marked', 'paused', 'clarification']) {
    const result = await cleanupErrorCopies({ now: () => now, errorChannel: channel, readFleet: async () => fleet([task(state)]),
      hubFetch: async () => { throw Error('Must not read the thread'); },
      slackWrite: async () => { throw Error('Must not authenticate or delete'); } });
    assert.deepEqual(result, { deleted: [], kept: [{ id: error.id, reason: 'still-open' }] });
  }
});

test('a rate-limited thread read stops the cycle without deleting or throwing', async () => {
  for (const reply of [{ ok: false, status: 429, json: async () => ({ ok: false, error: 'ratelimited' }) },
    { ok: true, status: 200, json: async () => ({ ok: false, error: 'ratelimited' }) }]) {
    const writes = [];
    const snapshot = fleet([task('running')]);
    snapshot.queue.errors.push({ id: `slack-error:${channel}:1791922800.222222`, workflow: 'newsletter', attemptId: payload.run_id });
    let reads = 0;
    const result = await cleanupErrorCopies({ now: () => now, errorChannel: channel, readFleet: async () => snapshot,
      hubFetch: async () => { reads++; return reply; },
      slackWrite: async (method, body) => { if (method === 'auth.test') return auth; writes.push(body); return { ok: true }; } });
    assert.deepEqual(result, { deleted: [], kept: [], skipped: 'ratelimited' });
    assert.equal(writes.length, 0);
    assert.equal(reads, 1, 'the remaining threads are not read in the same cycle');
  }
});

test('human replies, foreign bots and changed metadata prevent all deletion', async () => {
  for (const messages of [
    [parent, { ts: '1791922800.654321', user: 'UHUMAN', text: 'Antwort' }],
    [{ ...parent, user: 'UOTHER' }],
    [{ ...parent, metadata: { event_type: 'ai_newsletter_fehler', event_payload: { ...payload, run_id: 'different' } } }],
  ]) {
    let deleted = false;
    const result = await cleanupErrorCopies({ now: () => now, errorChannel: channel, readFleet: async () => fleet(),
      hubFetch: async () => ({ ok: true, json: async () => ({ ok: true, messages }) }),
      slackWrite: async method => { if (method === 'auth.test') return auth; deleted = true; } });
    assert.equal(deleted, false);
    assert.equal(result.deleted.length, 0);
  }
});

test('a task newly blocked during the thread read is retained; incomplete sources never authenticate for deletion', async () => {
  let reads = 0, writes = 0;
  const result = await cleanupErrorCopies({ now: () => now, errorChannel: channel,
    readFleet: async () => fleet([task(++reads > 1 ? 'blocked' : 'running')]),
    hubFetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [parent] }) }),
    slackWrite: async method => { if (method === 'auth.test') return auth; writes++; } });
  assert.equal(writes, 0); assert.equal(result.deleted.length, 0);
  const stale = fleet(); stale.queue.source.stale = true;
  await cleanupErrorCopies({ now: () => now, errorChannel: channel, readFleet: async () => stale,
    slackWrite: async () => { throw Error('Must not authenticate'); } });
});

test('write transport is limited to the owned error channel and never posts or modifies tasks', async () => {
  const sent = [];
  const writer = createErrorCleanupWriter({}, { localHub: '/opt/rs-hub', errorChannel: channel,
    transport: { createHubFetch: () => async (url, options) => { sent.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; } } });
  await writer('auth.test'); await writer('chat.delete', { channel, ts: parent.ts });
  await assert.rejects(writer('chat.postMessage', { channel, text: 'no' }), /nur auth.test/);
  await assert.rejects(writer('chat.delete', { channel: 'CORIGINAL', ts: parent.ts }), /gesperrt/);
  await assert.rejects(writer('chat.delete', { channel, ts: parent.ts, text: 'no' }), /gesperrt/);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(row => row.options.method === 'POST'));
  assert.throws(() => argumentsFrom(['--cleanup-error-copies'], {}), /zentralen Hub-Dienst/);
  assert.equal(argumentsFrom(['--local-hub', '/opt/rs-hub', '--enrollment-config', '/etc/max-monitor/enrollment.json', '--cleanup-error-copies'], {}).cleanupErrorCopies, true);
});
