import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPmOwners, createPmRoutingReader } from './pm-owner.mjs';

const row = (overrides = {}) => ({ id: 'clickup:upload:t1', workflow: 'upload', status: 'queued',
  phase: 'Wartet · PM-Rückfrage', url: 'https://app.clickup.com/t/t1', attemptId: 'run1', ...overrides });
const set = (overrides = {}) => ({ mode: 'production', taskId: 't1', stage: 'klaviyo', runId: 'run1',
  team: 'Ben & Abdou', channelId: 'C0C994GPYKS', threadTs: '1790000000.000001',
  questions: [{ id: 'Q1', status: 'open' }], ...overrides });

test('the actual Slack destination supplies both PMs and overrides contradictory ClickUp fields', async () => {
  for (const [team, channelId] of [['Ben & Abdou', 'C0C994GPYKS'], ['Hannes & Luca', 'C0C88G211UK'], ['John', 'C0C89DYUDDK']]) {
    const current = row({ pmOwner: 'Aurelian Steiner', pmOwnerId: 'wrong' });
    await applyPmOwners([current], [{ id: 't1', custom_fields: [{ name: 'PM', value: [{ username: 'Aurelian Steiner' }] }] }],
      { questions: { sets: [set({ team, channelId })] } });
    assert.equal(current.pmOwner, team); assert.equal(current.pmOwnerId, undefined);
  }
});

test('old, answered, wrong-task, test-mode and mismatched-channel journals cannot supply a name', async () => {
  for (const changes of [{ runId: 'old' }, { taskId: 'other' }, { stage: 'newsletter' }, { mode: 'test' },
    { questions: [{ status: 'accepted' }] }, { channelId: 'C0C89DYUDDK' }, { threadTs: undefined }]) {
    const current = row({ pmOwner: 'Wrong name' });
    await applyPmOwners([current], [], { questions: { sets: [set(changes)] } });
    assert.equal(current.pmOwner, undefined);
  }
  const current = row();
  await applyPmOwners([current], [], { questions: { sets: [set(), set()] }, routing: {
    channels: { C0C994GPYKS: 'Ben & Abdou' }, resolve: () => assert.fail('Do not guess between journals'),
  } });
  assert.equal(current.pmOwner, undefined);
});

test('corrections and translations respect their exact stage and language binding', async () => {
  const correction = row({ workflow: 'correction' });
  await applyPmOwners([correction], [], { questions: { sets: [set({ stage: 'korrektur', team: 'John', channelId: 'C0C89DYUDDK' })] } });
  assert.equal(correction.pmOwner, 'John');
  const translation = row({ id: 'clickup:translation-fr:t1', workflow: 'translation' });
  await applyPmOwners([translation], [], { questions: { sets: [set({ stage: 'translation', language: 'EN' })] } });
  assert.equal(translation.pmOwner, undefined);
});

test('running, completed and continuation tasks remain unchanged', async () => {
  for (const current of [row({ status: 'running' }), row({ status: 'completed' }), row({ phase: 'Wartet auf Fortsetzung' })]) {
    const before = structuredClone(current);
    await applyPmOwners([current], [], { questions: { sets: [set()] } });
    assert.deepEqual(current, before);
  }
});

test('legacy questions reuse the original PM service resolver and channel table with a bounded cache', async () => {
  let calls = 0, now = 1000000;
  const routing = createPmRoutingReader('/opt/rs-hub', { clock: () => now, load: file => {
    if (file.endsWith('/pm-questions.js')) return { CHANNELS: { 'Ben & Abdou': { id: 'C0C994GPYKS' } } };
    assert.equal(file, '/opt/rs-pm-question-pilot/src/pm-question-hub.js');
    return { resolveCustomer: async (hub, id) => {
      assert.equal(hub, '/opt/rs-hub'); assert.equal(id, 't1'); calls++;
      return { taskId: id, team: 'Ben & Abdou', customerId: 'customer' };
    } };
  } });
  // The relay classifies some persisted PM blockers only after publication.
  // They must already carry the shared recipient team in the source snapshot.
  const rows = [row(), row({ status: 'blocked', phase: 'Blockiert · Fortschritt im RS Hub gesichert',
    responsibleRole: 'PM', pmOwner: 'Ben Schulte' })];
  await applyPmOwners(rows, [], { routing });
  assert.equal(calls, 1); assert.ok(rows.every(r => r.pmOwner === 'Ben & Abdou'));
  now += 300000;
  await applyPmOwners(rows, [], { routing }); assert.equal(calls, 2);
});

test('an unavailable shared route clears old names without failing the queue or changing its status', async () => {
  const current = row({ pmOwner: 'Wrong name', blockerSource: 'checkpoint',
    blockedReason: 'Gesicherter Befund: Kommentar fehlt · Zuständig: PM (PM: Wrong name) · Nächster Schritt: Klären.' });
  await applyPmOwners([current], [], { routing: { channels: {}, resolve: async () => { throw Error('offline'); } } });
  assert.equal(current.pmOwner, undefined); assert.equal(current.status, 'queued');
  assert.equal(current.blockedReason, 'Gesicherter Befund: Kommentar fehlt · Zuständig: PM (PM in Slack noch nicht bestätigt) · Nächster Schritt: Klären.');
});
