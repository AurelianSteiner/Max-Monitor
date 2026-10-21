import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prepareInstallation, preflightNodeRuntime } from './install-monitor-hub.mjs';
import { buildQueue, DEFAULT_WORKFLOWS, readRunStatuses, addRunDetails, readHubFleet, readLocalHubFleet } from './newsletter-monitor-bridge.mjs';
const require = createRequire(import.meta.url), { createFleetStore } = require('../team-server/fleet');
const now = Date.parse('2026-10-21T16:00:00Z'), iso = n => new Date(now + n).toISOString();

test('a new source epoch carrying an old completion tag stays active through bridge, relay and restart', t => {
  const task = { id: 'fixture', name: 'Fixture mail', tags: [{ name: 'pre gen · fertig' }], status: { status: 'pre-gen' }, statusSince: '2', date_updated: String(now) };
  const claim = { taskId: task.id, jobId: 'fixture@2', workflow: 'newsletter', runId: '20261021T160000Z-fixture@2', workerId: 'mac-a', state: 'running', heartbeat: now / 1000 };
  const rows = buildQueue([task], [claim], DEFAULT_WORKFLOWS, { now });
  assert.equal(rows[0].status, 'running'); assert.equal(rows[0].progress, undefined);
  delete rows[0].run;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bridge-relay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory, () => now);
  store.updateQueue('DEMO1234', { tasks: rows, source: { name: 'fixture', lastSuccessAt: iso(0) } });
  store.workerReport('DEMO1234', { schema: 1, workerId: 'mac-a', sampledAt: iso(0),
    service: { running: true, lastPollAt: iso(0) }, activity: { state: 'busy', acceptingTasks: false,
      runs: [{ id: rows[0].id, title: task.name, workflow: 'newsletter', status: 'running', runId: claim.runId, progress: 40 }] } });
  const saved = createFleetStore(directory, () => now).snapshot('DEMO1234').queue.tasks[0];
  assert.equal(saved.status, 'running'); assert.equal(saved.progress, 40); assert.equal(saved.workerId, 'mac-a');
  const completed = buildQueue([task], [{ ...claim, state: 'final', outcome: 'completed' }], DEFAULT_WORKFLOWS, { now });
  assert.equal(completed[0].status, 'completed');
  const downstream = buildQueue([{ ...task, status: { status: 'approval intern' } }], [claim], DEFAULT_WORKFLOWS, { now });
  assert.equal(downstream[0].status, 'completed');
});

test('status replies on later pages are read; repeated cursors remain unverified and bounded', async () => {
  const calls = [];
  const fetcher = async target => {
    const cursor = new URL(target).searchParams.get('cursor'); calls.push(cursor);
    return new Response(JSON.stringify(cursor ? { ok: true, messages: [{ bot_id: 'BOT', text: '⏳ 80 % · Aktueller Schritt' }] }
      : { ok: true, messages: [{ bot_id: 'BOT', text: '⏳ 10 % · Alter Schritt' }], has_more: true, response_metadata: { next_cursor: 'next' } }));
  };
  const result = await readRunStatuses(fetcher, 'fixture', ['1.1']);
  assert.deepEqual(calls, [null, 'next']); assert.equal(result.get('1.1').percent, 80);
  let reads = 0;
  const truncated = await readRunStatuses(async () => {
    reads++; return new Response(JSON.stringify({ ok: true, messages: [{ bot_id: 'BOT', text: '⏳ 10 % · Unvollständig' }],
      has_more: true, response_metadata: { next_cursor: 'same' } }));
  }, 'fixture', ['1.1']);
  assert.equal(reads, 2); assert.deepEqual(truncated.get('1.1'), { unbound: true });
});

test('cold preview read failures preserve only the matching attempt and respect retention', async () => {
  const previous = { id: 'mail', attemptId: 'run-1', status: 'running', previews: [{ id: 'a'.repeat(64), title: 'Mail', renderedAt: iso(-1000), render: 1, width: 600, height: 800 }] };
  const row = attemptId => ({ id: 'mail', workflow: 'newsletter', status: 'running', attemptId,
    run: { id: attemptId, taskId: 'fixture', ts: '1.1' } });
  const options = { previousTasks: [previous], now, channelId: 'fixture',
    hubFetch: async () => new Response(JSON.stringify({ ok: true, messages: [] })), previews: async () => new Map() };
  assert.deepEqual((await addRunDetails([row('run-1')], options))[0].previews, previous.previews);
  assert.equal((await addRunDetails([row('run-2')], options))[0].previews, undefined);
  assert.equal((await addRunDetails([row('run-1')], { ...options, now: now + 30 * 86400000 }))[0].previews, undefined);
});

test('a generated clean installation starts its bridge and relay and imports the exact setup package', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-clean-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workerRoot = path.join(directory, 'worker'), nginxConfigPath = path.join(directory, 'nginx.conf'), stageDirectory = path.join(directory, 'stage');
  fs.mkdirSync(path.join(workerRoot, 'src'), { recursive: true });
  for (const name of ['config.js', 'hub-transport.js', 'pre-gen.js']) fs.writeFileSync(path.join(workerRoot, 'src', name), 'module.exports = {};');
  fs.writeFileSync(nginxConfigPath, 'server { listen 443 ssl; server_name api.ruegamer-steiner.de; }');
  prepareInstallation({ stageDirectory, workerRoot, nginxConfigPath, existingConfigPath: path.join(directory, 'missing.json') });
  const runtime = path.join(stageDirectory, 'payload/opt/max-monitor');
  const env = { ...process.env, TEAM_TOKEN: 'isolated-package-fixture', TEAM_TOKENS: '', DATA_DIR: path.join(directory, 'data') };
  for (const args of [
    [path.join(runtime, 'scripts/newsletter-monitor-bridge.mjs'), '--help'],
    [path.join(runtime, 'scripts/setup-mac-monitor.mjs'), '--help'],
    [path.join(runtime, 'scripts/install-monitor-hub.mjs'), '--help'],
    ['-e', 'require(process.argv[1])', path.join(runtime, 'team-server/server.js')],
  ]) {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000, cwd: runtime });
    assert.equal(result.status, 0, result.stderr);
  }
  const html = fs.readFileSync(path.join(runtime, 'team-server/public/dashboard.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    if (!match[1].includes('://')) assert.equal(fs.existsSync(path.join(runtime, 'team-server/public', match[1].replace(/^\.\/fleet-assets\//, ''))), true, match[1]);
  }
});

test('runtime preflight exercises SQLite and sharp before installation, with bounded failures', () => {
  let call;
  preflightNodeRuntime('/usr/bin/node', '/fixture/hub', (...args) => { call = args; return { status: 0 }; });
  assert.match(call[1][1], /node:sqlite/); assert.match(call[1][1], /toBuffer/);
  assert.equal(call[1].at(-1), '/fixture/hub/package.json'); assert.equal(call[2].timeout, 30000);
  for (const result of [{ status: 1 }, { status: null, error: new Error('timeout') }]) {
    assert.throws(() => preflightNodeRuntime('/fixture/node', '/fixture/hub', () => result), /keine Dienste geändert/);
  }
});

test('SSH and local worker readers preserve the same admission value', async t => {
  const { EventEmitter } = await import('node:events'), { PassThrough } = await import('node:stream');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sample = { worker_id: 'mac-a', seen_at: new Date(now).toISOString(), annahme: false, occupied_tasks: 2, max_tasks: 3 };
  fs.writeFileSync(path.join(directory, 'mac-a.json'), JSON.stringify(sample));
  const hub = { hub_dir: '/fixture', ssh_host: 'fixture', identity_file: '/fixture/key', known_hosts_file: '/fixture/hosts' };
  const remote = await readHubFleet(hub, { fleetDirectory: directory, spawnImpl: () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => { assert.match(child.stdin.read().toString(), /annahme:v.annahme/);
      child.stdout.write(JSON.stringify([sample])); child.emit('close', 0); });
    return child;
  } });
  assert.deepEqual(remote, await readLocalHubFleet(hub, { fleetDirectory: directory }));
  assert.equal(remote[0].acceptingTasks, false);
});
