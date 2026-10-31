import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { addRunDetails, buildBlockedErrors, collectSnapshot, parseClaim, parseRegisterClaim, undeliveredQuestionAttempts } from './newsletter-monitor-bridge.mjs';
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
  // Only the open copy proves the question undelivered; the claim's owner carries no code (FP17).
  const copied = { undeliveredAttempts: new Set(['a1']) };
  for (const technical of [apply(row({ blockerOwner: 'technik' }), copied), apply(row({ blockerOwner: 'pm' }), copied)]) {
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

// Fehleraudit 30.10.2026 (FP17, Integrationsreview): the worker types technik also for other
// stops that end with a ❓ (blocker-owner.js: a correction or translation without output route,
// legacyRouteStop; a source changed during preparation; a held source renewal). The claim carries
// only the owner, no code, so such a row is no undelivered question: Technik with its own cause
// and the ordinary technical step, never „Registrierung technisch reparieren“.
const LEGACY = 'Für diese Altquelle fehlt ein bestätigter Ausgabeweg. Newsletter- und Flow-Korrekturen werden über die vollständige Hub-Übernahme fortgesetzt; eine unbekannte Quellenbindung muss technisch geklärt werden. Angenommene PM-Antworten und vorhandene Arbeit bleiben erhalten.';
const TECHNICAL_STEP = 'Technischen Originalbefund beheben und den betroffenen Schritt mit den vorhandenen Belegen prüfen.';
test('a ❓ of a run typed technik for another reason is Technik with its own cause, not an undelivered question', t => {
  const open = change => ({ status: 'blocked', phase: 'PM-Rückfrage offen', reasonCode: 'pm_decision_pending', responsibleRole: 'PM',
    nextStep: 'Die offene Entscheidung im bestehenden Rückfragen-Thread klären; vorhandene Arbeit erhalten.', blockerOwner: 'technik',
    updatedAt: new Date(now - 10000).toISOString(), ...change });
  const legacy = () => open({ id: 'correction:korrektur-cu-t2@1000-intern', title: 'Korrektur Mail', url: 'https://app.clickup.com/t/t2',
    workflow: 'correction', attemptId: 'run-t2', blockedReason: LEGACY, blockerReason: LEGACY });
  const changed = () => open({ id: 'clickup:upload:t3', title: 'Upload Mail', url: 'https://app.clickup.com/t/t3', workflow: 'upload', attemptId: 'run-t3',
    blockedReason: 'PM-Entscheidung erforderlich: Aufgabenquelle während der Vorbereitung geändert (Briefing).' });
  const rows = applyBlockerContexts([legacy(), changed()], [], now);
  assert.deepEqual([rows[0].phase, rows[0].responsibleRole, rows[0].reasonCode, rows[0].blockerKind, rows[0].nextStep],
    ['Korrektur blockiert', 'Technik', 'technical_blocker', 'technical_failure', TECHNICAL_STEP]);
  assert.match(rows[0].blockedReason, /^Gesicherter Befund: Für diese Altquelle fehlt ein bestätigter Ausgabeweg\..* · Zuständig: Technik/);
  assert.deepEqual([rows[1].phase, rows[1].responsibleRole, rows[1].reasonCode, rows[1].blockerKind, rows[1].nextStep],
    ['Blockiert', 'Technik', 'preparation_source_changed', 'technical_failure', 'Geänderte Angaben aus dem Befund mit der gespeicherten Vorbereitung abgleichen; Arbeitsstand erhalten.']);
  for (const row of rows) assert.doesNotMatch(row.blockedReason, /nicht im Fragen-Hub registriert|PM-Rückfrage nicht zugestellt/);
  // The relay keeps both a technical blocker instead of „Wartet · PM-Rückfrage“.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fehleraudit-3010-fp17-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory, () => now);
  store.updateQueue('TEAM1234', { source: { name: 'ClickUp', lastSuccessAt: new Date(now).toISOString() }, tasks: rows });
  assert.deepEqual(store.snapshot('TEAM1234').queue.tasks.map(row => [row.status, row.phase]), [['blocked', 'Korrektur blockiert'], ['blocked', 'Blockiert']]);
  // An open copy „PM-Rückfrage nicht zugestellt“ of the same attempt still decides.
  const [undelivered] = applyBlockerContexts([legacy()], [], now, { undeliveredAttempts: new Set(['run-t2']) });
  assert.deepEqual([undelivered.phase, undelivered.responsibleRole, undelivered.nextStep], ['Blockiert · PM-Rückfrage nicht zugestellt', 'Technik', UNDELIVERED]);
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
  const snapshot = (errors, reservationReader) => collectSnapshot({ now, config, fleetReader: async () => [], reservationReader,
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
  // FP17: a ❓ of a run the worker typed technik for another reason (owner from the RS Hub
  // register), without such a copy, is Technik with the ordinary step, no undelivered question.
  const register = () => [parseRegisterClaim({ runId: 'run-t1', taskId: job, worker: 'macworker-5-schwarz', state: 'final',
    ts: '1792360700.000001', slackTs: '1792360700.000001', heartbeat: now / 1000, reactions: [], owner: 'technik' })];
  const technical = (await snapshot([], register)).tasks.find(value => value.attemptId === 'run-t1');
  assert.deepEqual([technical.status, technical.phase, technical.responsibleRole, technical.nextStep],
    ['blocked', 'Korrektur blockiert', 'Technik', 'Technischen Originalbefund beheben und den betroffenen Schritt mit den vorhandenen Belegen prüfen.']);
});

// A Slack outage on a cold status cache keeps the attempt's earlier ❓ (addRunDetails); the
// undelivered phase of the previous snapshot must not let the typed pm owner decide again.
test('during a Slack outage the undelivered question of the same attempt stays Technik', async () => {
  const job = '12451cu8w7p@1793382441876-klaviyo';
  const fresh = () => ({ id: 'clickup:upload:12451cu8w7p', url: 'https://app.clickup.com/t/12451cu8w7p', workflow: 'upload', status: 'blocked',
    attemptId: RUN, blockerOwner: 'pm', run: { id: RUN, jobId: job, taskId: '12451cu8w7p', ts: '1793389672.000100', channelId: 'CUPLOAD', heartbeat: 1 } });
  const parent = { ts: '1793389672.000100', bot_id: 'bot', metadata: { event_type: 'ai_klaviyo_upload_claim',
    event_payload: { task_id: job, run_id: RUN, worker: 'macworker-5-schwarz', state: 'final', heartbeat: 1 } } };
  const notice = { ts: '1793389672.000200', bot_id: 'bot', text: '❓ Wartet · PM-Rückfrage\nDer Welcome Flow steht in Klaviyo inzwischen auf live.',
    metadata: { event_type: 'ai_newsletter_notice', event_payload: { notification_id: `${RUN}:status` } } };
  const cycle = async (hubFetch, previousTasks, copies) => {
    const row = fresh();
    await addRunDetails([row], { hubFetch, channelId: 'CUPLOAD', previousTasks, now });
    return applyBlockerContexts([row], [], now, { undeliveredAttempts: undeliveredQuestionAttempts(copies) })[0];
  };
  const first = await cycle(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, messages: [parent, notice] }) }), [], [copy()]);
  assert.deepEqual([first.phase, first.responsibleRole], ['Blockiert · PM-Rückfrage nicht zugestellt', 'Technik']);
  const outage = async () => { throw Error('temporary outage'); };
  const kept = await cycle(outage, [first], [copy()]);
  assert.deepEqual([kept.phase, kept.responsibleRole, kept.nextStep], ['Blockiert · PM-Rückfrage nicht zugestellt', 'Technik', UNDELIVERED]);
  // Registered meanwhile (copy gone): the open question is the PM's again.
  const registered = await cycle(outage, [first], []);
  assert.deepEqual([registered.phase, registered.responsibleRole], ['PM-Rückfrage offen', 'PM']);
});
