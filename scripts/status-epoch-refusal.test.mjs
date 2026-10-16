// Refused ClickUp status reads (F26, Till 16.10.2026): only that task waits, the
// queue, the status audit and the #ai-fehler cleanup keep running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatusEpochs, collectSnapshot } from './newsletter-monitor-bridge.mjs';
import { cleanupDecision } from './error-copy-cleanup.mjs';

const now = Date.parse('2026-10-16T09:00:00Z');
const since = '1792130000000';
const response = data => ({ ok: true, status: 200, json: async () => data });
const refused = status => ({ ok: false, status, json: async () => ({ err: 'refused' }) });
const task = (id, status, tags = [], extra = {}) => ({ id, name: `Aufgabe ${id}`, tags: tags.map(name => ({ name })),
  status: { status }, date_updated: String(now - 60000), ...extra });
const config = { clickup: { workspace_id: '24553341' }, slack: { channel_id: 'C0C6NMMGGJV' }, hub: {} };

test('a refused status batch is read task by task; a refused single read leaves only that task without an epoch', async () => {
  const calls = [];
  const fetcher = async target => {
    const url = new URL(target); calls.push(url.pathname);
    if (url.pathname.endsWith('/bulk_time_in_status/task_ids')) return refused(400);
    if (url.pathname === '/api/v2/task/a/time_in_status') return refused(400);
    return response({ current_status: { status: 'revision intern', since: '222' } });
  };
  const refusals = new Map();
  const reported = [];
  const tasks = [task('a', 'pre-gen'), task('b', 'revision intern')];
  const epochs = await readStatusEpochs(fetcher, tasks, { refusals, now, onRefused: (item, status) => reported.push([item.id, status]) });
  assert.deepEqual([...epochs], [['b', '222']]);
  assert.deepEqual(reported, [['a', 400]]);
  assert.deepEqual(calls, ['/api/v2/task/bulk_time_in_status/task_ids', '/api/v2/task/a/time_in_status', '/api/v2/task/b/time_in_status']);
  // Within 15 minutes the refused task is not read again and stays out of the batch.
  calls.length = 0;
  assert.deepEqual([...await readStatusEpochs(fetcher, tasks, { refusals, now: now + 60000 })], [['b', '222']]);
  assert.deepEqual(calls, ['/api/v2/task/b/time_in_status']);
  calls.length = 0;
  await readStatusEpochs(fetcher, tasks, { refusals, now: now + 15 * 60000 });
  assert.ok(calls.includes('/api/v2/task/a/time_in_status'), 'read again after 15 minutes');
  // A single listed task refused with 404 (deleted after the listing) is no outage either.
  assert.deepEqual([...await readStatusEpochs(async () => refused(404), [task('gone', 'pre-gen')])], []);
});

test('rate limits, server errors and transport errors still fail the cycle', async () => {
  for (const reply of [refused(429), refused(500), refused(503)]) {
    await assert.rejects(readStatusEpochs(async () => reply, [task('a', 'pre-gen'), task('b', 'pre-gen')]), /HTTP (429|50\d)/);
    await assert.rejects(readStatusEpochs(async () => reply, [task('a', 'pre-gen')]), /HTTP (429|50\d)/);
  }
  await assert.rejects(readStatusEpochs(async () => { throw new Error('Hub: SSH nicht erreichbar.'); }, [task('a', 'pre-gen')]), /SSH/);
  // A batch refusal followed by a single-read outage still fails.
  await assert.rejects(readStatusEpochs(async target => new URL(target).pathname.includes('bulk') ? refused(400) : refused(502),
    [task('a', 'pre-gen'), task('b', 'pre-gen')]), /HTTP 502/);
});

test('a snapshot stays fresh when ClickUp refuses a status read, and says which tasks wait', async () => {
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.hostname === 'slack.com') return response({ ok: true, messages: [], has_more: false });
    if (url.pathname.endsWith('/space')) return response({ spaces: [] });
    if (url.pathname.endsWith('/task')) return response({ tasks: [task('a', 'pre-gen'), task('b', 'revision intern'), task('c', 'klaviyo upload')], last_page: true });
    if (url.pathname.endsWith('/bulk_time_in_status/task_ids')) return refused(400);
    if (url.pathname === '/api/v2/task/c/time_in_status') return response({ current_status: { status: 'klaviyo upload', since } });
    return refused(403);
  };
  const warnings = [];
  const snapshot = await collectSnapshot({ now, config, hubFetch, fleetReader: async () => [], warn: message => warnings.push(message) });
  assert.equal(snapshot.source.error, undefined);
  const rows = new Map(snapshot.tasks.map(row => [row.id, row]));
  assert.deepEqual([...rows.keys()], ['clickup:newsletter:a', 'clickup:upload:c', 'correction:korrektur-cu-b-intern']);
  for (const id of ['clickup:newsletter:a', 'correction:korrektur-cu-b-intern']) {
    assert.equal(rows.get(id).status, 'queued');
    assert.match(rows.get(id).phase, /^Statusbeginn nicht lesbar \(HTTP 403\)/);
  }
  assert.equal(rows.get('clickup:upload:c').phase, undefined);
  assert.match(snapshot.source.detail, /2 ohne lesbaren Statusbeginn/);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(message => /HTTP 403/.test(message)));
  // The epoch-less correction never matches an error copy of a dated order.
  const fleet = { queue: { tasks: [{ ...rows.get('correction:korrektur-cu-b-intern'), status: 'running', workerId: 'macbook-1', attemptId: 'x' }],
    source: { status: 'fresh', stale: false, lastSuccessAt: new Date(now).toISOString() } } };
  assert.equal(cleanupDecision({ task_id: `korrektur-cu-b@${since}-intern` }, fleet, now).reason, 'unknown-task');
  for (const reply of [refused(429), refused(500)]) {
    const failed = await collectSnapshot({ now, config, fleetReader: async () => [],
      hubFetch: async target => new URL(target).pathname.includes('time_in_status') ? reply : hubFetch(target) });
    assert.match(failed.source.error, /HTTP (429|500)/);
    assert.equal(failed.tasks, undefined);
  }
});
