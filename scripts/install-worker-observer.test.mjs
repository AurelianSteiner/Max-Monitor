import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkerObserver, OBSERVER_SOURCE } from './install-worker-observer.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-bootstrap-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const workerRoot = path.join(home, 'registered-worker');
  const calls = [];
  const previousRoot = process.env.MAC_MONITOR_WORKER_ROOT;
  t.after(() => previousRoot === undefined ? delete process.env.MAC_MONITOR_WORKER_ROOT : process.env.MAC_MONITOR_WORKER_ROOT = previousRoot);
  const dependencies = { home, platform: 'darwin', node: '/registered/node', installFigma: () => ({ installed: true }),
    loadConfig: (file, { root }) => { calls.push({ file, root }); return { root, clickup: { transport: 'rs_hub' } }; },
    loadAgent: entry => ({ deviceIdOf: () => undefined, collectSkillRelease: () => undefined, installAgent: (_config, options) => { calls.push({ entry, ...options }); return { installed: true }; } }),
    runner: () => { throw Error('unexpected download'); } };
  return { home, workerRoot, calls, dependencies };
}
test('bootstrap preserves the exact worker profile and prefers its canonical observer', async t => {
  const f = await fixture(t); const entry = path.join(f.workerRoot, 'src/monitor-agent.js');
  await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(entry, 'canonical worker observer');
  const workerConfig = path.join(f.home, 'profiles/mac.json');
  assert.equal((await ensureWorkerObserver({ workerRoot: f.workerRoot, workerConfig }, f.dependencies)).installed, true);
  assert.equal(f.calls[0].file, workerConfig); assert.equal(f.calls[1].entry, entry);
  assert.equal(f.calls[1].node, '/registered/node');
  assert.equal(process.env.MAC_MONITOR_WORKER_ROOT, f.workerRoot);
});
test('bootstrap rejects unverified downloads before saving or loading executable code', async t => {
  const f = await fixture(t);
  f.dependencies.runner = async (command, args) => {
    assert.equal(command, 'gh'); assert.ok(args[1].endsWith(OBSERVER_SOURCE.revision));
    return Buffer.from('untrusted code').toString('base64');
  };
  await assert.rejects(ensureWorkerObserver({ workerRoot: f.workerRoot }, f.dependencies), /Prüfsumme/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(fs.access(path.join(f.home, '.local/share/mac-monitor-agent/agent.cjs')));
});
test('checks and dry runs never install the observer or read worker credentials', async t => {
  const f = await fixture(t);
  for (const flag of ['check', 'dryRun']) {
    assert.deepEqual(await ensureWorkerObserver({ workerRoot: f.workerRoot, [flag]: true }, f.dependencies), { installed: false });
  }
  assert.equal(f.calls.length, 0);
});
test('an older observer does not prevent the compatible bootstrap from being fetched', async t => {
  const f = await fixture(t); const entry = path.join(f.workerRoot, 'src/monitor-agent.js');
  await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(entry, 'old observer');
  f.dependencies.loadAgent = () => ({ installAgent: () => assert.fail('old observer must not be installed') });
  let downloaded = false;
  f.dependencies.runner = async () => { downloaded = true; return Buffer.from('incorrect download').toString('base64'); };
  await assert.rejects(ensureWorkerObserver({ workerRoot: f.workerRoot }, f.dependencies), /Prüfsumme/);
  assert.equal(downloaded, true);
});
