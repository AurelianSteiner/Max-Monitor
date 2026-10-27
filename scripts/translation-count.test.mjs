import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyCompletedLanguageRuns, readRunKinds, readRunKindEvidence } from './newsletter-monitor-bridge.mjs';

const row = (changes = {}) => ({ id: 'clickup:newsletter:t1', workflow: 'newsletter', status: 'completed',
  workerId: 'mac1', attemptId: 'run1', title: 'FR-FR | Example', ...changes });
const proof = (changes = {}) => ({ worker: 'mac1', run_id: 'run1', task_id: 't1@123', kind: 'translation', ...changes });

test('a matching worker run changes only the workflow and keeps task identity and completion', () => {
  const item = row({ completedAt: '2026-10-27T10:00:00Z', completionSource: 'slack' });
  classifyCompletedLanguageRuns([item], [proof()]);
  assert.deepEqual(item, row({ completedAt: '2026-10-27T10:00:00Z', completionSource: 'slack',
    workflow: 'translation', workflowEvidence: 'worker-run-kind' }));
});

test('never infer from title, mismatched worker, task, attempt, or conflicting evidence', () => {
  for (const evidence of [[], [proof({ worker: 'mac2' })], [proof({ run_id: 'old' })], [proof({ task_id: 't2@123' })],
    [proof(), proof({ kind: 'newsletter' })], [proof({ kind: 'newsletter' })]]) {
    const item = row(); classifyCompletedLanguageRuns([item], evidence);
    assert.equal(item.workflow, 'newsletter');
  }
  for (const change of [{ status: 'running' }, { workerId: undefined }, { attemptId: undefined }, { id: 'clickup:upload:t1' }]) {
    const item = row(change); classifyCompletedLanguageRuns([item], [proof()]);
    assert.equal(item.workflow, 'newsletter');
  }
});

test('retention is bound to the same completed attempt and cannot override contrary evidence', () => {
  const old = row({ workflow: 'translation', workflowEvidence: 'worker-run-kind' });
  const same = row(); classifyCompletedLanguageRuns([same], [], [old]); assert.equal(same.workflow, 'translation');
  for (const change of [{ attemptId: 'new' }, { workerId: 'mac2' }, { status: 'running' }]) {
    const item = row(change); classifyCompletedLanguageRuns([item], [], [old]); assert.equal(item.workflow, 'newsletter');
  }
  const corrected = row(); classifyCompletedLanguageRuns([corrected], [proof({kind:'newsletter'})], [old]);
  assert.equal(corrected.workflow, 'newsletter');
});

test('readRunKinds reads the ledger and closes the database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs(worker TEXT, run_id TEXT, task_id TEXT, kind TEXT)');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('mac1', 'run1', 't1@123', 'translation');
  const records = readRunKinds('unused', () => db);
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'translation');
  assert.throws(() => db.prepare('SELECT 1'));
});

test('historic evidence survives ledger retention, but a current corrected kind wins', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledgerFile = path.join(dir, 'ledger.sqlite'), historyFile = path.join(dir, 'history.json');
  const db = new DatabaseSync(ledgerFile);
  db.exec('CREATE TABLE runs(worker TEXT, run_id TEXT, task_id TEXT, kind TEXT)');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('mac1', 'run1', 't1@123', 'newsletter'); db.close();
  await fs.writeFile(historyFile, JSON.stringify({ schema: 1, runs: [proof(), proof({run_id:'run2'})] }));
  const evidence = await readRunKindEvidence({ ledgerFile, historyFile });
  assert.equal(evidence.find(x => x.run_id === 'run1').kind, 'newsletter');
  assert.equal(evidence.find(x => x.run_id === 'run2').kind, 'translation');
  await fs.writeFile(historyFile, '{invalid');
  const warnings = [];
  assert.equal((await readRunKindEvidence({ ledgerFile, historyFile, warn: x => warnings.push(x) })).length, 1);
  assert.equal(warnings.length, 1);
});
