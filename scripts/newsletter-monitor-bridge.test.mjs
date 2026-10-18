import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_WORKFLOWS, normalizeTag, validateWorkflows, discoverTags, listTasks,
  parseClaim, listClaims, parseWorkerIssue, buildQueue, parseObservedWorkers, readHubFleet,
  collectSnapshot, relayEndpoint, publishSnapshot, syncOnce, runSyncLoop,
  parseRunStatus, parseBlockedReason, addRunDetails, readRenders, createRenderPreviews, uploadPreview,
  createClaimReader, readRunStatuses, freshClaimCycle,
} from './newsletter-monitor-bridge.mjs';

const now = Date.parse('2026-10-07T12:00:00Z');
const response = data => ({ ok: true, status: 200, json: async () => data });
const task = (id, tags = ['pre gen.']) => ({ id, name: `Aufgabe ${id}`, tags: tags.map(name => ({ name })), date_updated: String(now), status: { status: 'offen' } });
// Only the ClickUp start status commissions work (worker src/workflow-status.js).
const taskIn = (status, id, tags) => ({ ...task(id, tags), status: { status } });
const claimMessage = (state = 'running', overrides = {}) => ({ ts: '1791373200.001', metadata: {
  event_type: 'ai_newsletter_claim', event_payload: { task_id: 'a', run_id: 'run-1', worker: 'newsletter-mac-1', state, heartbeat: now / 1000 - 60, ...overrides },
} });

test('tag discovery uses actual spelling from all spaces and recognizes punctuation', async () => {
  const called = [];
  const variants = await discoverTags(async target => {
    const url = new URL(target); called.push(url.pathname);
    if (url.pathname.endsWith('/space')) return response({ spaces: [{ id: 'one' }, { id: 'two' }] });
    return response({ tags: url.pathname.includes('/one/') ? [{ name: 'Pre-Gen.' }, { name: 'unrelated' }, { name: 'Upload' }] : [{ name: 'PRE GEN · LÄUFT' }, { name: 'Klaviyo Upload' }] });
  }, '24553341', DEFAULT_WORKFLOWS);
  assert.deepEqual(variants, ['Pre-Gen.', 'PRE GEN · LÄUFT', 'Klaviyo Upload']);
  assert.equal(called.length, 3);
  assert.equal(normalizeTag(' Pre-Gen. '), normalizeTag('pre gen.'));
});

test('ClickUp reads every tag in one paginated OR query, deduplicates and refuses a truncated list', async () => {
  const calls = [];
  const fetcher = async target => {
    const url = new URL(target); const page = Number(url.searchParams.get('page')); calls.push([url.searchParams.getAll('tags[]'), page]);
    assert.equal(url.searchParams.get('include_closed'), 'false'); assert.equal(url.searchParams.get('subtasks'), 'true');
    return response(page === 0 ? { tasks: [task('a'), task('b')] } : { tasks: [task('b'), task('c')], last_page: true });
  };
  const tasks = await listTasks(fetcher, '24553341', ['pre gen.', 'pre gen · läuft'], { pageSize: 2 });
  assert.deepEqual(tasks.map(value => value.id), ['a', 'b', 'c']);
  // ClickUp joins several tags[] with OR; one query keeps the shared Hub token far below its rate limit.
  assert.deepEqual(calls, [[['pre gen.', 'pre gen · läuft'], 0], [['pre gen.', 'pre gen · läuft'], 1]]);
  assert.deepEqual(await listTasks(async () => { throw new Error('no tags, no request'); }, '24553341', []), []);
  await assert.rejects(() => listTasks(fetcher, '24553341', ['pre gen.'], { pageSize: 2, maxPages: 1 }), /unvollständig/);
});

test('Slack metadata pagination reads every page and fails without continuation cursor', async () => {
  let page = 0;
  const claims = await listClaims(async target => {
    const url = new URL(target); assert.equal(url.searchParams.get('include_all_metadata'), 'true');
    if (page++ === 0) return response({ ok: true, messages: [claimMessage()], has_more: true, response_metadata: { next_cursor: 'next' } });
    assert.equal(url.searchParams.get('cursor'), 'next');
    return response({ ok: true, messages: [claimMessage('released', { task_id: 'b' })], has_more: false });
  }, 'C0C6NMMGGJV', { now });
  assert.equal(claims.length, 2); assert.equal(claims[0].workerId, 'newsletter-mac-1');
  assert.equal(parseClaim({ metadata: { event_type: 'other' } }), null);
  await assert.rejects(() => listClaims(async () => response({ ok: true, messages: [], has_more: true }), 'channel', { now }), /Cursor/);
});

test('queue separates workflows and makes stale claims visible without inventing progress', () => {
  const claims = [parseClaim(claimMessage()), parseClaim(claimMessage('running', { task_id: 'stale', heartbeat: now / 1000 - 1900 }))];
  const queue = buildQueue([
    taskIn('pre-gen', 'a', ['pre gen.', 'klaviyo upload']), taskIn('klaviyo upload', 'u', ['klaviyo upload']), task('stale'), task('blocked', ['pre gen · blockiert']),
    task('done', ['pre gen · fertig']), task('ignored', ['unrelated']),
  ], claims, DEFAULT_WORKFLOWS, { now });
  assert.equal(queue.length, 5);
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').status, 'running');
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').workerId, 'newsletter-mac-1');
  // The old upload trigger on a Pre-Gen order is no upload order (only the status commissions it).
  assert.equal(queue.some(row => row.id === 'clickup:upload:a'), false);
  assert.equal(queue.find(row => row.id === 'clickup:upload:u').status, 'queued');
  assert.equal(queue.find(row => row.id === 'clickup:upload:u').workerId, undefined);
  assert.equal(queue.find(row => row.id.endsWith(':stale')).status, 'blocked');
  assert.equal(queue.find(row => row.id.endsWith(':stale')).phase, 'Worker meldet sich nicht mehr');
  assert.equal(queue.find(row => row.id.endsWith(':blocked')).status, 'blocked');
  assert.equal(queue.find(row => row.id.endsWith(':done')).progress, 100);
  assert.equal(queue.find(row => row.id === 'clickup:newsletter:a').progress, undefined);
});

test('released claims do not mark a queued task running; explicit completed tag wins', () => {
  const queue = buildQueue([taskIn('pre-gen', 'a'), task('b', ['pre gen · fertig'])], [
    parseClaim(claimMessage('released')), parseClaim(claimMessage('running', { task_id: 'b' })),
  ], DEFAULT_WORKFLOWS, { now });
  assert.equal(queue[0].status, 'queued'); assert.equal(queue[0].workerId, undefined);
  assert.equal(queue[1].status, 'completed');
});

const jobClaim = (event, jobId, worker, state = 'running', ts = '1791373200.002') => ({ ts, metadata: {
  event_type: event, event_payload: { v: 1, task_id: jobId, run_id: `run-${jobId}`, worker, state, heartbeat: now / 1000 - 30 },
} });

test('a Klaviyo upload accepted by a Mac stays visible with its exact worker', () => {
  // 09.10.2026: macworker-5-schwarz swapped "klaviyo upload" for "klaviyo upload · läuft"
  // and reserved 12451cu4xnc-klaviyo; the monitor lost the task completely.
  const claim = parseClaim(jobClaim('ai_klaviyo_upload_claim', '12451cu4xnc-klaviyo', 'macworker-5-schwarz'));
  assert.deepEqual([claim.taskId, claim.workflow, claim.workerId], ['12451cu4xnc', 'klaviyo', 'macworker-5-schwarz']);
  const queue = buildQueue([
    taskIn('klaviyo upload', '12451cu4xnc', ['drogi', 'klaviyo upload · läuft']), taskIn('klaviyo upload', 'waiting', ['klaviyo upload · wartet']),
    taskIn('klaviyo upload', 'stopped', ['klaviyo upload · blockiert']), taskIn('klaviyo upload', 'done', ['klaviyo upload · fertig']), taskIn('klaviyo upload', 'new', ['klaviyo upload']),
  ], [claim], DEFAULT_WORKFLOWS, { now });
  const row = queue.find(item => item.id === 'clickup:upload:12451cu4xnc');
  assert.deepEqual([row.workflow, row.status, row.workerId, row.phase], ['upload', 'running', 'macworker-5-schwarz', 'In Bearbeitung']);
  assert.deepEqual(['waiting', 'stopped', 'done', 'new'].map(id => queue.find(item => item.id === `clickup:upload:${id}`).status),
    ['queued', 'blocked', 'completed', 'queued']);
  assert.equal(queue.some(item => item.workflow === 'newsletter'), false, 'an upload is not a Pre-Gen task');
});

test('translations appear per language with their own reservation', () => {
  const claims = [
    parseClaim(jobClaim('ai_translation_claim', 't-uebersetzung-en', 'macbook-1')),
    parseClaim(jobClaim('ai_translation_claim', 't-uebersetzung-fr', 'macbook-2', 'claiming', '1791373200.003')),
  ];
  assert.deepEqual([claims[0].taskId, claims[0].workflow], ['t', 'translation-en']);
  const queue = buildQueue([task('t', ['pre gen · fertig', 'EN Translation', 'fr translation', 'it translation · fertig', 'sp translation · blockiert'])],
    claims, DEFAULT_WORKFLOWS, { now });
  const byId = Object.fromEntries(queue.map(item => [item.id, item]));
  assert.deepEqual(Object.keys(byId).sort(), ['clickup:newsletter:t', 'clickup:translation-en:t', 'clickup:translation-fr:t',
    'clickup:translation-it:t', 'clickup:translation-sp:t']);
  const en = byId['clickup:translation-en:t'];
  assert.deepEqual([en.workflow, en.title, en.status, en.workerId, en.phase], ['translation', 'Aufgabe t · EN', 'running', 'macbook-1', 'In Bearbeitung']);
  const fr = byId['clickup:translation-fr:t'];
  assert.deepEqual([fr.status, fr.workerId, fr.phase], ['queued', 'macbook-2', 'Reserviert']);
  assert.equal(byId['clickup:translation-it:t'].status, 'completed');
  assert.equal(byId['clickup:translation-sp:t'].status, 'blocked');
  assert.equal(byId['clickup:newsletter:t'].workerId, undefined, 'a translation claim never assigns the newsletter');
});

test('language packages preserve exact source links and reject ambiguous or cross-customer links', () => {
  const de = { ...taskIn('pre-gen', 'de1'), name: 'DE | Herbst', folder: { id: 'customer-a' } };
  const en = { ...taskIn('pre-gen', 'en1'), name: 'EN | Herbst', folder: { id: 'customer-a' }, markdown_description: 'Deutsches Briefing: https://app.clickup.com/t/24553341/de1' };
  const rows = buildQueue([de, en], [], DEFAULT_WORKFLOWS, { now });
  assert.equal(rows.find(row => row.id.endsWith(':en1')).packageId, 'de1');
  assert.equal(rows.find(row => row.id.endsWith(':en1')).language, 'en');
  assert.equal(rows.find(row => row.id.endsWith(':de1')).packageId, 'de1');
  for (const sources of [[{ ...de, folder: { id: 'other-customer' } }], [],
    [de, { ...de, id: 'de2' }]]) {
    const input = { ...en, markdown_description: en.markdown_description + ' https://app.clickup.com/t/de2' };
    assert.equal(buildQueue([...sources, input], [], DEFAULT_WORKFLOWS, { now }).find(row => row.id.endsWith(':en1')).packageId, 'en1');
  }
  const task = taskIn('pre-gen', 'single', ['pre gen · läuft', 'en translation']);
  assert.ok(!buildQueue([task], [], DEFAULT_WORKFLOWS, { now }).some(row => row.workflow === 'translation'),
    'a historical translation tag alone never commissions another order');
  const claim = parseClaim(jobClaim('ai_translation_claim', 'single-uebersetzung-en', 'macbook-1'));
  const steps = buildQueue([task], [claim], DEFAULT_WORKFLOWS, { now });
  assert.ok(steps.every(row => row.packageId === 'single'));
  assert.equal(steps.find(row => row.workflow === 'translation').language, 'en');
});

test('a claim counts only when its event type matches the worker job ID', () => {
  assert.equal(parseClaim(jobClaim('ai_newsletter_claim', 'x-klaviyo', 'mac')), null);
  assert.equal(parseClaim(jobClaim('ai_klaviyo_upload_claim', 'x', 'mac')), null);
  assert.equal(parseClaim(jobClaim('ai_translation_claim', 'x-uebersetzung-de', 'mac')), null);
  assert.equal(parseClaim(jobClaim('ai_translation_claim', 'x-klaviyo', 'mac')), null);
  assert.equal(parseClaim(jobClaim('ai_newsletter_claim', 'x', 'mac')).workflow, 'newsletter');
});

test('status attempt IDs normalize to ClickUp IDs for all live job kinds', () => {
  for (const [event, id, workflow] of [
    ['ai_newsletter_claim', '86cb61veb@1791802497891', 'newsletter'],
    ['ai_klaviyo_upload_claim', '86cb61veb@1791802497891-klaviyo', 'klaviyo'],
    ['ai_translation_claim', '86cb61veb@1791802497891-uebersetzung-en', 'translation-en'],
    ['ai_korrektur_claim', 'korrektur-cu-86cb61veb@1791802497891-intern-file-b4f04c596092ebf32f72858ee3994969', 'correction'],
  ]) {
    const claim = parseClaim(jobClaim(event, id, 'macworker-5-schwarz'));
    assert.equal(claim.taskId, '86cb61veb');
    assert.equal(claim.workflow, workflow);
    const rows = buildQueue([task('86cb61veb', workflow === 'klaviyo' ? ['klaviyo upload · läuft'] : workflow === 'translation-en' ? ['en translation'] : ['pre gen · fertig'])], [claim], DEFAULT_WORKFLOWS, { now });
    if (workflow === 'correction') assert.equal(rows.find(row => row.workflow === 'correction').workerId, 'macworker-5-schwarz');
    else if (workflow !== 'newsletter') assert.equal(rows.find(row => row.status === 'running').workerId, 'macworker-5-schwarz');
  }
});

test('correction failures retain their owner and a later retry supersedes the failure', () => {
  const job = 'korrektur-cu-86cbgtpjr@1791816373962-extern';
  const make = (state, ts, reactions = []) => parseClaim({ ...jobClaim('ai_korrektur_claim', job, 'macbook-2'), ts,
    text: '*Korrektur · JuCad*\nNeue Aufgabe: <https://app.clickup.com/t/86cbgtpjr|Warm Up Kampagne: B2C>',
    reactions: reactions.map(name => ({ name })), metadata: { event_type: 'ai_korrektur_claim', event_payload: {
      task_id: job, worker: 'macbook-2', run_id: `attempt-${ts}`, state, heartbeat: now / 1000 - 60 } } });
  const failed = make('final', '100.001', ['x']);
  const rows = claims => buildQueue([task('86cbgtpjr', ['pre gen · fertig'])], claims, DEFAULT_WORKFLOWS, { now }).filter(row => row.workflow === 'correction');
  assert.equal(rows([failed])[0].status, 'blocked');
  assert.equal(rows([failed])[0].workerId, 'macbook-2');
  assert.equal(rows([failed])[0].title, 'Warm Up Kampagne: B2C');
  assert.equal(rows([failed])[0].company, 'JuCad');
  assert.equal(rows([failed])[0].attemptId, 'attempt-100.001');
  assert.equal(rows([failed, make('running', '101.001')])[0].status, 'running');
  assert.equal(rows([failed, make('final', '102.001', ['white_check_mark'])])[0].status, 'completed');
  assert.equal(rows([failed, make('released', '103.001')]).length, 0);
  assert.equal(rows([failed, make('released', '103.002', ['x'])]).length, 0);
  assert.equal(rows([failed, make('withdrawn', '104.001')])[0].status, 'blocked');
  const stale = { ...make('running', '105.001'), heartbeat: now / 1000 - 1900 };
  assert.equal(rows([stale])[0].phase, 'Worker meldet sich nicht mehr');
  assert.equal(rows([stale, make('running', '106.001')])[0].attemptId, 'attempt-106.001');
  assert.equal(rows([make('running', '105.001'), make('claiming', '106.001')])[0].attemptId, 'attempt-105.001');
});

test('blocked correction diagnosis comes from its own bot thread and is cached only for that attempt', async () => {
  const reason = 'Keine eindeutig zugeordnete Wochenfassung; zuerst Doppelablage herstellen';
  assert.equal(parseBlockedReason(`:warning: Technisch blockiert: Vorbereitung fehlgeschlagen.\nGrund: ${reason}\n:stopwatch: Dauer 10 min`), reason);
  assert.equal(parseBlockedReason('⛔ Blockiert: Passender FileStage-Link fehlt.'), 'Passender FileStage-Link fehlt.');
  assert.equal(parseBlockedReason(':warning: Technisch blockiert: Der Lauf hat ohne Ergebnis aufgehört.\n*Grund:* Bild/Farbe geändert; Konflikt\n    at checkReplacement (<input>:34:85)'), 'Bild/Farbe geändert; Konflikt');
  assert.equal(parseBlockedReason('Mensch: blockiert'), null);
  assert.match(parseBlockedReason('⛔ Blockiert: token=secret123'), /ENTFERNT/);
  const make = attemptId => ({ id: 'correction:job', workflow: 'correction', status: 'blocked', attemptId,
    run: { id: attemptId, ts: '123.001', channelId: 'correction-channel' } });
  let calls = 0;
  const fetcher = async target => {
    calls++; assert.equal(new URL(target).searchParams.get('channel'), 'correction-channel');
    return response({ ok: true, messages: [{ ts: '123.001', bot_id: 'bot', text: 'parent' },
      { ts: '123.002', text: '⛔ Blockiert: fake human reason' },
      { ts: '123.003', bot_id: 'bot', text: `:warning: Technisch blockiert: Vorbereitung fehlgeschlagen.\nGrund: ${reason}` }] });
  };
  const first = await addRunDetails([make('one')], { hubFetch: fetcher });
  assert.equal(first[0].blockedReason, reason);
  assert.equal(first[0].progress, undefined);
  const cached = await addRunDetails([make('one')], { hubFetch: fetcher, previousTasks: first });
  assert.equal(calls, 1); assert.equal(cached[0].blockedReason, reason);
  const changed = await addRunDetails([make('two')], { hubFetch: async () => { throw Error('temporary outage'); }, previousTasks: first });
  assert.equal(changed[0].blockedReason, undefined);
});

test('a terminal correction marked Fertig in its parent is completed without a reaction', () => {
  const message = { ts: '1791862331.952979', text: '*Korrektur · Happy dogs*\n:white_check_mark: Fertig: <https://app.clickup.com/t/86cb1enj9|Sortimentsvorstellung Trockenfutter>',
    metadata: { event_type: 'ai_korrektur_claim', event_payload: { task_id: 'korrektur-cu-86cb1enj9@1791813435889-extern',
      run_id: 'finished-retry', worker: 'macbook-till-main', state: 'final', heartbeat: now / 1000 } } };
  const parsed = parseClaim(message);
  const row = buildQueue([], [parsed], DEFAULT_WORKFLOWS, { now })[0];
  assert.equal(row.status, 'completed'); assert.equal(row.progress, 100);
  assert.equal(row.phase, 'Korrektur abgeschlossen'); assert.equal(row.attemptId, 'finished-retry');
  assert.equal(parseClaim({ ...message, reactions: [{ name: 'x' }] }).outcome, 'completed', 'the current terminal label supersedes an old failure reaction');
  assert.equal(parseClaim({ ...message, metadata: { ...message.metadata, event_payload: { ...message.metadata.event_payload, state: 'running' } } }).outcome, undefined);
  assert.equal(parseClaim({ ...message, text: '*Korrektur · Fertig*\n:repeat: Fortsetzung: Fertig' }).outcome, undefined);
  assert.equal(parseClaim({ ...message, text: '*Korrektur · Happy dogs*\n✅ Fertig: <https://app.clickup.com/t/86cb1enj9|Trockenfutter>' }).outcome, 'completed');
});

test('open PM questions show the exact bot question and survive cache reads only for the same attempt', async () => {
  const message = { ts: '123.001', text: '*Korrektur · Baumax*\n:repeat: Fortsetzung: <https://app.clickup.com/t/task|Rüttelplatte>', reactions: [{ name: 'question' }],
    metadata: { event_type: 'ai_korrektur_claim', event_payload: { task_id: 'korrektur-cu-task@123-extern',
      run_id: 'pm-question', worker: 'mac-2', state: 'final', heartbeat: now / 1000 } } };
  const claim = { ...parseClaim(message), channelId: 'correction-channel' };
  const question = 'Gilt „NUR HVP und VP25/50“ auch für VP10/31, VP12/35 und VP16/44?';
  const rows = () => buildQueue([], [claim], DEFAULT_WORKFLOWS, { now });
  let calls = 0;
  const fetcher = async () => { calls++; return response({ ok: true, messages: [
    { ts: message.ts, bot_id: 'worker-bot', text: message.text },
    { ts: '123.002', bot_id: 'worker-bot', text: ':question: Unklar: 1 Punkt braucht eine Antwort.' },
    { ts: '123.003', bot_id: 'worker-bot', text: `*Unklar – bitte hier antworten* (der Bot setzt die Antwort um)\n• Unklar · Kommentar 1 („Dieses Foto zeigt eine RVP-Rüttelplatte…“): ${question}` },
    { ts: '123.004', text: '*Unklar – bitte hier antworten*\n• Unklar · Kommentar 1 („Mensch“): Falsche menschliche Frage?' },
  ] }); };
  const first = await addRunDetails(rows(), { hubFetch: fetcher });
  assert.equal(first[0].status, 'blocked'); assert.equal(first[0].phase, 'PM-Rückfrage offen');
  assert.equal(first[0].blockedReason, question);
  const cached = await addRunDetails(rows(), { hubFetch: fetcher, previousTasks: first });
  assert.equal(calls, 1); assert.equal(cached[0].blockedReason, question); assert.equal(cached[0].phase, 'PM-Rückfrage offen');
  const retry = buildQueue([], [{ ...claim, runId: 'new-attempt', awaitingPm: false }], DEFAULT_WORKFLOWS, { now });
  const next = await addRunDetails(retry, { hubFetch: async () => { throw Error('temporary outage'); }, previousTasks: first });
  assert.equal(next[0].blockedReason, undefined); assert.equal(next[0].phase, 'Korrekturabschluss noch nicht bestätigt');
  const completed = buildQueue([], [{ ...claim, outcome: 'completed', awaitingPm: false }], DEFAULT_WORKFLOWS, { now });
  await addRunDetails(completed, { hubFetch: fetcher, previousTasks: first });
  assert.equal(completed[0].status, 'completed'); assert.equal(completed[0].blockedReason, undefined);
});

test('PM question details redact credentials and do not turn an unrelated thread message into a question', async () => {
  const make = () => ({ id: 'correction:job', workflow: 'correction', status: 'blocked', attemptId: 'one',
    run: { id: 'one', ts: '123.001', channelId: 'correction-channel' } });
  const read = text => addRunDetails([make()], { hubFetch: async () => response({ ok: true, messages: [{ ts: '123.002', bot_id: 'bot', text }] }) });
  const result = await read('*Unklar – bitte hier antworten*\n• Unklar · Kommentar 3 („Module“): token=secret123 Welche Module?');
  assert.equal(result[0].phase, 'PM-Rückfrage offen'); assert.match(result[0].blockedReason, /ENTFERNT/); assert.doesNotMatch(result[0].blockedReason, /secret123/);
  assert.equal((await read('Hinweis: Unklar\n• Unklar · Kommentar 3 („Module“): Fremde Frage?'))[0].blockedReason, undefined);
});

test('tag discovery finds every tag the worker sets', async () => {
  const workerTags = ['pre gen.', 'pre gen · wartet', 'pre gen · läuft', 'pre gen · fertig', 'pre gen · blockiert',
    'klaviyo upload', 'klaviyo upload · wartet', 'klaviyo upload · läuft', 'klaviyo upload · fertig', 'klaviyo upload · blockiert',
    ...['en', 'it', 'fr', 'se', 'sp'].flatMap(lang => [`${lang} translation`, `${lang} translation · fertig`, `${lang} translation · blockiert`])];
  const variants = await discoverTags(async target => new URL(target).pathname.endsWith('/space')
    ? response({ spaces: [{ id: 'one' }] }) : response({ tags: [...workerTags, 'de translation', 'unrelated'].map(name => ({ name })) }),
  '24553341', DEFAULT_WORKFLOWS);
  assert.deepEqual(variants, workerTags);
});

test('legitimate multiline ClickUp display text is flattened and bounded without changing identity', () => {
  const source = task('86cbau0hv', ['pre gen · läuft', '\tCampaign\nQ4', 'x'.repeat(100)]);
  source.name = '  Newsletter\n\tHerbstaktion\u0000  ';
  source.status.status = 'in\narbeit';
  // A live reservation keeps the row although its source status is not pre-gen.
  const live = [parseClaim(claimMessage('running', { task_id: '86cbau0hv' }))];
  const queue = buildQueue([source], live, DEFAULT_WORKFLOWS, { now });
  assert.equal(queue[0].id, 'clickup:newsletter:86cbau0hv');
  assert.equal(queue[0].title, 'Newsletter Herbstaktion');
  assert.equal(queue[0].sourceStatus, 'in arbeit');
  assert.equal(queue[0].status, 'running');
  assert.equal(queue[0].tags[1], 'Campaign Q4'); assert.equal(queue[0].tags[2].length, 80);
  source.name = 'x'.repeat(500); assert.equal(buildQueue([source], live, DEFAULT_WORKFLOWS, { now })[0].title.length, 300);
});

test('queue carries the ClickUp customer and prefers the generated Figma link', () => {
  const original = 'https://www.figma.com/design/original/Newsletter';
  const generated = 'https://www.figma.com/design/generated/Test?node-id=1-2';
  const raw = { ...taskIn('pre-gen', 'customer'), folder: { name: '  Beispiel\n  Unternehmen  ', hidden: false }, custom_fields: [
    { id: '3530f8a4-44e1-4ea5-894d-4d87fb5c418d', name: 'Figma Link', type: 'url', value: original },
    { id: 'ef2ba681-7e9d-40a3-b79a-dda5cd402015', name: 'Figma Pre-Gen', type: 'url', value: generated },
  ] };
  const row = buildQueue([raw], [], DEFAULT_WORKFLOWS, { now })[0];
  assert.equal(row.company, 'Beispiel Unternehmen');
  assert.equal(row.figmaUrl, generated);
  assert.equal(buildQueue([{ ...raw, folder: { name: 'hidden', hidden: true } }], [], DEFAULT_WORKFLOWS, { now })[0].company, undefined);
  assert.equal(buildQueue([taskIn('pre-gen', 'old')], [], DEFAULT_WORKFLOWS, { now })[0].figmaUrl, undefined);
});

test('upload opens its current Figma source while the same task Pre-Gen keeps its generated result', () => {
  const source = 'https://www.figma.com/design/current/Mail?node-id=93-3088';
  const generated = 'https://www.figma.com/design/older/PreGen?node-id=1665-2';
  const raw = { ...taskIn('klaviyo upload', 'moved-mail', ['pre gen · fertig', 'klaviyo upload']), custom_fields: [
    { id: '3530f8a4-44e1-4ea5-894d-4d87fb5c418d', name: 'Figma Link', type: 'url', value: source },
    { id: 'ef2ba681-7e9d-40a3-b79a-dda5cd402015', name: 'Figma Pre-Gen', type: 'url', value: generated },
  ] };
  const rows = buildQueue([raw], [], DEFAULT_WORKFLOWS, { now });
  assert.equal(rows.find(row => row.workflow === 'upload').figmaUrl, source);
  assert.equal(rows.find(row => row.workflow === 'newsletter').figmaUrl, generated);
});

test('Figma fallback uses the configured creation board and optional bad links cannot break the queue', () => {
  const board = 'https://www.figma.com/design/creation';
  const raw = { ...taskIn('klaviyo upload', 'both', ['pre gen · fertig', 'klaviyo upload']), custom_fields: [
    { id: 'ef2ba681-7e9d-40a3-b79a-dda5cd402015', value: 'https://figma.com.evil.example/design/wrong' },
  ] };
  const rows = buildQueue([raw], [], DEFAULT_WORKFLOWS, { now, figmaBoardUrl: board });
  assert.equal(rows.find(row => row.workflow === 'newsletter').figmaUrl, board);
  assert.equal(rows.find(row => row.workflow === 'upload').figmaUrl, undefined);
  const valid = 'https://figma.com/file/source/Board';
  raw.custom_fields.push({ name: 'Figma Board', type: 'url', value: valid });
  assert.ok(buildQueue([raw], [], DEFAULT_WORKFLOWS, { now, figmaBoardUrl: board }).every(row => row.figmaUrl === valid));
  for (const value of ['javascript:alert(1)', 'https://user:pass@figma.com/design/key', 'http://figma.com/file/key', 'https://figma.com/login']) {
    const row = buildQueue([{ ...taskIn('pre-gen', 'unsafe'), custom_fields: [{ name: 'Figma Link', type: 'url', value }] }], [], DEFAULT_WORKFLOWS, { now })[0];
    assert.equal(row.figmaUrl, undefined);
  }
});

test('custom workflows require valid unique IDs and recognized statuses', () => {
  assert.deepEqual(validateWorkflows([{ id: 'correction', triggerTags: ['correction'], stateTags: { running: ['correction · läuft'] } }])[0].id, 'correction');
  assert.throws(() => validateWorkflows([{ id: 'bad', triggerTags: [''], stateTags: {} }]), /Tag ungültig/);
  assert.throws(() => validateWorkflows([{ id: 'bad', triggerTags: ['ok'], stateTags: { unknown: ['x'] } }]), /Status-Tags/);
  assert.throws(() => validateWorkflows([...DEFAULT_WORKFLOWS, DEFAULT_WORKFLOWS[0]]), /eindeutig/);
});

test('Hub observations contain no usage or battery values and reject invalid identity/timestamp', () => {
  const rows = parseObservedWorkers([
    { worker_id: 'mac-1', seen_at: '2026-10-07T11:59:00Z', worker_version: 'V1.15', worker_revision: 'a'.repeat(40), pending_clickup: 2, private_key: 'never-return' },
    { worker_id: '../unsafe', seen_at: '2026-10-07T11:59:00Z' }, { worker_id: 'mac-2', seen_at: 'bad' },
  ]);
  assert.equal(rows.length, 1); assert.equal(rows[0].workerId, 'mac-1');
  assert.equal(rows[0].pendingClickup, 2); assert.equal(rows[0].private_key, undefined);
  assert.equal(rows[0].limits, undefined); assert.equal(rows[0].batteryPercent, undefined);
});

test('fleet reader uses verified SSH hosts and a fixed read-only stdin program', async () => {
  let captured;
  const rows = await readHubFleet({ ssh_host: 'root@example.test', identity_file: '~/.ssh/test', known_hosts_file: '/tmp/fleet known', hub_dir: '/opt/rs-hub' }, {
    spawnImpl: (command, args) => {
      captured = { command, args }; const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
      let program = ''; child.stdin.on('data', value => { program += value; });
      child.stdin.on('finish', () => {
        assert.match(program, /fs\.readdirSync/); assert.doesNotMatch(program, /writeFile|mkdir|renameSync|team-secrets/);
        child.stdout.write(JSON.stringify([{ worker_id: 'mac-1', seen_at: '2026-10-07T11:59:00Z' }])); child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(rows.length, 1); assert.equal(captured.command, 'ssh');
  assert.ok(captured.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(captured.args.includes('UserKnownHostsFile="/tmp/fleet known"'));
  await assert.rejects(() => readHubFleet({ ssh_host: 'root@example.test; unsafe', hub_dir: '/opt/rs-hub' }), /Konfiguration/);
});

test('a source failure posts only an error and never clears accepted queue/cache', async () => {
  const posted = []; let saves = 0;
  const result = await syncOnce({ collect: async () => { throw new Error('ClickUp: HTTP 503.'); },
    publish: async value => posted.push(value), cachedSource: { lastSuccessAt: '2026-10-07T11:00:00Z' }, save: async () => { saves += 1; } });
  assert.equal(result.ok, false); assert.equal(saves, 0); assert.equal(posted.length, 1);
  assert.equal('tasks' in posted[0], false); assert.equal(posted[0].source.lastSuccessAt, '2026-10-07T11:00:00Z');
  assert.match(posted[0].source.error, /503/);
});

test('a genuine complete empty queue is published and cached only after relay acceptance', async () => {
  const events = []; const snapshot = { tasks: [], source: { name: 'ClickUp', lastSuccessAt: '2026-10-07T12:00:00Z' } };
  const result = await syncOnce({ collect: async () => snapshot, publish: async () => events.push('publish'), save: async () => events.push('save') });
  assert.equal(result.ok, true); assert.deepEqual(events, ['publish', 'save']);
  await assert.rejects(() => syncOnce({ collect: async () => snapshot, publish: async () => { throw new Error('relay unavailable'); }, save: async () => events.push('bad') }), /relay unavailable/);
  assert.deepEqual(events, ['publish', 'save']);
});

test('missing Hub observations do not discard a verified ClickUp/Slack snapshot', async () => {
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: '24553341' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => String(target).includes('slack.com') ? response({ ok: true, messages: [], has_more: false }) : response({ spaces: [], tasks: [] }),
    fleetReader: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(snapshot.tasks, []); assert.equal(snapshot.observedWorkers, undefined);
  assert.match(snapshot.source.detail, /Worker-Dateien nicht verfügbar/); assert.equal(snapshot.source.error, undefined);
});

test('an unavailable PM journal preserves the last complete snapshot instead of clearing clarification', async () => {
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => String(target).includes('slack.com') ? response({ ok: true, messages: [], has_more: false }) : response({ spaces: [], tasks: [] }),
    fleetReader: async () => [], questionReader: async () => { throw new Error('PM-Journal nicht erreichbar'); } });
  assert.equal(snapshot.tasks, undefined);assert.match(snapshot.source.error,/PM-Journal/);
});

test('minute cadence includes request time, never overlaps, and recovers after an overrun', async () => {
  const controller = new AbortController();
  let clock = 0;
  let active = false;
  const starts = []; const waits = [];
  const duration = [22000, 76000, 5000];
  await runSyncLoop(async () => {
    assert.equal(active, false); active = true;
    starts.push(clock); clock += duration[starts.length - 1];
    active = false;
    if (starts.length === 3) controller.abort();
  }, { intervalMs: 60000, signal: controller.signal, now: () => clock,
    pause: async ms => { waits.push(ms); clock += ms; } });
  assert.deepEqual(starts, [0, 60000, 136000]);
  assert.deepEqual(waits, [38000, 0]);
  let calls = 0;
  await runSyncLoop(async () => { calls++; }, { intervalMs: 60000, signal: new AbortController().signal, once: true,
    pause: async () => { throw new Error('one-off sync must not sleep'); } });
  assert.equal(calls, 1);
});

test('sources are read concurrently and a real claim assigns the exact worker ID', { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let claimStarted = false;
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => {
      const url = new URL(target);
      if (url.hostname === 'slack.com') {
        claimStarted = true; release();
        return response({ ok: true, messages: [claimMessage('running', { worker: 'exact-worker-id' })], has_more: false });
      }
      if (url.pathname.endsWith('/space')) { await gate; assert.equal(claimStarted, true); return response({ spaces: [{ id: 'space' }] }); }
      if (url.pathname.endsWith('/tag')) return response({ tags: [{ name: 'pre gen.' }] });
      return response({ tasks: [task('a')], last_page: true });
    }, fleetReader: async () => [] });
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, 'clickup:newsletter:a');
  assert.equal(snapshot.tasks[0].workerId, 'exact-worker-id');
  assert.equal(snapshot.tasks[0].status, 'running');
});

test('relay publishing requires TLS, keeps token in header and rejects redirects', async () => {
  assert.throws(() => relayEndpoint('http://external.test', 'DEMO1234'), /HTTPS/);
  assert.throws(() => relayEndpoint('https://user:pass@example.test', 'DEMO1234'), /HTTPS/);
  assert.equal(relayEndpoint('http://127.0.0.1:8080', 'DEMO1234').pathname, '/v1/teams/DEMO1234/queue');
  await publishSnapshot({ tasks: [] }, { relayUrl: 'https://example.test', teamId: 'DEMO1234', token: 'test-token', fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token'); assert.equal(options.redirect, 'error');
    assert.doesNotMatch(String(url), /test-token/); return { ok: true, status: 200 };
  } });
});

test('installer generates a valid launchd template without including a supplied token or loading a service', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-installer-test-'));
  try {
    const workerRoot = path.join(directory, 'worker fixture');
    await fs.mkdir(path.join(workerRoot, 'src'), { recursive: true }); await fs.mkdir(path.join(workerRoot, 'config'));
    await fs.writeFile(path.join(workerRoot, 'src/config.js'), 'module.exports = { loadConfig() { return {}; } };');
    await fs.writeFile(path.join(workerRoot, 'src/hub-transport.js'), 'module.exports = {};');
    await fs.writeFile(path.join(workerRoot, 'config/worker.local.json'), '{}');
    const output = path.join(directory, 'generated'); const secret = 'installer-test-secret-never-write';
    execFileSync('/bin/bash', [path.resolve('scripts/install-newsletter-monitor.sh'), '--generate-only', '--output-dir', output], {
      env: { ...process.env, NEWSLETTER_WORKER_ROOT: workerRoot, MONITOR_TEAM_ID: 'DEMO1234',
        MONITOR_RELAY_URL: 'https://monitor.example.test', MONITOR_NODE_PATH: process.execPath, MONITOR_BRIDGE_TOKEN: secret,
        MONITOR_BRIDGE_INTERVAL_SECONDS: '60', MONITOR_WORKFLOWS_FILE: '', MONITOR_HUB_FLEET_DIRECTORY: '', MONITOR_BRIDGE_CACHE: '' },
      encoding: 'utf8',
    });
    const plistFile = path.join(output, 'de.max-monitor.newsletter-bridge.DEMO1234.plist');
    const plist = await fs.readFile(plistFile, 'utf8'); const runner = await fs.readFile(path.join(output, 'service/run.sh'), 'utf8');
    assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/); assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.doesNotMatch(plist + runner, new RegExp(secret)); assert.doesNotMatch(plist, /MONITOR_BRIDGE_TOKEN/);
    assert.match(runner, /security find-generic-password -w/); assert.match(runner, /--once/);
    execFileSync('/bin/bash', ['-n', path.join(output, 'service/run.sh')]);
    if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', plistFile]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

const issueMessage = (overrides = {}) => ({ ts: '1791374000.001', text: ':red_circle: Mac `mac-1` holt keine Aufgaben\n```Failed to authenticate: OAuth session expired```\nAbhilfe: private path',
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind: 'system', worker: 'mac-1', stage: 'claude' } }, ...overrides });

test('worker diagnostics include auth and arbitrary system/update failures without tasks or secrets', () => {
  const issue = parseWorkerIssue(issueMessage());
  assert.equal(issue.workerId, 'mac-1');
  assert.equal(issue.severity, 'error');
  assert.match(issue.message, /OAuth session expired/);
  assert.doesNotMatch(JSON.stringify(issue), /private path/);
  for (const stage of ['clickup_list', 'finalize', 'slack', 'claude']) {
    const message = issueMessage({ text: 'Systemfehler\n```HTTP 503\nBearer sensitive-value token=another-secret```' });
    message.metadata.event_payload.stage = stage;
    const parsed = parseWorkerIssue(message);
    assert.equal(parsed.stage, stage);
    assert.doesNotMatch(parsed.message, /sensitive-value|another-secret|\n/);
  }
  const warning = issueMessage({ text: ':hourglass: Der Claude-Token läuft in 12 Tagen ab' });
  assert.equal(parseWorkerIssue(warning).severity, 'warning');
  warning.text = ':hourglass: Der Claude-Token ist abgelaufen';
  assert.equal(parseWorkerIssue(warning).severity, 'error');
  const update = issueMessage(); update.metadata.event_payload = { kind: 'update', worker: 'mac-1', tool: 'rs-hub-mcp' };
  assert.equal(parseWorkerIssue(update).stage, 'rs-hub-mcp');
  const run = issueMessage(); run.metadata.event_payload.kind = 'lauf';
  assert.equal(parseWorkerIssue(run), null);
  assert.equal(parseWorkerIssue({ ...issueMessage(), ts: 'Infinity' }), null);
  const legacy = { ts: '1791374000.001', bot_id: 'B1', text: ':warning: AI-Newsletter-Worker auf Mac `mac-1`: technischer Fehler bei clickup_list (Error). Lokales Log prüfen.' };
  assert.equal(parseWorkerIssue(legacy).stage, 'clickup_list');
  assert.equal(parseWorkerIssue({ ...legacy, bot_id: undefined }), null);
});

test('complete Slack warning scans clear resolved issues; partial scans preserve them', async () => {
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, fehler: { enabled: true, channel_id: 'errors' }, hub: {} };
  let messages = [issueMessage()]; let failErrors = false; let failTasks = false;
  const collect = () => collectSnapshot({ config, now, fleetReader: async () => [], hubFetch: async target => {
    const url = new URL(target);
    if (url.hostname !== 'slack.com') {
      if (failTasks) throw new Error('ClickUp unavailable');
      return response({ spaces: [], tasks: [] });
    }
    if (url.searchParams.get('channel') === 'errors') {
      if (failErrors) return response({ ok: true, messages, has_more: true });
      return response({ ok: true, messages, has_more: false });
    }
    return response({ ok: true, messages: [], has_more: false });
  } });
  assert.equal((await collect()).workerIssues.length, 1);
  failTasks = true;
  const partial = await collect();
  assert.equal(partial.workerIssues.length, 1);
  assert.match(partial.source.error, /ClickUp unavailable/);
  assert.equal(Object.hasOwn(partial, 'tasks'), false);
  let saved = false;
  assert.equal((await syncOnce({ collect: async () => partial, publish: async () => {}, save: async () => { saved = true; } })).ok, false);
  assert.equal(saved, false);
  failTasks = false; failErrors = true;
  assert.equal(Object.hasOwn(await collect(), 'workerIssues'), false);
  failErrors = false; messages = [];
  assert.deepEqual((await collect()).workerIssues, []);
});

test('the next warm-cache snapshot removes deleted worker errors while preserving current errors', async () => {
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' },
    fehler: { enabled: true, channel_id: 'errors' }, hub: {} };
  const resolved = issueMessage();
  const active = issueMessage({ ts: '1791374100.001', metadata: { event_type: 'ai_newsletter_fehler',
    event_payload: { kind: 'update', worker: 'mac-2', sha: 'a'.repeat(40) } } });
  let messages = [resolved, active];
  const errorReads = [];
  const claimReader = createClaimReader();
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.hostname !== 'slack.com') return response({ spaces: [], tasks: [] });
    if (url.searchParams.get('channel') !== 'errors') return response({ ok: true, messages: [], has_more: false });
    const oldest = url.searchParams.get('oldest');
    errorReads.push(oldest);
    return response({ ok: true, messages: messages.filter(message => !oldest || Number(message.ts) > Number(oldest)), has_more: false });
  };
  const collect = at => collectSnapshot({ config, now: at, fleetReader: async () => [], hubFetch, claimReader });
  assert.equal((await collect(now)).workerIssues.length, 2);
  messages = [active];
  const second = await collect(now + 60000);
  assert.deepEqual(second.workerIssues.map(issue => issue.workerId), ['mac-2']);
  assert.equal(second.blockedErrors.length, 1, 'the error inventory agrees with the worker status');
  messages = [];
  const third = await collect(now + 120000);
  assert.deepEqual(third.workerIssues, []);
  assert.deepEqual(third.blockedErrors, []);
  assert.deepEqual(errorReads, [null, null, null], 'each cycle confirms the complete current inventory');
});

test('a newer token-expiry warning cannot hide an existing Claude outage', async () => {
  const warning = issueMessage({ ts: '1791374100.001', text: ':hourglass: Der Claude-Token läuft in 12 Tagen ab' });
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => String(target).includes('slack.com')
      ? response({ ok: true, messages: [warning, issueMessage()], has_more: false }) : response({ spaces: [], tasks: [] }), fleetReader: async () => [] });
  assert.equal(snapshot.workerIssues.length, 2);
  assert.ok(snapshot.workerIssues.some(issue => issue.severity === 'error' && /OAuth/.test(issue.message)));
});

test('the worker status reply becomes live progress, final and foreign texts do not', () => {
  assert.deepEqual(parseRunStatus(':hourglass_flowing_sand: 50 % · Bau der Mail\n_Stand 17:31 · wird alle 5 min aktualisiert_'), { percent: 50, step: 'Bau der Mail' });
  assert.deepEqual(parseRunStatus('⏳ 32 % · Konzept: kreative Richtung &amp; Bauplan\n_Stand 17:29_'), { percent: 32, step: 'Konzept: kreative Richtung & Bauplan' });
  assert.deepEqual(parseRunStatus('⏸️ 70 % · Prüfung (Art Director) · pausiert: Internet weg\n_Stand 17:40_'), { percent: 70, step: 'Prüfung (Art Director) · pausiert: Internet weg' });
  assert.deepEqual(parseRunStatus(':double_vertical_bar: 85 % · Figma-Export · pausiert: Claude-API weg'), { percent: 85, step: 'Figma-Export · pausiert: Claude-API weg' });
  for (const text of [':white_check_mark: 100 % · fertig · 6 Slices', '*Für PM / Kunde*\n• Briefing', ':hourglass: 101 % · zu viel', '', undefined]) assert.equal(parseRunStatus(text), null);
});

const statusReply = (text, overrides = {}) => ({ ts: '1791373500.002', thread_ts: '1791373200.001', bot_id: 'B1', text, ...overrides });
const runningSource = ({ replies = () => [statusReply(':hourglass_flowing_sand: 50 % · Bau der Mail\n_Stand_')], claims = [claimMessage()], tasks = [task('a', ['pre gen · läuft'])] } = {}) => {
  const calls = [];
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.pathname.endsWith('conversations.replies')) {
      calls.push(url.searchParams.get('ts'));
      const messages = replies(url);
      return messages instanceof Error ? (() => { throw messages; })() : response({ ok: true, messages: [{ ts: url.searchParams.get('ts') }, ...messages] });
    }
    if (url.hostname === 'slack.com') return response({ ok: true, messages: claims, has_more: false });
    if (url.pathname.endsWith('/space')) return response({ spaces: [{ id: 'space' }] });
    if (url.pathname.endsWith('/tag')) return response({ tags: [{ name: 'pre gen.' }, { name: 'pre gen · läuft' }, { name: 'pre gen · fertig' }] });
    return response({ tasks, last_page: true });
  };
  return { calls, hubFetch, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, hub: {} } };
};

test('a running task shows the worker step and percent from its claim thread without new log phases', async () => {
  const source = runningSource();
  const snapshot = await collectSnapshot({ now, ...source, fleetReader: async () => [] });
  const row = snapshot.tasks[0];
  assert.deepEqual([row.status, row.phase, row.progress, row.step], ['running', 'In Bearbeitung', 50, 'Bau der Mail']);
  assert.deepEqual(source.calls, ['1791373200.001']);
  assert.equal(Object.hasOwn(row, 'run'), false);

  // A human reply or a failed thread read never invents progress or fails the queue.
  for (const replies of [() => [statusReply('⏳ 90 % · Fake', { bot_id: undefined })], () => new Error('rate limited')]) {
    const quiet = await collectSnapshot({ now, ...runningSource({ replies }), fleetReader: async () => [] });
    assert.deepEqual([quiet.tasks[0].status, quiet.tasks[0].progress, quiet.tasks[0].step], ['running', undefined, undefined]);
    assert.equal(quiet.source.error, undefined);
  }
  // Only running tasks are read: a stale claim is blocked and costs no Slack request.
  const stale = runningSource({ claims: [claimMessage('running', { heartbeat: now / 1000 - 3600 })] });
  assert.equal((await collectSnapshot({ now, ...stale, fleetReader: async () => [] })).tasks[0].status, 'blocked');
  assert.deepEqual(stale.calls, []);
});

async function renderDatabase() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, external_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE deliverables (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, message_id TEXT NOT NULL, version INTEGER NOT NULL,
      content TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  message.run('m1', 'tisso', 'clickup:a:mail-1', 'TISSO Reise – Mail 01', '2026-10-07T10:00:00Z');
  message.run('m2', 'tisso', 'clickup:a:mail-2', 'TISSO Reise – Mail 02', '2026-10-07T10:00:05Z');
  message.run('m3', 'tisso', 'clickup:ab:master', 'Andere Aufgabe', '2026-10-07T10:00:06Z');
  let version = 0;
  const deliverable = (messageId, created, { run = 'run-1', render = `${'1'.repeat(8)}-1111-4111-8111-${String(version + 1).padStart(12, '0')}.png`, sha = `sha-${version + 1}` } = {}) =>
    db.prepare('INSERT INTO deliverables VALUES (?, ?, ?, ?, ?, ?, ?)').run(`d${++version}`, 'tisso', messageId, version,
      JSON.stringify({ subject: `Betreff ${messageId}`, html: '<p>x</p>', ...(render ? { render: { id: render, sha256: sha } } : {}) }),
      JSON.stringify({ attemptId: run }), created);
  deliverable('m1', '2026-10-07T11:00:00Z', { render: null });
  deliverable('m1', '2026-10-07T11:00:04Z');
  deliverable('m1', '2026-10-07T11:20:00Z', { render: null });
  deliverable('m1', '2026-10-07T11:20:04Z');
  deliverable('m2', '2026-10-07T11:10:00Z');
  deliverable('m1', '2026-10-07T09:00:00Z', { run: 'old-run' });
  deliverable('m3', '2026-10-07T11:30:00Z');
  return db;
}

test('RS Hub renders of the current attempt are found per mail, newest first render counted', async () => {
  const db = await renderDatabase();
  const renders = readRenders(db, [{ taskId: 'a', runId: 'run-1' }, { taskId: 'missing', runId: 'run-9' }]);
  assert.deepEqual([...renders.keys()], ['run-1']);
  assert.deepEqual(renders.get('run-1').map(mail => [mail.title, mail.render, mail.sha256, mail.renderedAt, mail.subject]), [
    ['TISSO Reise – Mail 01', 2, 'sha-4', '2026-10-07T11:20:04Z', 'Betreff m1'],
    ['TISSO Reise – Mail 02', 1, 'sha-5', '2026-10-07T11:10:00Z', 'Betreff m2'],
  ]);
  assert.equal(readRenders(db, [{ taskId: 'a', runId: 'old-run' }]).get('old-run').length, 1);
});

test('each new render is resized and uploaded once; a failed upload keeps the previous picture', async () => {
  const db = await renderDatabase();
  const uploads = []; const reads = []; let failUpload = false;
  const previews = createRenderPreviews({ localHub: '/opt/rs-hub', openDatabase: () => ({ prepare: sql => db.prepare(sql), close() {} }),
    readFile: async file => { reads.push(file); return Buffer.from(file); },
    resize: async buffer => ({ data: Buffer.concat([Buffer.from('jpeg:'), buffer]), width: 600, height: 4000 }),
    upload: async (id, data) => { if (failUpload) throw new Error('relay down'); uploads.push([id, data.length]); } });
  const first = (await previews([{ taskId: 'a', runId: 'run-1' }])).get('run-1');
  assert.equal(first.length, 2);
  assert.match(first[0].id, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first[0]).sort(), ['height', 'id', 'render', 'renderedAt', 'subject', 'title', 'width']);
  assert.equal(reads[0], '/opt/rs-hub/data/customer-intelligence/assets/tisso/11111111-1111-4111-8111-000000000004.png');
  assert.equal(uploads.length, 2);
  await previews([{ taskId: 'a', runId: 'run-1' }]);
  assert.equal(uploads.length, 2);

  db.prepare('INSERT INTO deliverables VALUES (?, ?, ?, ?, ?, ?, ?)').run('d99', 'tisso', 'm1', 99,
    JSON.stringify({ subject: 'Neu', render: { id: '11111111-1111-4111-8111-000000000099.png', sha256: 'sha-99' } }), JSON.stringify({ attemptId: 'run-1' }), '2026-10-07T11:40:00Z');
  failUpload = true;
  const kept = (await previews([{ taskId: 'a', runId: 'run-1' }])).get('run-1');
  assert.deepEqual(kept.map(mail => mail.id), first.map(mail => mail.id));
  failUpload = false;
  const updated = (await previews([{ taskId: 'a', runId: 'run-1' }])).get('run-1');
  assert.notEqual(updated[0].id, first[0].id);
  assert.deepEqual([updated[0].render, updated[0].subject], [3, 'Neu']);
  assert.equal(uploads.length, 3);

  // Paths come from the Hub database; anything unexpected is never read.
  db.prepare('INSERT INTO deliverables VALUES (?, ?, ?, ?, ?, ?, ?)').run('d100', 'tisso', 'm2', 100,
    JSON.stringify({ render: { id: '../../../etc/passwd', sha256: 'sha-100' } }), JSON.stringify({ attemptId: 'run-1' }), '2026-10-07T11:50:00Z');
  reads.length = 0;
  await previews([{ taskId: 'a', runId: 'run-1' }]);
  assert.deepEqual(reads, []);
});

test('pictures follow the attempt, stay after completion and are never backfilled for old tasks', async () => {
  const picture = (renderedAt = '2026-10-07T11:20:04Z') => ({ id: 'f'.repeat(64), title: 'Mail', renderedAt, render: 1, width: 600, height: 4000 });
  const asked = [];
  const previews = async attempts => { asked.push(...attempts.map(item => item.runId)); return new Map([['run-1', [picture()]]]); };
  const collect = (tags, claims, previousTasks) => collectSnapshot({ now, ...runningSource({ tasks: [task('a', tags)], claims }), fleetReader: async () => [], previews, previousTasks });

  const running = await collect(['pre gen · läuft'], [claimMessage()]);
  assert.deepEqual(running.tasks[0].previews, [picture()]);
  assert.deepEqual(asked, ['run-1']);

  const done = [claimMessage('final')];
  asked.length = 0;
  const finished = await collect(['pre gen · fertig'], done, running.tasks);
  assert.deepEqual([finished.tasks[0].status, finished.tasks[0].previews], ['completed', [picture()]]);
  assert.deepEqual(asked, ['run-1']);

  asked.length = 0;
  const kept = await collect(['pre gen · fertig'], done, finished.tasks);
  assert.deepEqual([kept.tasks[0].previews, asked], [[picture()], []]);
  const expired = await collect(['pre gen · fertig'], done, [{ ...finished.tasks[0], previews: [picture('2026-09-29T11:00:00Z')] }]);
  assert.equal(expired.tasks[0].previews, undefined);
  assert.equal((await collect(['pre gen · fertig'], done)).tasks[0].previews, undefined);
  assert.deepEqual(asked, []);

  // A broken Hub read keeps the last pictures instead of failing the queue.
  const failing = await collectSnapshot({ now, ...runningSource(), fleetReader: async () => [], previousTasks: running.tasks, previews: async () => { throw new Error('database locked'); } });
  assert.deepEqual([failing.source.error, failing.tasks[0].previews], [undefined, [picture()]]);
});

test('preview uploads go to the relay with the token in the header only', async () => {
  const calls = [];
  await uploadPreview('a'.repeat(64), Buffer.from('jpeg'), { relayUrl: 'https://api.example.test/max-monitor', teamId: 'DEMO1234', token: 'secret',
    fetchImpl: async (url, options) => { calls.push([String(url), options]); return { ok: true }; } });
  assert.equal(calls[0][0], `https://api.example.test/max-monitor/v1/teams/DEMO1234/fleet/previews/${'a'.repeat(64)}`);
  assert.deepEqual([calls[0][1].method, calls[0][1].redirect, calls[0][1].headers.Authorization, calls[0][1].headers['Content-Type']], ['PUT', 'error', 'Bearer secret', 'image/jpeg']);
  await assert.rejects(uploadPreview('a'.repeat(64), Buffer.from('jpeg'), { relayUrl: 'https://api.example.test', teamId: 'DEMO1234', token: 'secret', fetchImpl: async () => ({ ok: false, status: 413 }) }), /413/);
});

// INF-05: the bridge shares the Tuck Slack token with every worker Mac.
const limitedReply = () => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'ratelimited' }) });
const fehler = (ts, job = 'abc@1') => ({ ts, text: '*Newsletter Creation · Kunde*\n:warning: Technisch blockiert',
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind: 'lauf', worker: 'mac-1', task_id: job, run_id: `run-${job}` } } });

test('Slack history pages request 999 messages like the worker', async () => {
  const limits = [];
  await listClaims(async target => { limits.push(new URL(target).searchParams.get('limit')); return response({ ok: true, messages: [], has_more: false }); }, 'C0C6NMMGGJV', { now });
  assert.deepEqual(limits, ['999']);
});

test('claim channels are read at most every 180 s; #ai-fehler reads only newer messages and rescans every 30 min', async () => {
  const reader = createClaimReader();
  const requests = [];
  let errors = [fehler('1791373200.000100')];
  const fetcher = async target => {
    const url = new URL(target); requests.push(url);
    if (url.searchParams.get('channel') !== 'errors') return response({ ok: true, messages: [claimMessage()], has_more: false });
    const oldest = url.searchParams.get('oldest');
    return response({ ok: true, messages: errors.filter(message => !oldest || Number(message.ts) > Number(oldest)), has_more: false });
  };
  const cycle = async at => {
    const seen = [];
    const claims = await reader(fetcher, 'status', { now: at, lookbackDays: 60 });
    await reader(fetcher, 'errors', { now: at, lookbackDays: null, incremental: true, onMessage: message => seen.push(message.ts) });
    return { claims, seen: seen.sort(), status: requests.filter(url => url.searchParams.get('channel') === 'status').length,
      oldest: requests.filter(url => url.searchParams.get('channel') === 'errors').at(-1).searchParams.get('oldest') };
  };
  const first = await cycle(now);
  assert.deepEqual([first.status, first.oldest, first.seen, first.claims.length], [1, null, ['1791373200.000100'], 1]);
  const second = await cycle(now + 170000);
  assert.equal(second.status, 1, 'a second cycle within 180 s reads no claim channel');
  assert.equal(second.claims.length, 1);
  assert.deepEqual([second.oldest, second.seen], ['1791373200.000100', ['1791373200.000100']]);
  errors = [fehler('1791373260.000200', 'def@2'), ...errors];
  const third = await cycle(now + 180000);
  assert.equal(third.status, 2, 'claim channels are read again after 180 s');
  assert.deepEqual([third.oldest, third.seen], ['1791373200.000100', ['1791373200.000100', '1791373260.000200']]);
  assert.equal((await cycle(now + 240000)).oldest, '1791373260.000200');
  // A copy deleted in Slack disappears with the next complete scan after 30 min.
  errors = errors.filter(message => message.ts !== '1791373200.000100');
  assert.deepEqual((await cycle(now + 1700000)).seen, ['1791373200.000100', '1791373260.000200']);
  const rescan = await cycle(now + 1800000);
  assert.deepEqual([rescan.oldest, rescan.seen], [null, ['1791373260.000200']]);
  // The cleanup's invalidate still forces a complete scan.
  await cycle(now + 1860000);
  reader.invalidate('errors');
  assert.equal((await cycle(now + 1920000)).oldest, null);
});

test('a 429 on one channel with a cache under 10 min keeps the snapshot; a stale cache never deletes', async () => {
  const reader = createClaimReader();
  let limited = false;
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { claims: ['flows'], errors: 'errors' }, hub: {} };
  const collect = at => syncOnce({ publish: async () => {}, collect: () => collectSnapshot({ config, now: at, claimReader: reader, fleetReader: async () => [],
    hubFetch: async target => {
      const url = new URL(target);
      if (url.hostname !== 'slack.com') return response(url.pathname.endsWith('/space') ? { spaces: [{ id: 'space' }] } : url.pathname.endsWith('/tag') ? { tags: [{ name: 'pre gen.' }] } : { tasks: [task('a')], last_page: true });
      const channel = url.searchParams.get('channel');
      if (limited && channel === 'flows') return limitedReply();
      return response({ ok: true, messages: channel === 'status' ? [claimMessage()] : channel === 'errors' ? [fehler('1791373200.000100')] : [], has_more: false });
    } }) });
  const before = { ...reader.stats };
  const first = await collect(now);
  assert.equal(first.ok, true);
  assert.equal(freshClaimCycle(before, reader.stats), true);
  limited = true;
  const cachedStats = { ...reader.stats };
  const cached = await collect(now + 200000);
  assert.equal(cached.ok, true, 'a 429 with a fresh cache still gives result.ok');
  assert.equal(cached.snapshot.tasks[0].status, 'running');
  assert.equal(cached.snapshot.blockedErrors.length, 1);
  assert.equal(reader.stats.fallback, 1);
  assert.equal(freshClaimCycle(cachedStats, reader.stats), false, 'error-copy cleanup waits for a fully fresh cycle');
  const recoveryStats = { ...reader.stats };
  limited = false;
  await collect(now + 260000);
  assert.equal(freshClaimCycle(recoveryStats, reader.stats), true, 'the stale channel makes the next cycle read all claim channels');
  const ttlStats = { ...reader.stats };
  await collect(now + 320000);
  assert.equal(freshClaimCycle(ttlStats, reader.stats), false, 'a cycle served from the 180 s cache never deletes either');
  limited = true;
  // 'flows' was last read completely at +260 s; ten minutes later the 429 counts again.
  const expired = await collect(now + 260000 + 600000);
  assert.equal(expired.ok, false);
  assert.match(expired.snapshot.source.error, /HTTP 429/);
});

test('one 429 or transport error on a claim channel never splits the channels into cycles without cleanup', async () => {
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, monitor_channels: { claims: ['flows', 'extra'], errors: 'errors' }, hub: {} };
  const run = async ({ failure, failAt }) => {
    const reader = createClaimReader();
    const reads = [], fresh = [], perCycle = [];
    let failing = false;
    const hubFetch = async target => {
      const url = new URL(target);
      if (url.hostname !== 'slack.com') return response(url.pathname.endsWith('/space') ? { spaces: [{ id: 'space' }] } : url.pathname.endsWith('/tag') ? { tags: [{ name: 'pre gen.' }] } : { tasks: [task('a')], last_page: true });
      const channel = url.searchParams.get('channel');
      if (!url.pathname.endsWith('/conversations.history')) return response({ ok: true, messages: [] });
      if (channel !== 'errors') reads.push(channel);
      if (failing && channel === 'flows') return failure === 429 ? limitedReply() : { ok: false, status: 500, json: async () => ({}) };
      return response({ ok: true, messages: channel === 'status' ? [claimMessage()] : [], has_more: false });
    };
    // Every 60 s plus a few ms of drift, like the live loop.
    for (let cycle = 0; cycle < 20; cycle += 1) {
      failing = failAt.includes(cycle);
      const before = { ...reader.stats }, count = reads.length;
      const result = await syncOnce({ publish: async () => {}, collect: () => collectSnapshot({ config, now: now + cycle * 60007,
        claimReader: reader, fleetReader: async () => [], hubFetch }) });
      perCycle.push(reads.length - count);
      if (result.ok && freshClaimCycle(before, reader.stats)) fresh.push(cycle);
    }
    return { fresh, perCycle };
  };
  const baseline = await run({ failure: 429, failAt: [] });
  assert.deepEqual(baseline.fresh, [0, 3, 6, 9, 12, 15, 18]);
  assert.deepEqual(baseline.perCycle, [3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0]);
  // A 429 served from the fallback marks the channel stale: the next cycle reads all claim channels.
  const limited = await run({ failure: 429, failAt: [3] });
  assert.deepEqual(limited.fresh, [0, 4, 7, 10, 13, 16, 19], 'cleanup recurs right after a single 429');
  assert.deepEqual(limited.perCycle, [3, 0, 0, 3, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3]);
  // A transport error stops the sequential loop: 'extra' stays unread, and the next cycle reads all channels.
  const broken = await run({ failure: 500, failAt: [3] });
  assert.deepEqual(broken.fresh, [0, 4, 7, 10, 13, 16, 19], 'cleanup recurs right after a transport error');
  assert.deepEqual(broken.perCycle, [3, 0, 0, 2, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0, 3]);
  // A repeated 429 stops forcing in that cycle: 'extra' (read 60 s earlier) comes from the cache.
  const repeated = await run({ failure: 429, failAt: [3, 4] });
  assert.deepEqual(repeated.fresh, [0, 5, 8, 11, 14, 17]);
  assert.deepEqual(repeated.perCycle.slice(3, 6), [3, 2, 3]);
});

test('run status replies are re-read only for a new heartbeat or after 5 min, and the first 429 stops the cycle', async () => {
  const cache = new Map();
  const calls = [];
  let limited = false;
  const fetcher = async target => {
    const url = new URL(target); const ts = url.searchParams.get('ts'); calls.push(ts);
    if (limited) return limitedReply();
    return response({ ok: true, messages: [{ ts }, statusReply(`⏳ ${calls.length} % · Schritt ${ts}`, { thread_ts: ts })] });
  };
  const read = (threads, at) => readRunStatuses(fetcher, 'status', threads, { cache, now: at, concurrency: 1 });
  const threads = [{ ts: '1.1', heartbeat: 100 }, { ts: '2.1', heartbeat: 100 }];
  assert.equal((await read(threads, now)).size, 2); assert.equal(calls.length, 2);
  const cached = await read(threads, now + 60000);
  assert.equal(calls.length, 2); assert.equal(cached.get('1.1').step, 'Schritt 1.1');
  await read([{ ts: '1.1', heartbeat: 200 }, threads[1]], now + 120000);
  assert.deepEqual(calls.slice(2), ['1.1'], 'only the thread with a new heartbeat is read');
  await read([{ ts: '1.1', heartbeat: 200 }, threads[1]], now + 300000);
  assert.deepEqual(calls.slice(3), ['2.1'], 'a status older than 5 min is read again');
  limited = true;
  const shown = await read([{ ts: '1.1', heartbeat: 300 }, { ts: '2.1', heartbeat: 300 }, { ts: '3.1', heartbeat: 300 }], now + 360000);
  assert.deepEqual(calls.slice(4), ['1.1'], 'no further reads after the first 429');
  assert.deepEqual([...shown.keys()].sort(), ['1.1', '2.1'], 'the last known status stays on display');
});

test('a snapshot cycle reuses the cached run status while the claim heartbeat is unchanged', async () => {
  const source = runningSource();
  const statusCache = new Map();
  for (const at of [now, now + 60000]) {
    const snapshot = await collectSnapshot({ now: at, ...source, statusCache, fleetReader: async () => [] });
    assert.deepEqual([snapshot.tasks[0].progress, snapshot.tasks[0].step], [50, 'Bau der Mail']);
    assert.equal(Object.hasOwn(snapshot.tasks[0], 'run'), false);
  }
  assert.deepEqual(source.calls, ['1791373200.001']);
  await collectSnapshot({ now: now + 360000, ...source, statusCache, fleetReader: async () => [] });
  assert.equal(source.calls.length, 2);
});

// D11-M2 (Fehleraudit 17.10.2026): on 16.10. (18:31–20:17Z) twelve fresh Sales and
// upload attempts showed "Worker meldet sich nicht mehr" while their Macs kept
// reporting to the RS Hub; only the reservation heartbeat lagged behind (Hub
// transport and Slack update failures). A live Mac's lagging reservation waits.
test('a stale reservation of a Mac with a fresh fleet heartbeat waits instead of being blocked', () => {
  const seen = (workerId, ageMs) => ({ workerId, name: workerId, lastSeenAt: new Date(now - ageMs).toISOString() });
  const stale = parseClaim(claimMessage('running', { task_id: 'a', run_id: '20261016T183102Z-a', worker: 'macbook-2', heartbeat: now / 1000 - 1900 }));
  const rows = workers => buildQueue([taskIn('pre-gen', 'a')], [stale], DEFAULT_WORKFLOWS, { now, workers });
  let [row] = rows([seen('macbook-2', 60000)]);
  assert.deepEqual([row.status, row.phase, row.workerId, row.attemptId],
    ['queued', 'Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert', 'macbook-2', '20261016T183102Z-a']);
  // Without a fleet heartbeat, with an old one or with another Mac's, it stays blocked.
  for (const workers of [undefined, [], [seen('macbook-2', 10 * 60000)], [seen('macbook-1', 0)]]) {
    [row] = rows(workers);
    assert.deepEqual([row.status, row.phase], ['blocked', 'Worker meldet sich nicht mehr'], JSON.stringify(workers));
  }
  // A reservation silent for hours is no lag of a live Mac.
  const old = parseClaim(claimMessage('running', { task_id: 'a', worker: 'macbook-2', heartbeat: now / 1000 - 3 * 3600 }));
  [row] = buildQueue([taskIn('pre-gen', 'a')], [old], DEFAULT_WORKFLOWS, { now, workers: [seen('macbook-2', 0)] });
  assert.deepEqual([row.status, row.phase], ['blocked', 'Worker meldet sich nicht mehr']);
  // A Mac-bound pause of a live Mac shows as paused outside the places.
  const paused = parseClaim(claimMessage('running', { task_id: 'a', worker: 'macbook-2', heartbeat: now / 1000 - 1900, paused: true }));
  [row] = buildQueue([taskIn('pre-gen', 'a')], [paused], DEFAULT_WORKFLOWS, { now, workers: [seen('macbook-2', 0)] });
  assert.deepEqual([row.status, row.phase], ['queued', 'Pausiert · wartet außerhalb der Worker-Plätze']);
});

test('a correction reservation of a live Mac with a lagging heartbeat waits as well', () => {
  const job = 'korrektur-cu-86cbgtpjr@1791373000000-intern';
  const claim = parseClaim({ ts: '1791373200.003', text: '*Korrektur · JuCad*\n<https://app.clickup.com/t/86cbgtpjr|Warm Up>',
    metadata: { event_type: 'ai_korrektur_claim', event_payload: { task_id: job, worker: 'mac-worker-6-64d66918', run_id: 'attempt-k', state: 'running', heartbeat: now / 1000 - 1900 } } });
  const rows = workers => buildQueue([], [claim], DEFAULT_WORKFLOWS, { now, workers }).filter(row => row.workflow === 'correction');
  assert.deepEqual(rows([{ workerId: 'mac-worker-6-64d66918', lastSeenAt: new Date(now - 30000).toISOString() }]).map(row => [row.status, row.phase, row.workerId]),
    [['queued', 'Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert', 'mac-worker-6-64d66918']]);
  assert.deepEqual(rows([]).map(row => [row.status, row.phase]), [['blocked', 'Worker meldet sich nicht mehr']]);
});

test('the snapshot compares reservations with the Mac heartbeats it read from the RS Hub', async () => {
  const snapshot = await collectSnapshot({ now, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} },
    hubFetch: async target => {
      const url = new URL(target);
      if (url.hostname === 'slack.com') return response({ ok: true, messages: [claimMessage('running', { worker: 'macbook-2', heartbeat: now / 1000 - 1900 })], has_more: false });
      if (url.pathname.endsWith('/space')) return response({ spaces: [{ id: 'space' }] });
      if (url.pathname.endsWith('/tag')) return response({ tags: [{ name: 'pre gen.' }] });
      return response({ tasks: [task('a')], last_page: true });
    }, fleetReader: async () => [{ workerId: 'macbook-2', name: 'macbook-2', lastSeenAt: new Date(now - 45000).toISOString() }] });
  assert.deepEqual([snapshot.tasks[0].status, snapshot.tasks[0].phase], ['queued', 'Wartet · Mac aktiv, Reservierungsmeldung an den RS Hub verzögert']);
});
