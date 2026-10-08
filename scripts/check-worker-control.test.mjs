import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { checkWorkerControl, main } from './check-worker-control.mjs';

const settings = { serverURL: 'https://monitor.example.test/relay', teamId: 'CTRL1234', ownerToken: 'private-test-owner' };
const reply = { schema: 1, workerId: 'mac-a', enabled: false, reason: 'disabled', token: settings.ownerToken };
test('Hub permission command is read-only, validates identity and prints no credentials', async () => {
  let output = '';
  await main(['--stdin'], { settings, input: Readable.from([JSON.stringify({ workerId: 'mac-a' })]), output: { write: s => { output += s; } },
    fetchImpl: async (url, options) => {
      assert.equal(url, settings.serverURL + '/v1/teams/CTRL1234/workers/mac-a/control');
      assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, `Bearer ${settings.ownerToken}`);
      return { ok: true, json: async () => reply };
    } });
  assert.deepEqual(JSON.parse(output), { schema: 1, workerId: 'mac-a', enabled: false, reason: 'disabled' });
  assert.ok(!output.includes(settings.ownerToken));
});
test('malformed identities, unavailable relay and incompatible permissions never authorize work', async () => {
  for (const value of ['../../members', '', 'mac A']) await assert.rejects(checkWorkerControl(settings, value));
  for (const response of [
    { ok: false, status: 503 },
    { ok: true, json: async () => ({ ...reply, workerId: 'mac-other' }) },
    { ok: true, json: async () => ({ ...reply, enabled: true }) },
    { ok: true, json: async () => ({ ...reply, enabled: 'true' }) },
  ]) await assert.rejects(checkWorkerControl(settings, 'mac-a', { fetchImpl: async () => response }));
});
