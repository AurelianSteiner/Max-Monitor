import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readLocalSales, salesProgress, collectSnapshot, syncOnce } from './newsletter-monitor-bridge.mjs';
import { SALES_CLOSED_PHASE } from './blocker-context.mjs';

const require = createRequire(import.meta.url);
const { createFleetStore } = require('../team-server/fleet.js');
const now = Date.parse('2026-10-12T15:40:00Z');
const ts = index => `179175374${index}.123456`;
const job = overrides => ({ status: 'running', url: 'https://www.myspirits.eu/', worker: 'macbook-1',
  owner: 'e5908a37-6225-4918-adb6-90e8dceba2c7', created_at: now - 3600000, observed_at: now - 5000, ...overrides });

async function fixture(t, jobs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-monitor-sales-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [index, value] of jobs.entries()) {
    await fs.mkdir(path.join(directory, ts(index)));
    await fs.writeFile(path.join(directory, ts(index), 'job.json'), JSON.stringify(value));
  }
  return directory;
}

const event = (stage, mail = 0, state = 'done', offset = 0) => ({ stage, mail, state, at: new Date(now - 60000 + offset).toISOString() });

test('Sales progress follows completed work across three mails and V9 reviews, not elapsed time', () => {
  const events = ['shop_research', 'brand_system', 'briefings'].map(stage => event(stage));
  events.push(...['ideas', 'opener', 'mail_build'].map(stage => event(stage, 1)),
    event('opener_review', 1), event('reader_review', 2, 'start', 1000));
  const value = job({ monitor: { events, elapsed_seconds: 1 } });
  assert.deepEqual(salesProgress(value), { progress: 44, step: 'Leserprüfung · Mail 2' });
  value.monitor.elapsed_seconds = 86400;
  assert.equal(salesProgress(value).progress, 44);
  // Old review events must not add a second set of weights to a V9 build.
  value.monitor.events.push(event('fact_check'), event('one_sentence'), event('customer_review'));
  assert.equal(salesProgress(value).progress, 44);
  value.monitor.events.push(event('reader_review', 2, 'done', 2000), event('acceptance', 0, 'done', 3000));
  assert.deepEqual(salesProgress(value), { progress: 50, step: 'Endabnahme und Kundenblick abgeschlossen' });
});

test('Sales delivery retains sub-100 progress until the three-PDF completion is confirmed', () => {
  assert.deepEqual(salesProgress(job({ status: 'reserved' })), { progress: 0, step: 'Reserviert' });
  assert.deepEqual(salesProgress(job()), { progress: 5, step: 'Vorbereitung' });
  assert.deepEqual(salesProgress(job({ monitor: { phase: 'validation' } })), { progress: 5, step: 'Ergebnisvalidierung' });
  for (let uploaded = 0; uploaded <= 3; uploaded++) {
    const files = Array.from({ length: 3 }, (_, i) => ({ uploaded: i < uploaded }));
    assert.deepEqual(salesProgress(job({ status: 'delivery', files })),
      { progress: 95 + uploaded, step: 'PDF-Auslieferung und Slack-Prüfung' });
  }
  assert.deepEqual(salesProgress(job({ status: 'done' })), { progress: 100, step: 'Fertig' });
  assert.equal(salesProgress(job({ monitor: { events: [null, event('unknown'), event('shop_research', 4),
    { ...event('shop_research'), at: 'invalid' }] } })).progress, 5);
});

test('live Sales progress survives relay storage and refresh without hiding pauses or stale workers', async t => {
  const monitor = { events: [event('shop_research'), event('brand_system', 0, 'start', 1000)] };
  const directory = await fixture(t, [job({ monitor }), job({ monitor: { ...monitor, paused: true } }),
    job({ monitor, observed_at: now - 31 * 60000 })]);
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  store.updateQueue('SALESTEST', { tasks: await readLocalSales(directory, now), source: { name: 'Sales' } });
  let saved = store.snapshot('SALESTEST').queue.tasks;
  assert.equal(saved[0].progress, 20);
  assert.equal(saved[0].step, 'Designsystem');
  assert.equal(saved[1].progress, 20);
  assert.equal(saved[1].step, undefined);
  assert.match(saved[1].phase, /Pausiert/);
  assert.equal(saved[2].step, undefined);
  assert.equal(saved[2].phase, 'Worker-Meldung ausstehend');
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), JSON.stringify(job({ monitor: {
    events: [event('shop_research'), event('brand_system'), event('briefings', 0, 'start', 1000)] } })));
  store.updateQueue('SALESTEST', { tasks: await readLocalSales(directory, now), source: { name: 'Sales' } });
  saved = createFleetStore(path.join(directory, 'relay'), () => now).snapshot('SALESTEST').queue.tasks;
  assert.equal(saved[0].progress, 28);
  assert.equal(saved[0].step, 'Themen und Briefings');
});

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

test('terminal backlog receipts without jobs do not freeze unrelated correction updates', async t => {
  const directory = await fixture(t, [job()]);
  const receipts = [
    { status: 'superseded', existing_delivery_ts: ts(0) },
    { status: 'duplicate', original_ts: ts(0) },
    { status: 'existing-delivery', files: [1, 2, 3].map(i => ({ id: `F00000000${i}`, uploaded: true })) },
  ];
  for (const [index, value] of receipts.entries()) {
    const dir = path.join(directory, ts(index + 1));
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'existing-delivery.json'), JSON.stringify({ ...value,
      authorized_by: 'backlog-audit.json', recorded_at: new Date(now - 1000).toISOString() }));
  }
  assert.deepEqual((await readLocalSales(directory, now)).map(row => row.id), [`sales:${ts(0)}`]);
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} };
  const snapshot = await collectSnapshot({ now, config,
    hubFetch: async () => ({ ok: true, status: 200, json: async () => ({ spaces: [], tasks: [] }) }),
    claimReader: async () => [], fleetReader: async () => [], salesReader: time => readLocalSales(directory, time) });
  assert.equal(snapshot.source.lastSuccessAt, new Date(now).toISOString());
  assert.deepEqual(snapshot.tasks.map(row => row.id), [`sales:${ts(0)}`]);

  const receiptFile = path.join(directory, ts(1), 'existing-delivery.json');
  for (const invalid of [{ status: 'running' }, { ...receipts[2], files: [] }, { ...receipts[2], files: [{ id: 'F1', uploaded: false }] }]) {
    await fs.writeFile(receiptFile, JSON.stringify({ ...invalid, authorized_by: 'audit', recorded_at: new Date(now).toISOString() }));
    await assert.rejects(readLocalSales(directory, now), /bisheriger Queue-Stand bleibt erhalten/);
  }
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipts[0], authorized_by: 'audit', recorded_at: new Date(now).toISOString() }));
  await fs.writeFile(path.join(directory, ts(1), 'job.json'), '{unfinished');
  await assert.rejects(readLocalSales(directory, now), /bisheriger Queue-Stand bleibt erhalten/);
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

test('paused Sales work remains queued with its owner and resumes the same attempt', async t => {
  const directory = await fixture(t, [job({ monitor: { paused: true } })]);
  const [paused] = await readLocalSales(directory, now);
  assert.equal(paused.status, 'queued');
  assert.equal(paused.phase, 'Pausiert · wartet außerhalb der Worker-Plätze');
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), JSON.stringify(job({ monitor: { paused: false } })));
  const [resumed] = await readLocalSales(directory, now);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.attemptId, paused.attemptId);
});

test('stored quota checkpoints permit a fresh complete queue and retain the attempt on transfer', async t => {
  const directory = await fixture(t, [job({ status: 'paused', observed_at: now - 3600000,
    monitor: { paused: false }, continuation: { status: 'stored' } })]);
  const config = { clickup: { workspace_id: 'test' }, slack: { channel_id: 'test' }, hub: {} };
  const snapshot = await collectSnapshot({ now, config,
    hubFetch: async () => ({ ok: true, status: 200, json: async () => ({ spaces: [], tasks: [] }) }),
    claimReader: async () => [], fleetReader: async () => [], salesReader: time => readLocalSales(directory, time) });
  assert.equal(snapshot.source.lastSuccessAt, new Date(now).toISOString());
  assert.equal(snapshot.tasks[0].status, 'queued');
  const store = createFleetStore(path.join(directory, 'relay'), () => now);
  store.updateQueue('SALESTEST', snapshot);
  const [paused] = store.snapshot('SALESTEST').queue.tasks;
  assert.equal(paused.sourceStatus, 'paused');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.phase, 'Pausiert · wartet außerhalb der Worker-Plätze');
  assert.equal(paused.workerId, 'macbook-1');
  assert.notEqual(paused.progress, 100);
  await fs.writeFile(path.join(directory, ts(0), 'job.json'), JSON.stringify(job({ worker: 'mac-f121ae17' })));
  store.updateQueue('SALESTEST', { ...snapshot, tasks: await readLocalSales(directory, now) });
  const [resumed] = store.snapshot('SALESTEST').queue.tasks;
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.workerId, 'mac-f121ae17');
  assert.equal(resumed.attemptId, paused.attemptId);
});

// Fehleraudit 26.10.2026 (Till): the Sales owner arrives only through the Sales
// job's own typed fields; job.owner stays the attempt identity.
test('a blocked Sales job typed by the worker carries the Sales owner into the queue', async t => {
  const shop = { status: 'blocked', reason: 'Shop nicht verfügbar: Betrieb eingestellt.' };
  const directory = await fixture(t, [job({ ...shop, reason_code: 'sales_shop_unavailable' }), job({ ...shop, blocker_owner: 'sales' }),
    job({ ...shop, reasonCode: 'sales_shop_unavailable' }), job(shop), job({ ...shop, reason_code: 'technical_step_failed', blocker_owner: 'technik' }),
    job({ status: 'running', reason_code: 'sales_shop_unavailable', blocker_owner: 'sales' }),
    // A named owner decides; contradicting typed fields never close the case.
    job({ ...shop, reason_code: 'sales_shop_unavailable', blocker_owner: 'technik' }),
    job({ ...shop, blocker_owner: 'sales', blockerOwner: 'technik' }),
    job({ ...shop, reason_code: 'sales_shop_unavailable', reasonCode: 'technical_step_failed' }),
    job({ ...shop, blocker_owner: 'sales', reason_code: 'technical_step_failed' })]);
  const rows = (await readLocalSales(directory, now)).sort((a, b) => a.id.localeCompare(b.id));
  // Till, 30.10.2026: a typed Sales finding is a finished order without production, never a blocker.
  const closed = [true, true, true, false, false, false, false, false, false, true];
  assert.deepEqual(rows.map(row => row.status), closed.map((value, index) => value ? 'completed' : index === 5 ? 'running' : 'blocked'));
  assert.deepEqual(rows.map(row => row.phase === SALES_CLOSED_PHASE), closed);
  assert.deepEqual(rows.map(row => row.reasonCode), closed.map(value => value ? 'sales_shop_unavailable' : undefined),
    'only the closed case is typed here; the bridge derives the other contexts itself');
  assert.equal(rows.some(row => row.blockerOwner || (row.status === 'completed' && row.blockedReason)), false);
  assert.deepEqual(rows.map(row => row.attemptId), rows.map(() => 'e5908a37-6225-4918-adb6-90e8dceba2c7'));
});

// Till, 30.10.2026 (petiteannee.ch NXDOMAIN, angharadvashe.com HTTP 401): the worker ends an unusable
// shop as done with outcome no_production; the queue shows it finished, with its reason and owner.
test('a Sales job finished without production shows as completed, not as blocked or delivered', async t => {
  const reason = 'Shop nicht erreichbar: www.petiteannee.ch ist im DNS nicht vorhanden (NXDOMAIN).';
  const directory = await fixture(t, [
    job({ status: 'done', outcome: 'no_production', reason, blocker_owner: 'sales', reason_code: 'sales_shop_unavailable', files: [], completed_at: now - 60000, updated_at: now - 60000 }),
    job({ status: 'done', files: [], updated_at: now - 30000 })]);
  const [closed, delivered] = (await readLocalSales(directory, now)).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual([closed.status, closed.sourceStatus, closed.phase, closed.reasonCode, closed.responsibleRole, closed.blockerReason],
    ['completed', 'done', SALES_CLOSED_PHASE, 'sales_shop_unavailable', 'Sales', reason]);
  assert.equal(closed.completedAt, new Date(now - 60000).toISOString());
  assert.equal(closed.blockedReason, undefined);
  assert.deepEqual([delivered.status, delivered.phase, delivered.reasonCode], ['completed', 'Fertig', undefined]);
});
