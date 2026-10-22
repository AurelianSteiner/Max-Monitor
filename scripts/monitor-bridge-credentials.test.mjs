import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareBridgeToken, bridgeTokenFile } from './monitor-bridge-credentials.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-token-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('one-time import persists privately and repeated installs/checks never query Keychain', t => {
  const directory = fixture(t);
  let calls = 0;
  const file = prepareBridgeToken(directory, { importLegacy: true, teamId: 'DEMO1234', readLegacy: teamId => {
    assert.equal(teamId, 'DEMO1234'); calls++; return 'synthetic-token\n';
  } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (let i = 0; i < 3; i++) prepareBridgeToken(directory, {
    importLegacy: true, readLegacy() { assert.fail('must not query Keychain again'); },
  });
  prepareBridgeToken(directory);
  assert.equal(calls, 1);
});

test('check without local token fails without accessing Keychain', t => {
  assert.throws(() => prepareBridgeToken(fixture(t), { readLegacy() { assert.fail('must not prompt'); } }), /einmal/);
});

test('denied import does not publish a token and can be retried', t => {
  const directory = fixture(t);
  assert.throws(() => prepareBridgeToken(directory, { importLegacy: true, readLegacy() { throw new Error('denied'); } }), /Einrichtung/);
  assert.equal(fs.existsSync(bridgeTokenFile(directory)), false);
  prepareBridgeToken(directory, { importLegacy: true, readLegacy: () => 'retry-token' });
  assert.equal(fs.readFileSync(bridgeTokenFile(directory), 'utf8'), 'retry-token');
});

test('corrupt cached token never falls back to Keychain', t => {
  const directory = fixture(t);
  fs.writeFileSync(bridgeTokenFile(directory), '');
  assert.throws(() => prepareBridgeToken(directory, {
    importLegacy: true, readLegacy() { assert.fail('must not prompt'); },
  }), /leer/);
});

test('symlink token is rejected without touching its destination', t => {
  const directory = fixture(t);
  const destination = path.join(directory, 'other');
  fs.writeFileSync(destination, 'preserve', { mode: 0o644 });
  fs.symlinkSync(destination, bridgeTokenFile(directory));
  assert.throws(() => prepareBridgeToken(directory, { importLegacy: true, readLegacy() { assert.fail('must not prompt'); } }), /reguläre/);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'preserve');
});

test('generated scheduled runner reads local token and fails closed if it is removed', t => {
  const directory = fixture(t);
  const worker = path.join(directory, 'worker');
  fs.mkdirSync(path.join(worker, 'src'), { recursive: true });
  fs.mkdirSync(path.join(worker, 'config'));
  fs.writeFileSync(path.join(worker, 'src/config.js'), 'module.exports = { loadConfig() { return {}; } };');
  fs.writeFileSync(path.join(worker, 'src/hub-transport.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(worker, 'config/worker.local.json'), '{}');
  const output = path.join(directory, 'output');
  execFileSync('/bin/bash', [path.resolve('scripts/install-newsletter-monitor.sh'), '--generate-only', '--output-dir', output], {
    env: { ...process.env, NEWSLETTER_WORKER_ROOT: worker, MONITOR_TEAM_ID: 'DEMO1234',
      MONITOR_RELAY_URL: 'https://monitor.example.test', MONITOR_NODE_PATH: process.execPath,
      MONITOR_WORKFLOWS_FILE: '', MONITOR_HUB_FLEET_DIRECTORY: '', MONITOR_BRIDGE_CACHE: '' },
    stdio: 'pipe',
  });
  const service = path.join(output, 'service');
  const runnerFile = path.join(service, 'run.sh');
  const stub = path.join(directory, 'bridge-stub.mjs');
  fs.writeFileSync(stub, "if (process.env.MONITOR_BRIDGE_TOKEN !== 'test-token') process.exit(2); console.log('local token verified');");
  const runner = fs.readFileSync(runnerFile, 'utf8');
  assert.doesNotMatch(runner, /security|find-generic-password/);
  fs.writeFileSync(runnerFile, runner.replace(path.resolve('scripts/newsletter-monitor-bridge.mjs'), stub));
  prepareBridgeToken(service, { importLegacy: true, readLegacy: () => 'test-token' });
  for (let i = 0; i < 3; i++) {
    assert.equal(execFileSync('/bin/bash', [runnerFile], { encoding: 'utf8' }).trim(), 'local token verified');
  }
  fs.unlinkSync(bridgeTokenFile(service));
  assert.throws(() => execFileSync('/bin/bash', [runnerFile], { stdio: 'pipe' }));
});
