import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildBlockedErrors, collectSnapshot, parseClaim, undeliveredQuestionAttempts } from './newsletter-monitor-bridge.mjs';
import { applyBlockerContexts } from './blocker-context.mjs';
const { createFleetStore } = createRequire(import.meta.url)('../team-server/fleet.js');

// Fehleraudit 30.10.2026 (pm-zuordnung P1): a PM question the Fragen-Hub refused or never
// registered has no thread; the PM sees nothing. artifex 12451cu8w7p-klaviyo (Schwarz,
// 30.10. 19:48Z „PM-Frage braucht genau eine tatsächlich gebundene Paketmail“) showed in the
// queue row and in its #ai-fehler copy „Zuständig: PM“, because the worker typed the run pm.
const channel = 'C0C8HK2NDFE';
const now = Date.parse('2026-10-30T22:00:00Z');
const RUN = '20261030T174808Z-0f8b-12451cu8w7p@1793382441876-klaviyo';
const UNDELIVERED = 'PM-Frage ist nicht im Fragen-Hub registriert; Registrierung technisch reparieren – der PM sieht noch keine Frage.';
const copy = (payload = {}, extra = {}) => ({ ts: '1793389723.277939', bot_id: 'bot',
  text: ['*Klaviyo Upload · artifex*', '⚠️ PM-Rückfrage nicht zugestellt: <https://app.clickup.com/t/12451cu8w7p|Welcome Flow>',
    'Rückfrage nicht zugestellt: PM-Frage braucht genau eine tatsächlich gebundene Paketmail',
    '<https://ruegamer-steiner.slack.com/archives/CUPLOAD/p1793389672000100|Meldung in #ai-upload> · Mac `Schwarz`'].join('\n'),
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: { v: 1, kind: 'lauf', worker: 'macworker-5-schwarz',
    run_id: RUN, task_id: '12451cu8w7p@1793382441876-klaviyo', state: 'blockiert', grund: 'rueckfrage_nicht_zugestellt',
    owner: 'pm', ...payload } }, ...extra });

test('artifex: an undelivered PM question copy is Technik even when the worker typed the run pm', () => {
  const [row] = buildBlockedErrors([copy()], channel);
  assert.deepEqual([row.responsibleRole, row.reasonCode, row.blockerKind], ['Technik', 'technical_blocker', 'technical_failure']);
  assert.equal(row.attemptId, RUN);
  // Any other grund keeps the worker's typed owner.
  const [eingabe] = buildBlockedErrors([copy({ grund: 'eingabe' })], channel);
  assert.equal(eingabe.responsibleRole, 'PM');
});

test('an open PM question row is Technik while its question is undelivered, PM once it is registered', () => {
  const row = change => ({ id: 'clickup:upload:12451cu8w7p', url: 'https://app.clickup.com/t/12451cu8w7p', workflow: 'upload',
    status: 'blocked', phase: 'PM-Rückfrage offen', reasonCode: 'pm_decision_pending', attemptId: 'a1',
    blockedReason: 'Der Welcome Flow steht in Klaviyo inzwischen auf live.', ...change });
  const apply = (value, options) => applyBlockerContexts([value], [], now, options)[0];
  for (const technical of [apply(row({ blockerOwner: 'technik' })), apply(row({ blockerOwner: 'pm' }), { undeliveredAttempts: new Set(['a1']) })]) {
    assert.deepEqual([technical.phase, technical.responsibleRole, technical.reasonCode, technical.blockerKind],
      ['Blockiert · PM-Rückfrage nicht zugestellt', 'Technik', 'technical_blocker', 'technical_failure']);
    assert.equal(technical.nextStep, UNDELIVERED);
    assert.match(technical.blockedReason, /Zuständig: Technik[^·]* · Nächster Schritt: PM-Frage ist nicht im Fragen-Hub registriert/);
  }
  // A registered question (no open copy for this attempt) stays the PM's decision.
  for (const options of [undefined, { undeliveredAttempts: new Set(['other-attempt']) }]) {
    const pm = apply(row({ blockerOwner: 'pm' }), options);
    assert.deepEqual([pm.phase, pm.responsibleRole, pm.reasonCode], ['PM-Rückfrage offen', 'PM', 'pm_decision_pending']);
  }
  // A setup gap posted with ❓ keeps its own owner.
  const setup = apply(row({ blockerOwner: 'onboarding', blockedReason: 'Kunde fehlt im RS Hub' }), { undeliveredAttempts: new Set(['a1']) });
  assert.equal(setup.phase, 'Blockiert · Kunden-Setup');
});

test('only open top-level undelivered-question copies with a valid run name their attempt', () => {
  const attempts = undeliveredQuestionAttempts([
    copy(),
    copy({ run_id: 'reply-run' }, { ts: '1793389724.000001', thread_ts: '1793389723.277939' }),
    copy({ run_id: 'other-grund', grund: 'erschoepft' }, { ts: '1793389725.000001' }),
    copy({ run_id: 'withdrawn', state: 'abgebrochen_tag_entfernt' }, { ts: '1793389726.000001' }),
    copy({ run_id: 'system', kind: 'system' }, { ts: '1793389727.000001' }),
    copy({ run_id: 'bad run!' }, { ts: '1793389728.000001' }),
    copy({ run_id: 'x'.repeat(201) }, { ts: '1793389729.000001' }),
    { ts: '1793389730.000001', text: 'Neue Meldung' },
  ]);
  assert.deepEqual([...attempts], [RUN]);
});

// The whole cycle: the bridge hands the open copies of #ai-fehler to the blocker contexts,
// and the relay keeps the row a technical blocker instead of „Wartet · PM-Rückfrage“.
test('a full snapshot shows the open question of an undelivered copy as Technik; without the copy it stays PM', async t => {
  const job = 'korrektur-cu-t1@1000-intern';
  const claim = parseClaim({ ts: '1792360700.000001', text: '*Korrektur · Kunde*\n:repeat: Fortsetzung: <https://app.clickup.com/t/t1|Mail>',
    reactions: [{ name: 'question' }], metadata: { event_type: 'ai_korrektur_claim', event_payload: { task_id: job,
      run_id: 'run-t1', worker: 'macworker-5-schwarz', state: 'final', heartbeat: now / 1000, owner: 'pm' } } });
  const error = copy({ run_id: 'run-t1', task_id: job, state: 'unklar' });
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { errors: channel }, hub: {} };
  const snapshot = errors => collectSnapshot({ now, config, fleetReader: async () => [],
    claimReader: async (fetcher, id, { onMessage = () => {} } = {}) => {
      if (id !== channel) return [claim];
      for (const message of errors) onMessage(message);
      return [];
    },
    hubFetch: async target => {
      const url = new URL(target);
      if (url.pathname.endsWith('/task/t1')) return { ok: true, status: 200, json: async () => ({ id: 't1', name: 'Mail', status: { status: 'revision intern' }, statusSince: '1000', tags: [] }) };
      return { ok: true, status: 200, json: async () => url.hostname === 'slack.com' ? { ok: true, messages: [], has_more: false } : { spaces: [], tasks: [], last_page: true } };
    } });
  const open = await snapshot([error]);
  const row = open.tasks.find(value => value.attemptId === 'run-t1');
  assert.deepEqual([row.status, row.phase, row.responsibleRole, row.nextStep], ['blocked', 'Blockiert · PM-Rückfrage nicht zugestellt', 'Technik', UNDELIVERED]);
  assert.deepEqual(open.blockedErrors.map(value => value.responsibleRole), ['Technik']);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fehleraudit-3010-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory, () => now);
  store.updateQueue('TEAM1234', { source: open.source, tasks: open.tasks, blockedErrors: open.blockedErrors });
  const relayed = store.snapshot('TEAM1234').queue.tasks.find(value => value.attemptId === 'run-t1');
  assert.deepEqual([relayed.status, relayed.phase], ['blocked', 'Blockiert · PM-Rückfrage nicht zugestellt']);
  const registered = (await snapshot([])).tasks.find(value => value.attemptId === 'run-t1');
  assert.deepEqual([registered.phase, registered.responsibleRole], ['PM-Rückfrage offen', 'PM']);
});
