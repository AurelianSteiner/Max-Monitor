import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseWorkerIssue, buildBlockedErrors, collectSnapshot } from './newsletter-monitor-bridge.mjs';
const { createFleetStore } = createRequire(import.meta.url)('../team-server/fleet.js');
const message = (payload = {}, text = 'Systemmeldung\n```Konkrete Diagnose```') => ({ ts: '1792690000.000001', text,
  metadata: { event_type: 'ai_newsletter_fehler', event_payload: { kind: 'system', worker: 'mac-a', ...payload } } });

test('all run outcomes and workflow IDs stay with the exact attempt, including system-enveloped completion failures', () => {
  for (const [job, workflow] of [['abc@123', 'newsletter'], ['abc@123-klaviyo', 'upload'],
    ['abc@123-uebersetzung-en', 'translation'], ['korrektur-cu-abc@123-intern', 'correction']]) {
    for (const state of ['blockiert', 'technisch_blockiert', 'zeitlimit', 'abgebrochen_neustart']) {
      const m = message({ kind: 'lauf', task_id: job, run_id: 'attempt-1', state });
      assert.equal(parseWorkerIssue(m), null);
      const [row] = buildBlockedErrors([m], 'CERRORS');
      assert.equal(row.workflow, workflow); assert.equal(row.attemptId, 'attempt-1');
    }
    for (const stage of ['finalize', 'finalize_wait', 'new_run_stage']) {
      const m = message({ stage, task_id: job, run_id: 'attempt-2' });
      assert.equal(parseWorkerIssue(m), null, `${stage} does not fail the Mac`);
      const [row] = buildBlockedErrors([m], 'CERRORS');
      assert.equal(row.workflow, workflow); assert.equal(row.attemptId, 'attempt-2');
      assert.doesNotMatch(row.title, /^Worker ·/);
    }
  }
  for (const stage of ['finalize', 'finalize_wait']) {
    assert.equal(parseWorkerIssue(message({ stage })), null, 'legacy completion notice without IDs stays local to an order');
    assert.equal(buildBlockedErrors([message({ stage })], 'CERRORS')[0].workflow, 'task-errors');
  }
});

test('file access and setup gaps differ from Figma login and account-wide missing seats, also for legacy messages', () => {
  for (const m of [message({ stage: 'filestage_zuordnung' }), message({ stage: 'figma_zugang', art: 'nur_lesen' }),
    message({ stage: 'figma_zugang' }, '⚠️ Figma-Zugang fehlt: Das Konto darf die Datei nur lesen.')]) {
    assert.equal(parseWorkerIssue(m), null);
    assert.equal(buildBlockedErrors([m], 'CERRORS').length, 1);
  }
  for (const art of ['nicht_angemeldet', 'kein_seat']) {
    assert.ok(parseWorkerIssue(message({ stage: 'figma_zugang', art, run_id: 'origin-run', scope: 'worker' })));
  }
  for (const text of ['⚠️ Figma-Zugang fehlt: Das Konto ist in Claude Code nicht bei Figma angemeldet.',
    '⚠️ Figma-Zugang fehlt: Das Konto hat keinen Full-Seat.']) assert.ok(parseWorkerIssue(message({ stage: 'figma_zugang' }, text)));
});

test('fleet and unknown notices remain visible without blaming their reporter; neighbour notices target the affected Mac', () => {
  for (const m of [message({ kind: 'update', scope: 'fleet' }),
    message({ kind: 'update' }, '⚠️ Update auf `abcdef` scheitert an den Tests auf 3 Macs (A, B, C): main ist seit gestern rot.'),
    message({ stage: 'unclassified_new_notice' })]) {
    assert.equal(parseWorkerIssue(m), null);
    assert.equal(buildBlockedErrors([m], 'CERRORS')[0].workflow, 'system-notices');
  }
  const neighbour = message({ stage: 'nachbar', betrifft: 'mac-b' });
  assert.equal(parseWorkerIssue(neighbour).workerId, 'mac-b');
  assert.equal(buildBlockedErrors([neighbour], 'CERRORS')[0].workerId, 'mac-b');
  assert.equal(parseWorkerIssue(message({ stage: 'nachbar', betrifft: 'invalid worker' })), null);
});

test('real operational failures stay visible while a task with the same diagnosis never fails the Mac', () => {
  for (const stage of ['claude', 'clickup_list', 'clickup_status', 'poll', 'recover', 'slack_claims', 'werkzeuge',
    'klaviyo_renderer', 'platte', 'strom', 'rs_skills', 'update_umgebung']) {
    assert.ok(parseWorkerIssue(message({ stage })), stage);
    assert.equal(parseWorkerIssue(message({ stage, task_id: 'abc', run_id: 'run-1' })), null, `${stage} attached only to an order`);
  }
  const legacy = { ts: '1792690000.000001', bot_id: 'BOT', text: ':warning: AI-Newsletter-Worker auf Mac `mac-a`: technischer Fehler bei finalize (Error). Lokales Log prüfen.' };
  assert.equal(parseWorkerIssue(legacy), null);
});

test('relay and actual dashboard status reject misrouted run errors even across restart and partial source reads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-relay-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = createFleetStore(directory);
  const now = new Date().toISOString();
  const raw = stage => ({ id: stage, workerId: 'mac-a', stage, severity: 'error', message: 'Diagnose', reportedAt: now });
  const errors = [raw('finalize'), raw('finalize_wait'), raw('filestage_zuordnung'),
    { ...raw('clickup_list'), task_id: 'abc', run_id: 'run-1' }, { ...raw('new_notice'), scope: 'resource' }];
  store.updateQueue('TEAM1234', { source: { name: 'test' }, tasks: [], observedWorkers: [{ workerId: 'mac-a', name: 'A', lastSeenAt: now }], workerIssues: errors });
  assert.deepEqual(store.snapshot('TEAM1234').machines[0].workerIssues, undefined);
  // An old persisted adapter may have saved wrong worker issues already.
  const file = path.join(directory, 'TEAM1234/fleet.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.workerIssues = errors;
  fs.writeFileSync(file, JSON.stringify(state));
  store = createFleetStore(directory);
  const machine = store.snapshot('TEAM1234').machines[0];
  assert.equal(machine.workerIssues, undefined);
  store.updateQueue('TEAM1234', { source: { name: 'test', error: 'source unavailable' }, workerIssues: [...errors, raw('claude')] });
  const affected = store.snapshot('TEAM1234').machines[0];
  assert.deepEqual(affected.workerIssues.map(i => i.stage), ['claude']);
  const js = fs.readFileSync(new URL('../team-server/public/dashboard.js', import.meta.url), 'utf8');
  const marker = '  function attentionEntries(';
  const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
  vm.runInNewContext(js.replace(marker, '  globalThis.checkStatus = machineDisplayStatus; return;\n' + marker), context);
  assert.equal(context.checkStatus(machine), 'online');
  assert.equal(context.checkStatus(affected), 'failed');
});

test('a mixed complete snapshot clears old false worker flags and keeps every order error and real worker outage', async () => {
  const messages = [message({ stage: 'finalize', task_id: 'abc', run_id: 'run-1' }),
    { ...message({ stage: 'claude' }), ts: '1792690000.000002' }];
  const snapshot = await collectSnapshot({ config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'status' }, fehler: { enabled: true, channel_id: 'errors' }, hub: {} },
    fleetReader: async () => [], hubFetch: async target => {
      const url = new URL(target);
      return { ok: true, status: 200, json: async () => url.hostname === 'slack.com'
        ? { ok: true, messages: url.searchParams.get('channel') === 'errors' ? messages : [], has_more: false }
        : { spaces: [], tasks: [] } };
    } });
  assert.deepEqual(snapshot.workerIssues.map(i => i.stage), ['claude']);
  assert.equal(snapshot.blockedErrors.length, 2);
});
