import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_WORKFLOWS, START_STATUSES, buildQueue, parseClaim, listStatusTasks, readStatusEpochs, collectSnapshot,
  parseRegisterClaim, readHubReservations, mergeHubClaims, hubRuntimeDirectory, parseObservedWorkers, readHubFleet, addRunDetails,
} from './newsletter-monitor-bridge.mjs';

const now = Date.parse('2026-10-16T09:00:00Z');
const since = '1792130000000';
const response = data => ({ ok: true, status: 200, json: async () => data });
const task = (id, status, tags = [], extra = {}) => ({ id, name: `Aufgabe ${id}`, tags: tags.map(name => ({ name })),
  status: { status }, date_updated: String(now - 60000), ...extra });
const slackClaim = (event, jobId, overrides = {}, message = {}) => parseClaim({ ts: '1792130100.000100', ...message, metadata: { event_type: event,
  event_payload: { task_id: jobId, run_id: `run-${jobId}`, worker: 'macbook-1', state: 'running', heartbeat: now / 1000 - 30, ...overrides } } });
const registerDoc = (overrides = {}) => ({ runId: '20261016T085900Z-a', taskId: `86abc@${since}`, worker: 'macworker-5-schwarz',
  state: 'running', channel: 'C0C6NMMGGJV', text: '*Pre-Gen*\n<https://app.clickup.com/t/86abc|Herbst>', ts: '1792130200.000007',
  heartbeat: now / 1000 - 20, hub: true, reactions: [], ...overrides });

test('an unreserved revision order is a waiting correction with the worker job identity', () => {
  const rows = buildQueue([task('T', 'revision extern', ['revision · wartet'], { statusSince: since, folder: { name: 'Kunde' } })], [], DEFAULT_WORKFLOWS, { now });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].workflow, rows[0].status, rows[0].workerId, rows[0].sourceStatus, rows[0].company],
    [`correction:korrektur-cu-T@${since}-extern`, 'correction', 'queued', undefined, 'revision extern', 'Kunde']);
  // Without an epoch (status changed during the read) the task still stays visible.
  assert.equal(buildQueue([task('T', 'revision intern')], [], DEFAULT_WORKFLOWS, { now })[0].id, 'correction:korrektur-cu-T-intern');
  // The worker parks manual tasks; nobody will reserve them.
  assert.deepEqual(buildQueue([task('M', 'revision intern', ['manuell'], { statusSince: since })], [], DEFAULT_WORKFLOWS, { now }), []);
  // PM questions and blockers of an unreserved order keep their meaning.
  assert.equal(buildQueue([task('Q', 'revision extern', ['revision · rückfrage slack'], { statusSince: since })], [], DEFAULT_WORKFLOWS, { now })[0].phase, 'Wartet · PM-Rückfrage');
  assert.equal(buildQueue([task('B', 'revision extern', ['revision · blockiert'], { statusSince: since })], [], DEFAULT_WORKFLOWS, { now })[0].status, 'blocked');
});

test('a reservation of the same correction round replaces the waiting row; an older round never hides it', () => {
  const order = task('T', 'revision extern', ['revision · läuft'], { statusSince: since });
  const live = slackClaim('ai_korrektur_claim', `korrektur-cu-T@${since}-extern`);
  let rows = buildQueue([order], [live], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual(rows.map(row => [row.id, row.status, row.workerId]), [[`correction:korrektur-cu-T@${since}-extern`, 'running', 'macbook-1']]);
  // Per-file jobs of the same round cover the package as well.
  const file = slackClaim('ai_korrektur_claim', `korrektur-cu-T@${since}-extern-file-${'a'.repeat(32)}`);
  rows = buildQueue([order], [file], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual(rows.map(row => row.id), [`correction:korrektur-cu-T@${since}-extern-file-${'a'.repeat(32)}`]);
  // The previous round finished; the PM set revision extern again.
  const old = slackClaim('ai_korrektur_claim', 'korrektur-cu-T@1792000000000-extern', { state: 'final' },
    { text: '*Korrektur · Kunde*\n✅ Fertig: <https://app.clickup.com/t/T|Herbst>' });
  rows = buildQueue([task('T', 'revision extern', ['revision · wartet'], { statusSince: since })], [old], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual(rows.map(row => [row.id, row.status]).sort(), [
    ['correction:korrektur-cu-T@1792000000000-extern', 'completed'], [`correction:korrektur-cu-T@${since}-extern`, 'queued']]);
});

test('waiting or running tags outside the start status are no orders; blocked and finished history stays', () => {
  const rows = buildQueue([
    task('w', 'go live', ['klaviyo upload · wartet']), task('legacy', 'approval extern', ['klaviyo upload']),
    task('pre', 'design', ['pre gen.']), task('paused', 'go live', ['klaviyo upload · pausiert']),
    task('blocked', 'go live', ['klaviyo upload · blockiert']), task('done', 'go live', ['klaviyo upload · fertig']),
  ], [], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['clickup:upload:blocked', 'blocked'], ['clickup:upload:done', 'completed']]);
  // A live reservation may still be finishing its abort and keeps its place visible.
  const finishing = slackClaim('ai_klaviyo_upload_claim', `w@${since}-klaviyo`);
  assert.deepEqual(buildQueue([task('w', 'go live', ['klaviyo upload · läuft'])], [finishing], DEFAULT_WORKFLOWS, { now })
    .map(row => [row.id, row.status, row.workerId]), [['clickup:upload:w', 'running', 'macbook-1']]);
  // Downstream review statuses still complete a Pre-Gen row (task-state.cjs).
  assert.equal(buildQueue([task('r', 'approval intern', ['pre gen · läuft'])], [], DEFAULT_WORKFLOWS, { now })[0].status, 'completed');
});

test('every task in its start status is an order, even before a tag exists; manual Pre-Gen is parked', () => {
  const previous = slackClaim('ai_newsletter_claim', 'n@1791000000000', { state: 'final' }, { reactions: [{ name: 'white_check_mark' }] });
  const rows = buildQueue([
    task('n', 'pre-gen', [], { statusSince: since }), task('u', 'klaviyo upload', [], { statusSince: since }),
    task('m', 'pre-gen', ['manuell'], { statusSince: since }), task('k', 'klaviyo upload', ['manuell'], { statusSince: since }),
  ], [previous], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['clickup:newsletter:n', 'queued'], ['clickup:upload:u', 'queued']]);
  // The finished earlier order never lends its Mac, attempt or completion to the new one.
  assert.deepEqual([rows[0].workerId, rows[0].attemptId, rows[0].completedAt], [undefined, undefined, undefined]);
  const current = slackClaim('ai_newsletter_claim', `n@${since}`);
  const [running] = buildQueue([task('n', 'pre-gen', ['pre gen · läuft'], { statusSince: since })], [previous, current], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual([running.status, running.workerId, running.attemptId], ['running', 'macbook-1', `run-n@${since}`]);
});

test('the order listing uses the worker statuses and dates each order like the worker', async () => {
  const calls = [];
  const fetcher = async target => {
    const url = new URL(target); calls.push(url);
    if (url.pathname.endsWith('/task')) return response(Number(url.searchParams.get('page')) === 0
      ? { tasks: [task('a', 'pre-gen'), task('x', 'offen')] } : { tasks: [task('b', 'Revision Extern')], last_page: true });
    if (url.pathname.endsWith('/bulk_time_in_status/task_ids')) return response({
      a: { current_status: { status: 'pre-gen', total_time: { since: '111' } } },
      b: { current_status: { status: 'approval intern', since: '222' } } });
    return response({ current_status: { status: 'revision extern', since: '333' } });
  };
  const listed = await listStatusTasks(fetcher, '24553341', START_STATUSES, { pageSize: 2 });
  assert.deepEqual(listed.map(item => item.id), ['a', 'b']);
  assert.deepEqual(calls[0].searchParams.getAll('statuses[]'), ['pre-gen', 'revision intern', 'revision extern', 'klaviyo upload']);
  assert.equal(calls[0].searchParams.get('include_closed'), 'false');
  calls.length = 0;
  const epochs = await readStatusEpochs(fetcher, listed);
  assert.deepEqual(calls[0].searchParams.getAll('task_ids'), ['a', 'b']);
  // b changed its status during the read: no epoch until the next cycle.
  assert.deepEqual([...epochs], [['a', '111']]);
  assert.deepEqual([...await readStatusEpochs(fetcher, [task('b', 'revision extern')])], [['b', '333']]);
  assert.match(calls.at(-1).pathname, /\/task\/b\/time_in_status$/);
});

test('register reservations are read only after the Hub switched to them', t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'register-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const root = path.join(runtime, 'state', 'worker-reservations');
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'claims.sqlite'));
  db.exec('CREATE TABLE reservations(run_id TEXT PRIMARY KEY, doc TEXT NOT NULL)');
  const insert = doc => db.prepare('INSERT INTO reservations VALUES (?,?)').run(doc.runId, JSON.stringify(doc));
  insert(registerDoc());
  insert(registerDoc({ runId: 'old', state: 'final', ts: String(now / 1000 - 90 * 86400) + '.000001' }));
  insert(registerDoc({ runId: 'test', taskId: `86abc@${since}-klaviyo-pruefauftrag` }));
  db.prepare('INSERT INTO reservations VALUES (?,?)').run('broken', '{');
  db.close();
  assert.equal(readHubReservations(runtime, { now }), null, 'no enabled marker: Slack stays the source');
  fs.writeFileSync(path.join(root, 'enabled'), '');
  const claims = readHubReservations(runtime, { now });
  assert.deepEqual(claims.map(claim => [claim.runId, claim.taskId, claim.workerId, claim.workflow, claim.state, claim.hub]),
    [['20261016T085900Z-a', '86abc', 'macworker-5-schwarz', 'newsletter', 'running', true]]);
  assert.equal(claims[0].title, 'Herbst');
  assert.equal(claims[0].threadTs, null, 'no Slack post yet: no thread to read');
  assert.equal(parseRegisterClaim({ ...registerDoc(), worker: 'Mac 1' }), null);
  assert.equal(parseRegisterClaim(registerDoc({ taskId: `korrektur-cu-T@${since}-intern`, reactions: ['question'], state: 'final' })).awaitingPm, true);
});

test('the register decides state and pause; Slack only adds its thread and the completion time', () => {
  const posted = slackClaim('ai_newsletter_claim', `86abc@${since}`, { run_id: '20261016T085900Z-a', state: 'running' }, { ts: '1792130201.000300' });
  const paused = parseRegisterClaim(registerDoc({ paused: true }));
  let [claim] = mergeHubClaims([posted], [paused]);
  assert.deepEqual([claim.state, claim.paused, claim.workerId, claim.threadTs, claim.ts], ['running', true, 'macworker-5-schwarz', '1792130201.000300', '1792130200.000007']);
  let [row] = buildQueue([task('86abc', 'pre-gen', ['pre gen · läuft'], { statusSince: since })], [claim], DEFAULT_WORKFLOWS, { now });
  assert.deepEqual([row.status, row.phase], ['queued', 'Pausiert · wartet außerhalb der Worker-Plätze']);
  const finishedAt = now / 1000 - 600;
  const slackFinal = slackClaim('ai_newsletter_claim', `86abc@${since}`, { run_id: '20261016T085900Z-a', state: 'final', heartbeat: finishedAt },
    { ts: '1792130201.000300', reactions: [{ name: 'white_check_mark' }] });
  [claim] = mergeHubClaims([slackFinal], [parseRegisterClaim(registerDoc({ state: 'final' }))]);
  assert.deepEqual([claim.outcome, claim.heartbeat, claim.completionTimestampKnown], ['completed', finishedAt, true]);
  // A register-only final has no trustworthy completion time.
  [claim] = mergeHubClaims([], [parseRegisterClaim(registerDoc({ state: 'final', reactions: ['white_check_mark'] }))]);
  assert.deepEqual([claim.outcome, claim.completionTimestampKnown], ['completed', false]);
  [row] = buildQueue([task('86abc', 'pre-gen', [], { statusSince: since })], [claim], DEFAULT_WORKFLOWS, { now });
  assert.equal(row.completedAt, undefined);
  assert.equal(mergeHubClaims([posted], null)[0], posted);
});

test('register heartbeats renewed on every worker sync do not re-read progress threads on the shared Slack token', async () => {
  const posted = slackClaim('ai_newsletter_claim', `86abc@${since}`, { run_id: '20261016T085900Z-a' }, { ts: '1792130201.000300' });
  const order = task('86abc', 'pre-gen', ['pre gen · läuft'], { statusSince: since });
  const statusCache = new Map();
  let reads = 0;
  const hubFetch = async () => { reads += 1; return response({ ok: true, messages: [{ ts: '1792130300.000001', bot_id: 'B1', text: '⏳ 40 % · Bau der Mail' }] }); };
  for (const [offset, beat] of [[0, now / 1000 - 40], [60000, now / 1000 - 5]]) {
    const claims = mergeHubClaims([posted], [parseRegisterClaim(registerDoc({ heartbeat: beat }))]);
    const rows = buildQueue([order], claims, DEFAULT_WORKFLOWS, { now: now + offset });
    await addRunDetails(rows, { hubFetch, channelId: 'C0C6NMMGGJV', statusCache, now: now + offset });
    assert.deepEqual([rows[0].status, rows[0].progress, rows[0].step], ['running', 40, 'Bau der Mail']);
  }
  assert.equal(reads, 1, 'only the Slack post changes or the 5-minute age trigger a new read');
  // A reservation without a Slack post has no thread to read.
  const [row] = buildQueue([order], [parseRegisterClaim(registerDoc())], DEFAULT_WORKFLOWS, { now });
  await addRunDetails([row], { hubFetch, channelId: 'C0C6NMMGGJV', statusCache: new Map(), now });
  assert.equal(reads, 1);
});

test('a finished register reservation keeps a stable time although the Hub renews its heartbeat', () => {
  const order = task('T', 'revision extern', [], { statusSince: since });
  const blocked = beat => parseRegisterClaim(registerDoc({ runId: 'r-blocked', taskId: `korrektur-cu-T@${since}-extern`, state: 'final', reactions: ['x'],
    text: '*Korrektur · Kunde*\n<https://app.clickup.com/t/T|Herbst>', heartbeat: beat }));
  const rows = [now / 1000 - 300, now / 1000 - 5].map(beat => buildQueue([order], mergeHubClaims([], [blocked(beat)]), DEFAULT_WORKFLOWS, { now })[0]);
  assert.deepEqual(rows.map(row => row.status), ['blocked', 'blocked']);
  // Operator clarifications are bound to updatedAt; it must not move every cycle.
  assert.equal(rows[0].updatedAt, rows[1].updatedAt);
  assert.equal(rows[0].updatedAt, new Date(1792130200 * 1000).toISOString());
});

test('a snapshot shows register reservations before Slack has the post, and survives an unreadable register', async () => {
  const config = { clickup: { workspace_id: '24553341' }, slack: { channel_id: 'C0C6NMMGGJV' }, hub: {} };
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.hostname === 'slack.com') return response({ ok: true, messages: [], has_more: false });
    if (url.pathname.endsWith('/space')) return response({ spaces: [] });
    if (url.pathname.endsWith('/task')) return response({ tasks: [task('86abc', 'pre-gen')], last_page: true });
    if (url.pathname.endsWith('/time_in_status')) return response({ current_status: { status: 'pre-gen', since } });
    throw new Error(`unexpected ${url}`);
  };
  const snapshot = await collectSnapshot({ now, config, hubFetch, fleetReader: async () => [],
    reservationReader: () => [parseRegisterClaim(registerDoc())] });
  assert.deepEqual(snapshot.tasks.map(row => [row.id, row.status, row.workerId, row.attemptId]),
    [['clickup:newsletter:86abc', 'running', 'macworker-5-schwarz', '20261016T085900Z-a']]);
  assert.match(snapshot.source.detail, /1 im Startstatus/);
  assert.match(snapshot.source.detail, /Reservierungen laut RS-Hub-Register/);
  const fallback = await collectSnapshot({ now, config, hubFetch, fleetReader: async () => [],
    reservationReader: () => { throw new Error('database is locked'); } });
  assert.equal(fallback.source.error, undefined);
  assert.deepEqual(fallback.tasks.map(row => [row.id, row.status]), [['clickup:newsletter:86abc', 'queued']]);
  assert.match(fallback.source.detail, /Reservierungsregister nicht lesbar/);
});

test('Hub observations keep the worker load, its places and maximum', () => {
  const seen = '2026-10-16T08:59:30Z';
  const [current, legacy, unknown] = parseObservedWorkers([
    { worker_id: 'macworker-5-schwarz', seen_at: seen, annahme: false, occupied_tasks: 6, max_tasks: 6,
      plaetze: { korrektur: 2, newsletter: 6, klaviyo: 6, translation: 6 } },
    { worker_id: 'macbook-1', seen_at: seen, annahme: true, occupied_tasks: 1, plaetze: { newsletter: 3, klaviyo: 3, translation: 3 } },
    { worker_id: 'unlisted-mac', seen_at: seen, occupied_tasks: 51, max_tasks: -1, plaetze: { newsletter: 99, klaviyo: 1, translation: 1 } },
  ], { maxTasksOf: id => ({ 'macworker-5-schwarz': 6, 'macbook-1': 3 })[id] ?? 4 });
  assert.deepEqual([current.occupiedTasks, current.maxTasks, current.acceptingTasks, current.places],
    [6, 6, false, { klaviyo: 6, korrektur: 2, newsletter: 6, translation: 6 }]);
  // Older workers send no maximum yet: the worker's own Mac table supplies it.
  assert.deepEqual([legacy.occupiedTasks, legacy.maxTasks, legacy.places], [1, 3, { klaviyo: 3, newsletter: 3, translation: 3 }]);
  assert.deepEqual([unknown.occupiedTasks, unknown.maxTasks, unknown.places], [undefined, 4, undefined]);
  // Without a table and without a reported value there is no invented maximum.
  assert.equal(parseObservedWorkers([{ worker_id: 'macbook-1', seen_at: seen }])[0].maxTasks, undefined);
});

test('the SSH fleet reader copies admission, load, maximum and places', async () => {
  let program = '';
  const rows = await readHubFleet({ ssh_host: 'root@example.test', identity_file: '~/.ssh/test', known_hosts_file: '/tmp/known', hub_dir: '/opt/rs-hub' }, {
    maxTasksOf: () => 4,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
      child.stdin.on('data', value => { program += value; });
      child.stdin.on('finish', () => {
        child.stdout.write(JSON.stringify([{ worker_id: 'mac-1', seen_at: '2026-10-16T08:59:00Z', annahme: true, occupied_tasks: 2 }]));
        child.emit('close', 0);
      });
      return child;
    },
  });
  for (const field of ['annahme', 'occupied_tasks', 'max_tasks', 'plaetze']) assert.match(program, new RegExp(`${field}:v\\.${field}`));
  assert.deepEqual([rows[0].acceptingTasks, rows[0].occupiedTasks, rows[0].maxTasks], [true, 2, 4]);
});

test('the register is read from the Hub runtime directory of the transport', () => {
  assert.equal(hubRuntimeDirectory('/opt/rs-hub', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), '/opt/rs-hub');
  assert.equal(hubRuntimeDirectory('/opt/rs-hub', () => 'X=1\nHUB_RUNTIME_DIR="/var/lib/rs-hub"\n'), '/var/lib/rs-hub');
  assert.throws(() => hubRuntimeDirectory('/opt/rs-hub', () => 'HUB_RUNTIME_DIR=../escape'), /sicherer absoluter Pfad/);
});
