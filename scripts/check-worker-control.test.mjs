import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { checkWorkerControl, main } from './check-worker-control.mjs';

const settings = { serverURL: 'https://monitor.example.test/relay', teamId: 'CTRL1234', ownerToken: 'private-test-owner' };
const reply = { schema: 1, workerId: 'mac-a', enabled: false, reason: 'disabled', token: settings.ownerToken };
test('Hub forwards account restrictions and re-enable but rejects invalid restrictions', async () => {
  for (const disabledClaudeAccountIds of [[], ['primary'], ['primary', 'account-2']]) {
    const result = await checkWorkerControl(settings, 'mac-a', {fetchImpl: async () => ({ok: true,
      json: async () => ({...reply, disabledClaudeAccountIds})})});
    assert.deepEqual(result.disabledClaudeAccountIds, disabledClaudeAccountIds);
    assert.equal(result.token, undefined);
  }
  for (const disabledClaudeAccountIds of [null, ['unknown'], ['primary', 'primary'], 'primary'])
    await assert.rejects(checkWorkerControl(settings, 'mac-a', {fetchImpl: async () => ({ok: true,
      json: async () => ({...reply, disabledClaudeAccountIds})})}));
});
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

test('Codex checks name their workflow explicitly and preserve only public profile fields', async () => {
  const workerId = 'hausdraches-macbook-air-f1e2b4ad';
  const result = await checkWorkerControl(settings, workerId, { workflow: 'technical-repair',
    fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get('workflow'), 'technical-repair');
      return { ok: true, json: async () => ({ schema: 1, workerId, enabled: true, reason: 'enabled',
        workerKind: 'codex-repair', provider: 'codex', allowedWorkflows: ['technical-repair','customer-onboarding'], token: 'never-forward' }) };
    } });
  assert.equal(result.provider, 'codex'); assert.equal(result.workerKind, 'codex-repair');
  assert.equal(result.token, undefined);
  await assert.rejects(checkWorkerControl(settings, workerId, { workflow: '../shell' }));
});
