import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_WORKFLOWS, normalizeTag, validateWorkflows, discoverTags, listTasks,
  parseClaim, listClaims, buildQueue, parseObservedWorkers, readHubFleet,
  collectSnapshot, relayEndpoint, publishSnapshot, syncOnce,
} from './newsletter-monitor-bridge.mjs';

const now = Date.parse('2026-10-07T12:00:00Z');
const response = data => ({ ok: true, status: 200, json: async () => data });
const task = (id, tags = ['pre gen.']) => ({ id, name: `Aufgabe ${id}`, tags: tags.map(name => ({ name })), date_updated: String(now), status: { status: 'offen' } });
const claimMessage = (state = 'running', overrides = {}) => ({ ts: '1791373200.001', metadata: {
  event_type: 'ai_newsletter_claim', event_payload: { task_id: 'a', run_id: 'run-1', worker: 'newsletter-mac-1', state, heartbeat: now / 1000 - 60, ...overrides },
} });

test('tag discovery uses actual spelling from all spaces and recognizes punctuation', async () => {
  const called = [];
  const variants = await discoverTags(async target => {
    const url = new URL(target); called.push(url.pathname);
    if (url.pathname.endsWith('/space')) return response({ spaces: [{ id: 'one' }, { id: 'two' }] });
    return response({ tags: url.pathname.includes('/one/') ? [{ name: 'Pre-Gen.' }, { name: 'unrelated' }] : [{ name: 'PRE GEN · LÄUFT' }, { name: 'Upload' }] });
  }, '24553341', DEFAULT_WORKFLOWS);
  assert.deepEqual(variants, ['Pre-Gen.', 'PRE GEN · LÄUFT', 'Upload']);
  assert.equal(called.length, 3);
  assert.equal(normalizeTag(' Pre-Gen. '), normalizeTag('pre gen.'));
});

test('ClickUp pagination deduplicates across tags and refuses a truncated list', async () => {
  const calls = [];
  const fetcher = async target => {
    const url = new URL(target); const page = Number(url.searchParams.get('page')); calls.push([url.searchParams.get('tags[]'), page]);
    assert.equal(url.searchParams.get('include_closed'), 'false'); assert.equal(url.searchParams.get('subtasks'), 'true');
    return response(page === 0 ? { tasks: [task('a'), task('b')] } : { tasks: [task('c')], last_page: true });
  };
  const tasks = await listTasks(fetcher, '24553341', ['pre gen.', 'pre gen · läuft'], { pageSize: 2 });
  assert.deepEqual(tasks.map(value => value.id), ['a', 'b', 'c']);
  assert.deepEqual(calls, [['pre gen.', 0], ['pre gen.', 1], ['pre gen · läuft', 0], ['pre gen · läuft', 1]]);
  await assert.rejects(() => listTasks(fetcher, '24553341', ['pre gen.'], { pageSize: 2, maxPages: 1 }), /unvollständig/);
});

test('Slack metadata pagination reads every page and fails without continuation cursor', async () => {
  let page = 0;
  const claims = await listClaims(async target => {
    const url = new URL(target); assert.equal(url.searchParams.get('include_all_metadata'), 'true');
    if (page++ === 0) return response({ ok: true, messages: [claimMessage()], has_more: true, response_metadata: { next_cursor: 'next' } });
    assert.equal(url.searchParams.get('cursor'), 'next');
    return response({ ok: true, messages: [claimMessage('released', { task_id: 'b' })], has_more: false });
  }, 'C0C6NMMGGJV', { now });
  assert.equal(claims.length, 2); assert.equal(claims[0].workerId, 'newsletter-mac-1');
  assert.equal(parseClaim({ metadata: { event_type: 'other' } }), null);
  await assert.rejects(() => listClaims(async () => response({ ok: true, messages: [], has_more: true }), 'channel', { now }), /Cursor/);
});

test('queue separates workflows and makes stale claims visible without inventing progress', () => {
  const claims = [parseClaim(claimMessage()), parseClaim(claimMessage('running', { task_id: 'stale', heartbeat: now / 1000 - 1900 }))];
  const queue = buildQueue([
    task('a', ['pre gen.', 'upload']), task('stale'), task('blocked', ['pre gen · blockiert']),
    task('done', ['pre gen · fertig']), task('ignored', ['unrelated']),
  ], claims, DEFAULT_WORKFLOWS, { now });
  assert.equal(queue.length, 5);
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').status, 'running');
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').workerId, 'newsletter-mac-1');
  assert.equal(queue.find(row => row.id === 'clickup:upload:a').status, 'queued');
  assert.equal(queue.find(row => row.id === 'clickup:upload:a').workerId, undefined);
  assert.equal(queue.find(row => row.id.endsWith(':stale')).status, 'blocked');
  assert.equal(queue.find(row => row.id.endsWith(':stale')).phase, 'Worker meldet sich nicht mehr');
  assert.equal(queue.find(row => row.id.endsWith(':blocked')).status, 'blocked');
  assert.equal(queue.find(row => row.id.endsWith(':done')).progress, 100);
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').progress, undefined);
});

test('released claims do not mark a queued task running; explicit completed tag wins', () => {
  const queue = buildQueue([task('a'), task('b', ['pre gen · fertig'])], [
    parseClaim(claimMessage('released')), parseClaim(claimMessage('running', { task_id: 'b' })),
  ], DEFAULT_WORKFLOWS, { now });
  assert.equal(queue[0].status, 'queued'); assert.equal(queue[0].workerId, undefined);
  assert.equal(queue[1].status, 'completed');
});

test('legitimate multiline ClickUp display text is flattened and bounded without changing identity', () => {
  const source = task('86cbau0hv', ['pre gen · läuft', '\tCampaign\nQ4', 'x'.repeat(100)]);
  source.name = '  Newsletter\n\tHerbstaktion\u0000  ';
  source.status.status = 'in\narbeit';
  const queue = buildQueue([source], [], DEFAULT_WORKFLOWS, { now });
  assert.equal(queue[0].id, 'clickup:newsletter:86cbau0hv');
  assert.equal(queue[0].title, 'Newsletter Herbstaktion');
  assert.equal(queue[0].sourceStatus, 'in arbeit');
  assert.equal(queue[0].status, 'running');
  assert.equal(queue[0].tags[1], 'Campaign Q4'); assert.equal(queue[0].tags[2].length, 80);
  source.name = 'x'.repeat(500); assert.equal(buildQueue([source], [], DEFAULT_WORKFLOWS, { now })[0].title.length, 300);
});

test('custom workflows require valid unique IDs and recognized statuses', () => {
  assert.deepEqual(validateWorkflows([{ id: 'correction', triggerTags: ['correction'], stateTags: { running: ['correction · läuft'] } }])[0].id, 'correction');
  assert.throws(() => validateWorkflows([{ id: 'bad', triggerTags: [''], stateTags: {} }]), /Tag ungültig/);
  assert.throws(() => validateWorkflows([{ id: 'bad', triggerTags: ['ok'], stateTags: { unknown: ['x'] } }]), /Status-Tags/);
  assert.throws(() => validateWorkflows([...DEFAULT_WORKFLOWS, DEFAULT_WORKFLOWS[0]]), /eindeutig/);
});

test('Hub observations contain no usage or battery values and reject invalid identity/timestamp', () => {
  const rows = parseObservedWorkers([
    { worker_id: 'mac-1', seen_at: '2026-10-07T11:59:00Z', worker_version: 'V1.15', worker_revision: 'a'.repeat(40), pending_clickup: 2, private_key: 'never-return' },
    { worker_id: '../unsafe', seen_at: '2026-10-07T11:59:00Z' }, { worker_id: 'mac-2', seen_at: 'bad' },
  ]);
  assert.equal(rows.length, 1); assert.equal(rows[0].workerId, 'mac-1');
  assert.equal(rows[0].pendingClickup, 2); assert.equal(rows[0].private_key, undefined);
  assert.equal(rows[0].limits, undefined); assert.equal(rows[0].batteryPercent, undefined);
});

test('fleet reader uses verified SSH hosts and a fixed read-only stdin program', async () => {
  let captured;
  const rows = await readHubFleet({ ssh_host: 'root@example.test', identity_file: '~/.ssh/test', known_hosts_file: '/tmp/fleet known', hub_dir: '/opt/rs-hub' }, {
    spawnImpl: (command, args) => {
      captured = { command, args }; const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
      let program = ''; child.stdin.on('data', value => { program += value; });
      child.stdin.on('finish', () => {
        assert.match(program, /fs\.readdirSync/); assert.doesNotMatch(program, /writeFile|mkdir|renameSync|team-secrets/);
        child.stdout.write(JSON.stringify([{ worker_id: 'mac-1', seen_at: '2026-10-07T11:59:00Z' }])); child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(rows.length, 1); assert.equal(captured.command, 'ssh');
  assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(captured.args.includes('UserKnownHostsFile="/tmp/fleet known"'));
  await assert.rejects(() => readHubFleet({ ssh_host: 'root@example.test; unsafe', hub_dir: '/opt/rs-hub' }), /Konfiguration/);
});

test('a source failure posts only an error and never clears accepted queue/cache', async () => {
  const posted = []; let saves = 0;
  const result = await syncOnce({ collect: async () => { throw new Error('ClickUp: HTTP 503.'); },
    publish: async value => posted.push(value), cachedSource: { lastSuccessAt: '2026-10-07T11:00:00Z' }, save: async () => { saves += 1; } });
  assert.equal(result.ok, false); assert.equal(saves, 0); assert.equal(posted.length, 1);
  assert.equal('tasks' in posted[0], false); assert.equal(posted[0].source.lastSuccessAt, '2026-10-07T11:00:00Z');
  assert.match(posted[0].source.error, /503/);
});

test('a genuine complete empty queue is published and cached only after relay acceptance', async () => {
  const events = []; const snapshot = { tasks: [], source: { name: 'ClickUp', lastSuccessAt: '2026-10-07T12:00:00Z' } };
  const result = await syncOnce({ collect: async () => snapshot, publish: async () => events.push('publish'), save: async () => events.push('save') });
  assert.equal(result.ok, true); assert.deepEqual(events, ['publish', 'save']);
  await assert.rejects(() => syncOnce({ collect: async () => snapshot, publish: async () => { throw new Error('relay unavailable'); }, save: async () => events.push('bad') }), /relay unavailable/);
  assert.deepEqual(events, ['publish', 'save']);
});

test('missing Hub observations do not discard a verified ClickUp/Slack snapshot', async () => {
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: '24553341' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => String(target).includes('slack.com') ? response({ ok: true, messages: [], has_more: false }) : response({ spaces: [] }),
    fleetReader: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(snapshot.tasks, []); assert.equal(snapshot.observedWorkers, undefined);
  assert.match(snapshot.source.detail, /Worker-Dateien nicht verfügbar/); assert.equal(snapshot.source.error, undefined);
});

test('relay publishing requires TLS, keeps token in header and rejects redirects', async () => {
  assert.throws(() => relayEndpoint('http://external.test', 'DEMO1234'), /HTTPS/);
  assert.throws(() => relayEndpoint('https://user:pass@example.test', 'DEMO1234'), /HTTPS/);
  assert.equal(relayEndpoint('http://127.0.0.1:8080', 'DEMO1234').pathname, '/v1/teams/DEMO1234/queue');
  await publishSnapshot({ tasks: [] }, { relayUrl: 'https://example.test', teamId: 'DEMO1234', token: 'test-token', fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token'); assert.equal(options.redirect, 'error');
    assert.doesNotMatch(String(url), /test-token/); return { ok: true, status: 200 };
  } });
});

test('installer generates a valid launchd template without including a supplied token or loading a service', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-installer-test-'));
  try {
    const workerRoot = path.join(directory, 'worker fixture');
    await fs.mkdir(path.join(workerRoot, 'src'), { recursive: true }); await fs.mkdir(path.join(workerRoot, 'config'));
    await fs.writeFile(path.join(workerRoot, 'src/config.js'), 'module.exports = { loadConfig() { return {}; } };');
    await fs.writeFile(path.join(workerRoot, 'src/hub-transport.js'), 'module.exports = {};');
    await fs.writeFile(path.join(workerRoot, 'config/worker.local.json'), '{}');
    const output = path.join(directory, 'generated'); const secret = 'installer-test-secret-never-write';
    execFileSync('/bin/bash', [path.resolve('scripts/install-newsletter-monitor.sh'), '--generate-only', '--output-dir', output], {
      env: { ...process.env, NEWSLETTER_WORKER_ROOT: workerRoot, MONITOR_TEAM_ID: 'DEMO1234',
        MONITOR_RELAY_URL: 'https://monitor.example.test', MONITOR_NODE_PATH: process.execPath, MONITOR_BRIDGE_TOKEN: secret,
        MONITOR_BRIDGE_INTERVAL_SECONDS: '60', MONITOR_WORKFLOWS_FILE: '', MONITOR_HUB_FLEET_DIRECTORY: '', MONITOR_BRIDGE_CACHE: '' },
      encoding: 'utf8',
    });
    const plistFile = path.join(output, 'de.max-monitor.newsletter-bridge.DEMO1234.plist');
    const plist = await fs.readFile(plistFile, 'utf8'); const runner = await fs.readFile(path.join(output, 'service/run.sh'), 'utf8');
    assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/); assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.doesNotMatch(plist + runner, new RegExp(secret)); assert.doesNotMatch(plist, /MONITOR_BRIDGE_TOKEN/);
    assert.match(runner, /security find-generic-password -w/); assert.match(runner, /--once/);
    execFileSync('/bin/bash', ['-n', path.join(output, 'service/run.sh')]);
    if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', plistFile]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
