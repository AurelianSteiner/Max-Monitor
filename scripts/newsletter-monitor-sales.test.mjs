import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { salesProgress, readLocalSales, collectSnapshot, syncOnce } from './newsletter-monitor-bridge.mjs';

const require = createRequire(import.meta.url);
const { createFleetStore } = require('../team-server/fleet.js');
const now = Date.parse('2026-10-12T15:40:00Z');
const ts = index => `179175374${index}.123456`;
const job = overrides => ({ status: 'running', url: 'https://www.myspirits.eu/', worker: 'macbook-1',
  owner: 'e5908a37-6225-4918-adb6-90e8dceba2c7', created_at: now - 3600000, observed_at: now - 5000, ...overrides });
const event = (stage, state = 'done', mail = 0, offset = 0) => ({ stage, state, mail, at: new Date(now + offset).toISOString() });

test('Sales progress starts at zero when reserved and advances only on completed work', () => {
  assert.deepEqual(salesProgress(job({ status: 'reserved' })), { progress: 0, step: 'Reserviert' });
  assert.deepEqual(salesProgress(job()), { progress: 5, step: 'Vorbereitung' });
  assert.deepEqual(salesProgress(job({ monitor: { events: [event('shop_research', 'start')] } })),
    { progress: 5, step: 'Shop-Recherche' });
  assert.deepEqual(salesProgress(job({ monitor: { events: [event('shop_research'), event('brand_system', 'start', 0, 1)] } })),
    { progress: 20, step: 'Designsystem' });
});

test('Sales counts split stages once per mail and retains the legacy build contract', () => {
  assert.equal(salesProgress(job({ monitor: { events: [event('build', 'done', 1)] } })).progress, 13);
  const events = [event('shop_research'), event('brand_system'), event('briefings'), event('build', 'done', 1),
    event('ideas', 'done', 1), event('opener', 'done', 1), event('mail_build', 'start', 1)];
  assert.deepEqual(salesProgress(job({ monitor: { events } })), { progress: 40, step: 'Newsletter-Gestaltung · Mail 1' });
  assert.equal(salesProgress(job({ monitor: { events: [...events, event('mail_build', 'done', 1, 1)] } })).progress, 43);
  assert.equal(salesProgress(job({ monitor: { events: [event('art_director', 'done', 1)] } })).progress, 8);
});

test('Sales progress follows the latest event, supports parallel mails and ignores malformed telemetry', () => {
  const events = [event('shop_research', 'start', 0, 2), event('shop_research'), null,
    event('toString'), event('mail_build', 'done', 9), { ...event('brand_system'), at: 'invalid' }];
  assert.deepEqual(salesProgress(job({ monitor: { events } })), { progress: 5, step: 'Shop-Recherche' });
  assert.deepEqual(salesProgress(job({ monitor: { events: [event('mail_build', 'start', 1), event('mail_build', 'start', 3, 1)] } })),
    { progress: 5, step: 'Newsletter-Gestaltung · Mail 1, 3' });
  assert.equal(salesProgress(job({ monitor: { events: {} } })).progress, 5);
  assert.deepEqual(salesProgress(job({ status: 'blocked', monitor: { events: [event('shop_research', 'blocked')] } })),
    { progress: 5, step: 'Shop-Recherche · blockiert' });
});

test('Sales validation and delivery remain below 100 until confirmed done', () => {
  const events = ['shop_research', 'brand_system', 'briefings', 'ideas', 'opener', 'mail_build', 'art_director',
    'customer_review', 'one_sentence', 'fact_check', 'desktop_mobile', 'pdf_export', 'pdf_review'].map(stage => event(stage));
  assert.deepEqual(salesProgress(job({ monitor: { events, phase: 'validation' } })),
    { progress: 92, step: 'Ergebnisvalidierung' });
  for (const uploaded of [0, 1, 2, 3]) {
    assert.deepEqual(salesProgress(job({ status: 'delivery', files: Array.from({ length: uploaded }, () => ({ uploaded: true })) })),
      { progress: 95 + uploaded, step: 'PDF-Auslieferung und Slack-Prüfung' });
  }
  assert.deepEqual(salesProgress(job({ status: 'done', monitor: { events } })), { progress: 100, step: 'Fertig' });
});

test('Sales progress and current step survive the real relay and refresh without a new log event', async t => {
  const directory = await fixture(t, [job({ monitor: { events: [event('shop_research'), event('brand_system', 'start', 0, 1)] } })]);
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  const update = async () => store.updateQueue('SALESTEST', { tasks: await readLocalSales(directory, now), source: { name: 'Sales' } });
  await update();
  const before = store.snapshot('SALESTEST');
  assert.deepEqual([before.queue.tasks[0].progress, before.queue.tasks[0].step], [20, 'Designsystem']);
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), JSON.stringify(job({ monitor: {
    events: [event('shop_research'), event('brand_system'), event('briefings', 'start', 0, 1)] } })));
  await update();
  const after = store.snapshot('SALESTEST');
  assert.deepEqual([after.queue.tasks[0].progress, after.queue.tasks[0].step], [28, 'Themen und Briefings']);
  assert.equal(after.queue.tasks[0].taskVersion, before.queue.tasks[0].taskVersion);
  assert.equal(after.events.length, before.events.length);
});

async function fixture(t, jobs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-sales-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [index, value] of jobs.entries()) {
    await fs.mkdir(path.join(directory, ts(index)));
    await fs.writeFile(path.join(directory, ts(index), 'job.json'), JSON.stringify(value));
  }
  return directory;
}

test('Sales counts include HTTP, all lifecycle states and old terminal jobs through the real relay', async t => {
  const directory = await fixture(t, [job({ url: 'http://cairo.de/' }), job(), job({ status: 'delivery' }),
    job({ status: 'blocked', reason: 'Ergebnisdatei fehlt', observed_at: now - 86400000 }),
    job({ status: 'done', observed_at: now - 7 * 86400000 }), job({ status: 'reserved', observed_at: undefined }),
    job({ status: 'aborted', reason: 'Vom Nutzer abgebrochen' })]);
  const rows = await readLocalSales(directory, now);
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  store.updateQueue('SALESTEST', { tasks: rows, source: { name: 'Sales', lastSuccessAt: new Date(now).toISOString() } });
  const saved = store.snapshot('SALESTEST').queue.tasks;
  const count = status => saved.filter(row => row.status === status).length;
  assert.deepEqual(['running', 'blocked', 'completed', 'queued'].map(count), [3, 1, 1, 1]);
  assert.equal(saved.find(row => row.url === 'http://cairo.de/').status, 'running');
  assert.equal(saved.find(row => row.sourceStatus === 'done').progress, 100);
  assert.equal(saved.find(row => row.sourceStatus === 'blocked').blockedReason, 'Ergebnisdatei fehlt');
  assert.equal(saved.some(row => row.sourceStatus === 'aborted'), false);
});

test('aborted attempts leave only the successful Sales job in the relay', async t => {
  const directory = await fixture(t, [job({ status: 'done' }), ...Array.from({ length: 6 }, () => job({ status: 'aborted' }))]);
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  store.updateQueue('SALESTEST', { tasks: await readLocalSales(directory, now), blockedErrors: [], source: { name: 'Sales' } });
  const saved = createFleetStore(path.join(directory, 'relay'), () => now).snapshot('SALESTEST').queue.tasks;
  assert.deepEqual(saved.map(row => [row.id, row.status]), [[`sales:${ts(0)}`, 'completed']]);
  assert.equal(saved[0].progress, 100);
});

test('late heartbeats keep the same Sales job visible until its persisted state changes', async t => {
  const directory = await fixture(t, [job({ observed_at: now - 3 * 60000 })]);
  let rows = await readLocalSales(directory, now);
  assert.equal(rows[0].status, 'running');
  rows = await readLocalSales(directory, now + 86400000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'running');
  assert.equal(rows[0].phase, 'Worker-Meldung ausstehend');
  assert.equal(rows[0].progress, 5);
  assert.match(rows[0].step, /Worker-Meldung ausstehend/);
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), JSON.stringify(job({ status: 'done' })));
  const completed = await readLocalSales(directory, now + 86400000);
  assert.equal(completed[0].id, rows[0].id);
  assert.equal(completed[0].status, 'completed');
});

test('partial, missing and unsafe Sales data cannot silently remove jobs', async t => {
  const directory = await fixture(t, [job()]);
  const file = path.join(directory, ts(0), 'job.json');
  for (const content of ['{unfinished', JSON.stringify(job({ url: 'https://user:secret@example.com/' })),
    JSON.stringify(job({ url: 'javascript:alert(1)' })), JSON.stringify(job({ status: 'toString' }))]) {
    await fs.writeFile(file, content);
    await assert.rejects(readLocalSales(directory, now), /bisheriger Queue-Stand bleibt erhalten/);
  }
  await fs.unlink(file);
  await assert.rejects(readLocalSales(directory, now), /bisheriger Queue-Stand bleibt erhalten/);
  await assert.rejects(readLocalSales(path.join(directory, 'missing'), now), /Sales-Jobablage/);
});

test('a failed Sales read preserves the last full relay queue and cache', async t => {
  const directory = await fixture(t, [job()]);
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  const tasks = await readLocalSales(directory, now);
  const source = { name: 'Sales', lastSuccessAt: new Date(now).toISOString() };
  store.updateQueue('SALESTEST', { tasks, source });
  const before = store.snapshot('SALESTEST').queue.tasks;
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), '{unfinished');
  let saved = false;
  const result = await syncOnce({ cachedSource: source,
    collect: () => collectSnapshot({ now, config: { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} },
      hubFetch: async () => ({ ok: true, status: 200, json: async () => ({ spaces: [], tasks: [] }) }),
      claimReader: async () => [], fleetReader: async () => [], salesReader: time => readLocalSales(directory, time) }),
    publish: snapshot => store.updateQueue('SALESTEST', snapshot), save: async () => { saved = true; } });
  assert.equal(result.ok, false);
  assert.equal(saved, false);
  assert.deepEqual(store.snapshot('SALESTEST').queue.tasks, before);
  assert.match(store.snapshot('SALESTEST').queue.source.error, /Sales-Job/);
});
