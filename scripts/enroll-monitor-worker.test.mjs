import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { configuration, loadConfiguration, checkEnrollment, enrollMonitorWorker, parseArguments, main } from './enroll-monitor-worker.mjs';

const identity = { workerId: 'mac-5', deviceId: '610be10e-8a00-4e00-b000-000000000051', name: 'Mac 5' };
const ownerToken = 'private-owner-token';
const settings = configuration({ serverURL: 'https://monitor.example.test/relay/', teamId: 'demo1234', ownerToken });
const memberToken = 'a'.repeat(32);
const member = { id: 'worker-1234', role: 'member', token: memberToken, enrollment: { workerId: identity.workerId, deviceId: identity.deviceId } };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('configuration requires HTTPS, a team and private owner credentials', () => {
  assert.equal(settings.serverURL, 'https://monitor.example.test/relay');
  assert.equal(settings.teamId, 'DEMO1234');
  for (const override of [{ serverURL: 'http://monitor.example.test' }, { serverURL: 'https://token:secret@monitor.example.test' }, { serverURL: 'https://monitor.example.test?token=secret' }, { teamId: '../bad' }, { ownerToken: '' }, { ownerToken: 'bad\nheader' }]) {
    assert.throws(() => configuration({ ...settings, ...override }));
  }
  assert.equal(configuration({ ...settings, serverURL: 'http://localhost:8080' }).serverURL, 'http://localhost:8080');
});

test('server credentials can come from a private config file; insecure files and missing config fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-enrollment-config-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'enrollment.json');
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  assert.deepEqual(loadConfiguration({ env: {}, configPath: file }), settings);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadConfiguration({ env: {}, configPath: file }), /private Datei/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{bad-json');
  assert.throws(() => loadConfiguration({ env: {}, configPath: file }), /gültiges JSON/);
  assert.throws(() => loadConfiguration({ env: {}, configPath: path.join(directory, 'missing') }));
  assert.throws(() => loadConfiguration({ env: {}, stat: () => { const error = new Error(); error.code = 'ENOENT'; throw error; } }), /SERVER_URL/);
});

test('preflight never posts or emits credentials and confirms both endpoint capabilities', async () => {
  const calls = [];
  const result = await checkEnrollment(settings, { fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return response(url.endsWith('/workers/enroll') ? { schema: 1, role: 'member' } : { schema: 1, machines: [], queue: { tasks: [] } });
  } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([url, options]) => url.startsWith('https://monitor.example.test/relay/v1/teams/DEMO1234/') && options.method === 'GET' && options.redirect === 'error'));
  assert.ok(!JSON.stringify(result).includes(ownerToken));
  await assert.rejects(checkEnrollment(settings, { fetchImpl: async () => response({ schema: 1, role: 'admin' }) }), /Worker-Registrierung/);
});

test('enrollment outputs one ordinary token and validates the server-side binding', async () => {
  let call;
  const result = await enrollMonitorWorker(settings, identity, { fetchImpl: async (url, options) => {
    call = { url, options };
    return response({ schema: 1, member });
  } });
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${ownerToken}`);
  assert.deepEqual(JSON.parse(call.options.body), identity);
  assert.equal(result.token, memberToken);
  assert.equal(result.deviceId, identity.deviceId);
  assert.ok(!JSON.stringify(result).includes(ownerToken));
  for (const override of [{ role: 'admin' }, { token: 'bad' }, { enrollment: { ...member.enrollment, workerId: 'mac-other' } }, { enrollment: { ...member.enrollment, deviceId: 'wrong' } }]) {
    await assert.rejects(enrollMonitorWorker(settings, identity, { fetchImpl: async () => response({ schema: 1, member: { ...member, ...override } }) }), /Mitglieds-Zuordnung/);
  }
});

test('errors never echo raw upstream bodies or owner credentials', async () => {
  for (const status of [401, 403, 404, 409, 500]) {
    await assert.rejects(enrollMonitorWorker(settings, identity, { fetchImpl: async () => response({ token: ownerToken }, status) }), (error) => {
      assert.ok(!error.message.includes(ownerToken));
      assert.ok(error.message.includes(`HTTP ${status}`));
      return true;
    });
  }
  await assert.rejects(checkEnrollment(settings, { fetchImpl: async () => { throw new Error(ownerToken); } }), (error) => !error.message.includes(ownerToken));
});

test('stdin command writes exactly one captured bootstrap JSON object on success', async () => {
  let output = '';
  await main(['--stdin'], { env: { MAX_MONITOR_SERVER_URL: settings.serverURL, MAX_MONITOR_TEAM_ID: settings.teamId, MAX_MONITOR_OWNER_TOKEN: ownerToken },
    input: Readable.from([Buffer.from(JSON.stringify(identity))]), output: { write: (chunk) => { output += chunk; } },
    fetchImpl: async () => response({ schema: 1, member }),
  });
  assert.equal(output.trim().split('\n').length, 1);
  assert.equal(JSON.parse(output).token, memberToken);
  assert.ok(!output.includes(ownerToken));
});

test('CLI rejects ambiguous modes and malformed stdin before contacting a server', async () => {
  for (const args of [[], ['--stdin', '--check'], ['--config'], ['--token', ownerToken]]) assert.throws(() => parseArguments(args));
  let contacted = false;
  await assert.rejects(main(['--stdin'], { env: { MAX_MONITOR_SERVER_URL: settings.serverURL, MAX_MONITOR_TEAM_ID: settings.teamId, MAX_MONITOR_OWNER_TOKEN: ownerToken },
    input: Readable.from([Buffer.from('{bad')]), output: { write: () => assert.fail('unexpected stdout') }, fetchImpl: async () => { contacted = true; },
  }), /stdin/);
  assert.equal(contacted, false);
});
