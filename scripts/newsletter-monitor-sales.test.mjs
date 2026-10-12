import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readLocalSales, collectSnapshot, syncOnce } from './newsletter-monitor-bridge.mjs';

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
      hubFetch: async () => ({ ok: true, status: 200, json: async () => ({ spaces: [] }) }),
      claimReader: async () => [], fleetReader: async () => [], salesReader: time => readLocalSales(directory, time) }),
    publish: snapshot => store.updateQueue('SALESTEST', snapshot), save: async () => { saved = true; } });
  assert.equal(result.ok, false);
  assert.equal(saved, false);
  assert.deepEqual(store.snapshot('SALESTEST').queue.tasks, before);
  assert.match(store.snapshot('SALESTEST').queue.source.error, /Sales-Job/);
});
