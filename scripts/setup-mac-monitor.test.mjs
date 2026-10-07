import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setup, optionsFrom, validateEnrollment, appStatus, run } from './setup-mac-monitor.mjs';

const DEVICE_ID = '610be10e-8a00-4e00-b000-000000000051';
const MEMBER_TOKEN = 'test_member_token_'.repeat(3);
const REVISION = 'c'.repeat(40);
const BUNDLE_ID = 'xyz.fi5h.Usage4Claude';

async function appBundle(directory, name) {
  await fs.mkdir(path.join(directory, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(directory, 'Contents', 'marker'), name);
  await fs.writeFile(path.join(directory, 'Contents', 'MacOS', 'Usage4Claude'), 'fake executable, never launched');
}

async function fixture(t, { previous = false, configured = false } = {}) {
  // NSRunningApplication reports macOS canonical paths (/private/tmp, etc.).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'max monitor setup ')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'build', 'Max Monitor.app');
  const destination = path.join(directory, 'Applications', 'Max Monitor.app');
  const receiptPath = path.join(directory, 'private', 'installation.json');
  const workerRoot = path.join(directory, 'AI Newsletter Creation');
  const identityFile = path.join(directory, 'ssh', 'worker_key');
  const knownHostsFile = path.join(workerRoot, 'config', 'hub_known_hosts');
  await appBundle(source, 'new app');
  if (previous) await appBundle(destination, 'previous app');
  await fs.mkdir(path.dirname(identityFile), { recursive: true });
  await fs.mkdir(path.dirname(knownHostsFile), { recursive: true });
  await fs.writeFile(identityFile, 'fake test key');
  await fs.writeFile(knownHostsFile, 'fake pinned test host');
  const worker = { workerId: 'mac-5', hubHost: 'root@hub.example.test', identityFile, knownHostsFile };
  const enrollment = { schema: 1, serverURL: 'https://monitor.example.test/max-monitor', teamId: 'RSMACS01',
    token: MEMBER_TOKEN, memberId: 'worker-mac-5', workerId: worker.workerId, deviceId: DEVICE_ID };
  const state = { revision: REVISION, preflight: { schema: 1, ok: true }, enrollment,
    status: { schema: 1, bundleId: 'xyz.fi5h.Usage4Claude', deviceId: DEVICE_ID, configured,
      ...(configured ? { serverURL: enrollment.serverURL, teamId: enrollment.teamId, workerId: worker.workerId,
        memberId: enrollment.memberId, role: 'member', verified: true, fleetAvailable: true, launchAtLoginStatus: 'enabled' } : {}) },
    nativeFailure: false, signatureFailure: false, appFailure: false, fleetFailure: false,
    runningApps: [], nextPid: 9000, terminationRefused: false, openAbsent: false, openWrongPath: false };
  const calls = [], logs = [];
  const appReader = async appPath => {
    try { await fs.access(path.join(appPath, 'Contents', 'marker')); }
    catch { return null; }
    if (state.appFailure && appPath === destination) return null;
    return { executable: path.join(appPath, 'Contents', 'MacOS', 'Usage4Claude') };
  };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], input: options.input, inherit: options.inherit });
    if (command === 'git') return `${state.revision}\n`;
    if (command === 'ssh') {
      if (args.at(-1).endsWith('--check')) return JSON.stringify(state.preflight);
      return JSON.stringify(state.enrollment);
    }
    if (command === '/bin/ps') return '';
    if (command === '/usr/bin/osascript') {
      assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
      const mode = args.at(-2), bundleId = args.at(-1);
      assert.equal(bundleId, BUNDLE_ID);
      if (mode === 'terminate') {
        if (!state.terminationRefused) state.runningApps = state.runningApps.filter(app => app.bundleId !== bundleId);
      } else assert.equal(mode, 'inventory');
      return JSON.stringify(state.runningApps);
    }
    if (command === '/usr/bin/ditto') { await fs.cp(args[0], args[1], { recursive: true }); return ''; }
    if (command === '/usr/bin/codesign') {
      if (state.signatureFailure) throw new Error('App-Signatur prüfen fehlgeschlagen.');
      return '';
    }
    if (command === '/usr/bin/open') {
      if (state.openAbsent) return '';
      const bundlePath = state.openWrongPath ? path.join(directory, 'Wrong Monitor.app') : args.at(-1);
      state.runningApps.push({ pid: state.nextPid++, bundleId: BUNDLE_ID, bundlePath,
        executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Usage4Claude') });
      return '';
    }
    if (command.endsWith('/Contents/MacOS/Usage4Claude')) {
      if (args[0] === '--enrollment-status') {
        const value = { ...state.status };
        if (state.fleetFailure && args.includes('--verify')) value.fleetAvailable = false;
        return JSON.stringify(value);
      }
      if (args[0] === '--enroll') {
        if (state.nativeFailure) throw new Error('Monitor-Verbindung speichern fehlgeschlagen.');
        const input = JSON.parse(options.input);
        state.status = { ...state.status, configured: true, serverURL: input.serverURL, teamId: input.teamId,
          workerId: input.workerId, memberId: input.memberId, verified: true, fleetAvailable: true,
          role: 'member', launchAtLoginStatus: state.loginStatus || (input.launchAtLogin ? 'enabled' : 'notRegistered') };
        if (state.loginTimeout) {
          throw Object.assign(new Error('Autostart Zeitüberschreitung'), { timedOut:true, stage:'login' });
        }
        return JSON.stringify({ schema: 1, launchAtLoginStatus: state.status.launchAtLoginStatus });
      }
    }
    assert.fail(`Unexpected runner command: ${command} ${args.join(' ')}`);
  };
  const options = optionsFrom(['--worker-root', workerRoot, '--app-path', destination, '--app-bundle', source]);
  const dependencies = { runner, appReader, workerReader: async () => worker,
    platform: 'darwin', receiptPath, pause: async () => {}, log: value => logs.push(value) };
  return { directory, source, destination, receiptPath, options, dependencies, state, calls, logs, worker,
    async marker() { return fs.readFile(path.join(destination, 'Contents', 'marker'), 'utf8'); },
    async writeReceipt(sourceRevision = REVISION) {
      await fs.mkdir(path.dirname(receiptPath), { recursive: true });
      await fs.writeFile(receiptPath, JSON.stringify({ schema: 1, sourceRevision, workerId: worker.workerId }), { mode: 0o600 });
    },
    runningApp(bundlePath = destination, bundleId = BUNDLE_ID) {
      const app = { pid: state.nextPid++, bundleId, bundlePath,
        executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Usage4Claude') };
      state.runningApps.push(app);
      return app;
    },
  };
}

test('first installation passes one member token only through native stdin and writes a private safe receipt', async t => {
  const f = await fixture(t);
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.mode, 'installed');
  assert.equal(result.workerId, f.worker.workerId);
  assert.equal(await f.marker(), 'new app');
  const enrollment = f.calls.find(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin'));
  assert.deepEqual(JSON.parse(enrollment.input), { workerId: f.worker.workerId, deviceId: DEVICE_ID, name: os.hostname() });
  const native = f.calls.find(call => call.args[0] === '--enroll');
  assert.equal(JSON.parse(native.input).token, MEMBER_TOKEN);
  assert.equal(JSON.parse(native.input).launchAtLogin, true);
  assert.ok(f.calls.every(call => !JSON.stringify(call.args).includes(MEMBER_TOKEN)));
  assert.ok(!f.logs.join('\n').includes(MEMBER_TOKEN));
  const receiptText = await fs.readFile(f.receiptPath, 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.sourceRevision, REVISION);
  assert.equal(receipt.deviceId, DEVICE_ID);
  assert.equal(receipt.teamId, 'RSMACS01');
  assert.ok(!receiptText.includes(MEMBER_TOKEN));
  assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
  assert.equal((await fs.stat(f.receiptPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
});

test('a repeated healthy setup keeps the existing app and member without another enrollment or copy', async t => {
  const f = await fixture(t);
  await setup(f.options, f.dependencies);
  const before = f.calls.length;
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  const repeated = f.calls.slice(before);
  assert.ok(!repeated.some(call => ['ssh', '/usr/bin/ditto', '/bin/bash'].includes(call.command)));
  assert.ok(!repeated.some(call => call.args[0] === '--enroll'));
  assert.ok(!repeated.some(call => call.command === '/usr/bin/open'), 'the intended app is already running');
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.equal(await f.marker(), 'new app');
});

test('a running copy with the old product name stops and the intended installation becomes live', async t => {
  const f = await fixture(t);
  const oldPath = path.join(f.directory, 'Applications', 'Usage4Claude 2.0.app');
  await appBundle(oldPath, 'old named app');
  const old = f.runningApp(oldPath);
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.mode, 'installed');
  assert.ok(!f.state.runningApps.some(app => app.pid === old.pid));
  assert.equal(await fs.readFile(path.join(oldPath, 'Contents', 'marker'), 'utf8'), 'old named app');
  const running = f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID);
  assert.equal(running.length, 1);
  assert.equal(running[0].bundlePath, f.destination);
  const opened = f.calls.find(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.args, ['-g', '-n', f.destination]);
  assert.ok(f.calls.some(call => call.command === '/usr/bin/osascript' && call.args.at(-2) === 'terminate'));
  assert.ok(!f.calls.some(call => call.command === '/bin/ps'));
});

test('other bundle IDs are preserved while matching monitor copies are replaced', async t => {
  const f = await fixture(t);
  f.runningApp(path.join(f.directory, 'Old Monitor.app'));
  const unrelated = f.runningApp(path.join(f.directory, 'Private Preview.app'), 'de.rs.private-preview');
  await setup(f.options, f.dependencies);
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.ok(f.calls.filter(call => call.command === '/usr/bin/osascript').every(call => call.args.at(-1) === BUNDLE_ID));
});

test('refusing graceful termination blocks app replacement and member enrollment', async t => {
  const f = await fixture(t, { previous: true });
  const running = f.runningApp();
  f.state.terminationRefused = true;
  await assert.rejects(setup(f.options, f.dependencies));
  assert.deepEqual(f.state.runningApps, [running]);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
});

test('missing or wrong process after opening prevents receipt creation and restores the previous bundle', async t => {
  for (const failure of ['openAbsent', 'openWrongPath']) {
    const f = await fixture(t, { previous: true });
    f.state[failure] = true;
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
    assert.ok(f.calls.some(call => call.command === '/usr/bin/open'));
    assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 0,
      'rollback stops any failed newly opened monitor process before removing its bundle');
  }
});

test('a receipt write failure stops the new process and restores only captured original monitor paths', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Renamed Existing Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  const unrelated = f.runningApp(path.join(f.directory, 'Other Tool.app'), 'de.rs.other-tool');
  // A directory at the receipt path reliably makes writeFile fail on every platform.
  await fs.mkdir(f.receiptPath, { recursive: true });
  await assert.rejects(setup(f.options, f.dependencies), { code: 'EISDIR' });
  assert.equal(await f.marker(), 'previous app');
  assert.equal((await fs.stat(f.receiptPath)).isDirectory(), true);
  assert.deepEqual(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).map(app => app.bundlePath), [oldPath]);
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
  const opened = f.calls.filter(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.map(call => call.args), [['-g', '-n', f.destination], ['-g', '-n', oldPath]]);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
  assert.equal(await fs.readFile(path.join(oldPath, 'Contents', 'marker'), 'utf8'), 'old named app');
});

test('a healthy repeated setup with a different running path opens only the intended installation', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  const old = f.runningApp(path.join(f.directory, 'Usage4Claude.app'));
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  assert.ok(!f.state.runningApps.some(app => app.pid === old.pid));
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID && app.bundlePath === f.destination).length, 1);
  assert.equal(f.calls.filter(call => call.command === '/usr/bin/open').length, 1);
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
});

test('rollback reopens only the stopped original monitor paths and preserves unrelated apps', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Old Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  const unrelated = f.runningApp(path.join(f.directory, 'Other Tool.app'), 'de.rs.other-tool');
  f.state.nativeFailure = true;
  await assert.rejects(setup(f.options, f.dependencies));
  assert.equal(await f.marker(), 'previous app');
  const opened = f.calls.filter(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.map(call => call.args), [['-g', '-n', oldPath]]);
  assert.ok(f.state.runningApps.some(app => app.bundleId === BUNDLE_ID && app.bundlePath === oldPath));
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
});

test('signature failure also restores a stopped original process before member enrollment', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Renamed Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  f.state.signatureFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /App-Signatur/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(f.state.runningApps.some(app => app.bundleId === BUNDLE_ID && app.bundlePath === oldPath));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
});

test('check succeeds read-only for the installed source and rejects a stale receipt without enrollment', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  const receipt = await fs.readFile(f.receiptPath, 'utf8');
  const options = { ...f.options, appBundle: undefined, check: true };
  assert.equal((await setup(options, f.dependencies)).mode, 'check');
  f.state.revision = 'd'.repeat(40);
  await assert.rejects(setup(options, f.dependencies), /aktuelle Repo-Version/);
  assert.equal(await f.marker(), 'previous app');
  assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
  assert.ok(f.calls.every(call => call.command === 'git' || call.args[0] === '--enrollment-status'));
});

test('dry-run performs no commands, app copy, receipt write or member enrollment, including on non-macOS', async t => {
  const f = await fixture(t, { previous: true });
  const result = await setup({ ...f.options, dryRun: true }, { ...f.dependencies, platform: 'linux' });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.workerId, f.worker.workerId);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
  assert.equal(await f.marker(), 'previous app');
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
});

test('unavailable central capabilities fail before copying the app or enrolling a member', async t => {
  const f = await fixture(t, { previous: true });
  f.state.preflight = { ok: true, schema: 0 };
  await assert.rejects(setup(f.options, f.dependencies), /noch nicht bereitgestellt/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
});

test('invalid worker/device mappings and public HTTP are rejected before native token storage', async t => {
  const variants = [{ workerId: 'mac-other' }, { deviceId: '610be10e-8a00-4e00-b000-000000000052' },
    { serverURL: 'http://monitor.example.test' }, { serverURL: 'https://user:password@monitor.example.test' },
    { serverURL: 'https://monitor.example.test?token=secret' }];
  for (const variant of variants) {
    const f = await fixture(t, { previous: true });
    f.state.enrollment = { ...f.state.enrollment, ...variant };
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    assert.ok(!f.calls.some(call => call.args[0] === '--enroll'));
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  }
});

test('native enrollment or installed-app failures restore the previous bundle and existing receipt', async t => {
  for (const failure of ['nativeFailure', 'appFailure']) {
    const f = await fixture(t, { previous: true });
    await f.writeReceipt('b'.repeat(40));
    const receipt = await fs.readFile(f.receiptPath, 'utf8');
    // This injected app reader failure starts after the old bundle is inspected.
    if (failure === 'appFailure') {
      const runner = f.dependencies.runner;
      f.dependencies.runner = async (...args) => {
        const result = await runner(...args);
        if (args[0] === '/usr/bin/codesign') f.state.appFailure = true;
        return result;
      };
    } else f.state.nativeFailure = true;
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
    assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
  }
});

test('a bad signature leaves the previous bundle in place and never sends enrollment stdin', async t => {
  const f = await fixture(t, { previous: true });
  f.state.signatureFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /App-Signatur/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
});

test('verified fleet access is required before writing an installation receipt', async t => {
  const f = await fixture(t, { previous: true });
  f.state.fleetFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /noch nicht erreichbar/);
  assert.equal(await f.marker(), 'previous app');
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
});

test('an existing personal/other worker connection is never taken over', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  f.state.status.workerId = 'another-worker';
  await assert.rejects(setup(f.options, f.dependencies), /anderen Einrichtung/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === 'ssh' || call.command === '/usr/bin/ditto'));
});

test('native status is whitelisted so unexpected secrets cannot escape through setup output', async () => {
  const value = await appStatus({ executable: '/fake/app' }, true,
    async () => JSON.stringify({ schema: 1, deviceId: DEVICE_ID, verified: true, fleetAvailable: true,
      token: MEMBER_TOKEN, authorization: `Bearer ${MEMBER_TOKEN}`, vault: { token: MEMBER_TOKEN } }));
  assert.deepEqual(value, { schema: 1, deviceId: DEVICE_ID, verified: true, fleetAvailable: true });
});

test('an existing owner or admin is preserved even with the same worker and no member ID', async t => {
  for (const role of ['super', 'admin']) {
    const f = await fixture(t, { previous: true, configured: true });
    f.state.status.role = role;
    delete f.state.status.memberId;
    await assert.rejects(setup(f.options, f.dependencies), /Inhaber- oder Admin-Zugang/);
    assert.equal(await f.marker(), 'previous app');
    assert.ok(!f.calls.some(call => call.command === 'ssh' || call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  }
});

test('upgrading an old app detects preserved personal connections before member creation and restores the old bundle', async t => {
  for (const variant of [{ role: 'super', memberId: undefined }, { role: 'member', workerId: 'another-worker' }]) {
    const f = await fixture(t, { previous: true, configured: true });
    Object.assign(f.state.status, variant);
    // The unsupported old target exposes no enrollment CLI; the newly copied app can read its preferences.
    const supportedReader = f.dependencies.appReader;
    let destinationReads = 0;
    f.dependencies.appReader = async (...args) => {
      if (args[0] === f.destination && destinationReads++ === 0) return null;
      return supportedReader(...args);
    };
    await assert.rejects(setup(f.options, f.dependencies), /Inhaber- oder Admin-Zugang|anderen Einrichtung/);
    assert.equal(await f.marker(), 'previous app');
    assert.ok(f.calls.some(call => call.command === '/usr/bin/ditto'));
    assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
    assert.ok(!f.calls.some(call => call.args[0] === '--enroll'));
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  }
});

test('check reports pending login approval while preserving verified monitoring and remaining read-only', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  f.state.status.launchAtLoginStatus = 'requiresApproval';
  const result = await setup({ ...f.options, check: true }, f.dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.fleetAvailable, true);
  assert.equal(result.loginReady, false);
  assert.equal(result.loginActionRequired, true);
  assert.equal(result.loginApprovalRequired, true);
  assert.match(result.loginHint, /Systemeinstellungen.*Anmeldeobjekte/);
  assert.equal(f.logs.length, 0); // --check reserves stdout for its safe JSON result.
  assert.ok(f.calls.every(call => call.command === 'git' || call.args[0] === '--enrollment-status'));
});

test('repeated setup explains pending login approval without enrolling another member', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  f.state.status.launchAtLoginStatus = 'requiresApproval';
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  assert.equal(result.loginApprovalRequired, true);
  assert.ok(f.logs.some(line => line.includes('Anmeldeobjekte')));
  assert.ok(!f.calls.some(call => call.command === 'ssh' || call.args[0] === '--enroll'));
});

test('failed autostart registration is reported separately from successful fleet enrollment', async t => {
  for (const state of ['notRegistered', 'notFound']) {
    const f = await fixture(t);
    f.state.loginStatus = state;
    const result = await setup(f.options, f.dependencies);
    assert.equal(result.mode, 'installed');
    assert.equal(result.verified, true);
    assert.equal(result.launchAtLoginStatus, state);
    assert.equal(result.loginReady, false);
    assert.equal(result.loginActionRequired, true);
    assert.equal(result.loginApprovalRequired, false);
    assert.ok(f.logs.some(line => line.includes('Autostart ist noch nicht aktiv')));
    assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
  }
});

test('explicitly disabled autostart does not produce an approval request or misleading ready flag', async t => {
  const f = await fixture(t);
  const result = await setup({ ...f.options, launchAtLogin: false }, f.dependencies);
  assert.equal(result.launchAtLoginRequested, false);
  assert.equal(result.loginReady, false);
  assert.equal(result.loginActionRequired, false);
  assert.equal(result.loginApprovalRequired, false);
  assert.ok(!f.logs.some(line => line.includes('Autostart') || line.includes('Anmeldeobjekte')));
});

test('autostart timeout retains only a separately verified exact enrolled connection', async t => {
  const f = await fixture(t, { previous:true });
  f.state.loginTimeout = true;
  f.state.loginStatus = 'notRegistered';
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.loginActionRequired, true);
  assert.equal(await f.marker(), 'new app');
  assert.ok(f.logs.some(line => line.includes('separat bestätigt')));
  assert.ok(f.logs.some(line => line.includes('Autostart ist noch nicht aktiv')));
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.receiptPath, 'utf8')).sourceRevision, REVISION);
});

test('autostart timeout never treats unavailable or different member identity as success', async t => {
  for (const variant of ['unavailable', 'other-member']) {
    const f = await fixture(t, { previous:true });
    f.state.loginTimeout = true;
    f.state.fleetFailure = variant === 'unavailable';
    const runner = f.dependencies.runner;
    f.dependencies.runner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (args[0] === '--enrollment-status' && args.includes('--verify') && variant === 'other-member')
        return JSON.stringify({...JSON.parse(result), memberId:'different-member'});
      return result;
    };
    await assert.rejects(setup(f.options, f.dependencies), /Server ist noch nicht erreichbar/);
    assert.equal(await f.marker(), 'previous app');
    await assert.rejects(fs.access(f.receiptPath), {code:'ENOENT'});
  }
});

test('phase tracking ignores arbitrary stderr, split markers and repeated or backwards phases cannot extend a timeout', {timeout:3000}, async () => {
  const phases = [];
  await assert.rejects(run(process.execPath, ['-e', `
    process.stderr.write(${JSON.stringify(MEMBER_TOKEN)} + '\\n');
    process.stderr.write('MAX_MONITOR_ENROLLMENT_');
    setTimeout(() => {
      process.stderr.write('STAGE:credentials\\nMAX_MONITOR_ENROLLMENT_STAGE:unknown\\n');
      setInterval(() => process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:credentials\\nMAX_MONITOR_ENROLLMENT_STAGE:relay\\n'), 5);
    }, 10);
  `], {timeout:3000, onProgress:stage => phases.push(stage), progressTimeouts:{credentials:60}}), error => {
    assert.equal(error.timedOut, true);
    assert.equal(error.stage, 'credentials');
    assert.match(error.message, /Schlüsselbund/);
    assert.ok(!error.message.includes(MEMBER_TOKEN));
    assert.deepEqual(phases, ['credentials']);
    return true;
  });
});

test('the credential phase receives its own budget after the initial timeout window', {timeout:5000}, async () => {
  const phases = [];
  const result = await run(process.execPath, ['-e', `
    process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:credentials\\n');
    setTimeout(() => { process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:complete\\n'); process.stdout.write('done'); }, 1200);
  `], {timeout:1000, onProgress:stage => phases.push(stage), progressTimeouts:{credentials:3000}});
  assert.equal(result, 'done');
  assert.deepEqual(phases, ['credentials','complete']);
});

test('failed child stdout and stderr never leak their token into the runner error', async () => {
  await assert.rejects(run(process.execPath, ['-e',
    'process.stdin.resume(); process.stdin.on("data", data => { process.stdout.write(data); process.stderr.write(data); }); process.stdin.on("end", () => process.exit(7));'],
    { input: MEMBER_TOKEN, label: 'Hub-Anmeldung', timeout: 3000 }), error => {
    assert.match(error.message, /Hub-Anmeldung fehlgeschlagen \(Exit 7\)/);
    assert.ok(!error.message.includes(MEMBER_TOKEN));
    return true;
  });
});

test('argument parsing and enrollment validation reject unsafe options; loopback requires explicit opt-in', () => {
  for (const args of [['--token', MEMBER_TOKEN], ['--check', '--dry-run'], ['--worker-root'],
    ['--hub-helper', '/opt/helper; echo secret']]) assert.throws(() => optionsFrom(args));
  const local = { serverURL: 'http://localhost:8940', teamId: 'RSMACS01', token: MEMBER_TOKEN,
    memberId: 'worker-mac-5', workerId: 'mac-5', deviceId: DEVICE_ID };
  assert.throws(() => validateEnrollment(local, 'mac-5', DEVICE_ID));
  assert.equal(validateEnrollment(local, 'mac-5', DEVICE_ID, true).serverURL, local.serverURL);
});
