import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocalHubFleet, createLocalHubFetch, argumentsFrom, applyEnrollmentConfiguration } from './newsletter-monitor-bridge.mjs';

const hub = { ssh_host: 'root@example.test', hub_dir: '/opt/rs-hub', identity_file: '~/.ssh/not-used', known_hosts_file: '/not-used' };

test('local Hub mode reuses the Newsletter transport and replaces only SSH with a Node stdin process', async () => {
  const calls = [];
  const transport = {
    createHubFetch(config, options) {
      assert.equal(config.hub_dir, '/opt/rs-hub');
      return async (url, request) => {
        calls.push({ url, request });
        options.spawnImpl('ssh', ['original-transport-arguments'], { stdio: ['pipe', 'pipe', 'pipe'] });
        return { ok: true, status: 200 };
      };
    },
    checkRequest(url, method) { return { url, method, service: url.includes('slack.com') ? 'slack' : 'clickup' }; },
  };
  const localFetch = createLocalHubFetch(hub, { localHub: '/opt/rs-hub', transport, nodeBinary: '/usr/bin/node',
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, '/usr/bin/node');
      assert.deepEqual(args, ['-']);
      assert.equal(options.cwd, '/opt/rs-hub');
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      return {};
    },
  });
  await localFetch('https://api.clickup.com/api/v2/team/24553341/space', { method: 'GET' });
  await localFetch('https://slack.com/api/conversations.history');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.request.method === 'GET'));
});

test('local monitoring rejects every write and worker-heartbeat side effect before executing transport code', async () => {
  let invoked = false;
  const transport = { createHubFetch: () => async () => { invoked = true; }, checkRequest: (_url, method) => ({ method, service: 'clickup' }) };
  const localFetch = createLocalHubFetch(hub, { localHub: '/opt/rs-hub', transport });
  for (const options of [{ method: 'POST' }, { method: 'DELETE' }, { body: '{}' }, { workerHeartbeat: { worker_id: 'mac-5' } }]) {
    await assert.rejects(localFetch('https://api.clickup.com/api/v2/team/24553341/task', options), /ausschließlich lesende/);
  }
  assert.equal(invoked, false);
  assert.throws(() => createLocalHubFetch(hub, { localHub: '/opt/rs-hub; bad', transport }), /Pfad/);
});

test('local fleet reads expose only telemetry and skip symlinks, malformed and oversized files without writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-local-fleet-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = JSON.stringify({ worker_id: 'mac-5', seen_at: '2026-10-07T12:00:00Z', pending_clickup: 3, secret: 'never-return' });
  await fs.writeFile(path.join(directory, 'mac-5.json'), content);
  await fs.writeFile(path.join(directory, 'broken.json'), '{broken');
  await fs.writeFile(path.join(directory, 'too-big.json'), 'a'.repeat(17000));
  await fs.symlink(path.join(directory, 'mac-5.json'), path.join(directory, 'copy.json'));
  const result = await readLocalHubFleet(hub, { fleetDirectory: directory });
  assert.equal(result.length, 1);
  assert.equal(result[0].workerId, 'mac-5');
  assert.equal(result[0].pendingClickup, 3);
  assert.ok(!JSON.stringify(result).includes('never-return'));
  assert.equal(await fs.readFile(path.join(directory, 'mac-5.json'), 'utf8'), content);
  assert.equal(await fs.readFile(path.join(directory, 'broken.json'), 'utf8'), '{broken');
});

test('central private publishing config is explicit, remains server-side and cannot be redirected to another relay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-local-source-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'enrollment.json');
  await fs.writeFile(file, JSON.stringify({ serverURL: 'https://api.example.test/max-monitor', teamId: 'RSMACS01', ownerToken: 'private-owner' }), { mode: 0o600 });
  const parsed = argumentsFrom(['--worker-root', '/opt/max-monitor/newsletter-source', '--local-hub', '/opt/rs-hub', '--enrollment-config', file], {});
  assert.equal(parsed.token, undefined);
  const applied = await applyEnrollmentConfiguration(parsed);
  assert.equal(applied.relayUrl, 'https://api.example.test/max-monitor');
  assert.equal(applied.teamId, 'RSMACS01');
  assert.equal(applied.token, 'private-owner');
  await assert.rejects(applyEnrollmentConfiguration({ ...parsed, relayUrl: 'https://different.example.test' }), /widerspricht/);
  assert.throws(() => argumentsFrom(['--enrollment-config', file], {}), /zentralen/);
});
