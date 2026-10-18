import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { checkpointBlocker, currentPm, applyBlockerContexts, PM_FIELD_ID } from './blocker-context.mjs';
import state from './task-state.cjs';

function checkpoint(change = {}) {
  const value = { schema: 2, producer: 'mac-1', runId: 'exact-run', runs: [{ run: {
    run_id: 'exact-run', task_id: 'exact-task', state: 'technisch_blockiert',
    detail: 'Fixture technical step failed', finished_at: '2026-10-18T12:00:00Z',
  } }] };
  const packed = Buffer.concat([Buffer.from('RSART2\0'), zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)))]).toString('base64');
  return { producer: 'mac-1', run_id: 'exact-run', task_id: 'exact-task', packed,
    digest: crypto.createHash('sha256').update(packed).digest('hex'), ...change };
}

test('checkpoint display binds exact bytes, producer, task and run without restoring a job', () => {
  const e = checkpoint(), result = checkpointBlocker(e);
  assert.equal(result.blockerSourceHash, e.digest);
  assert.equal(result.blockerSourceRunId, 'exact-run');
  assert.equal(result.reasonCode, 'technical_blocker');
  for (const change of [{ producer: 'other' }, { task_id: 'other' }, { run_id: 'other' },
    { digest: '0'.repeat(64) }, { packed: e.packed + 'bad' }]) {
    assert.equal(checkpointBlocker({ ...e, ...change }).reasonCode, 'blocker_context_unreadable');
  }
});

test('PM evidence uses one current explicit users field and never guesses assignees', () => {
  const field = { id: PM_FIELD_ID, type: 'users', value: [{ id: '12', username: 'Current PM' }] };
  assert.deepEqual(currentPm({ custom_fields: [field] }), { pmOwner: 'Current PM', pmOwnerId: '12' });
  for (const custom_fields of [[], [field, field], [{ ...field, value: [field.value[0], { id: '13', username: 'Other' }] }]]) {
    assert.deepEqual(currentPm({ custom_fields }), {});
  }
  const rows = [{ status: 'blocked', workflow: 'upload', url: 'https://app.clickup.com/t/task',
    blockedReason: 'Fixture fault', pmOwner: 'Old PM', pmOwnerId: '99' }];
  applyBlockerContexts(rows, [], 1000);
  assert.equal(rows[0].pmOwner, undefined);
  assert.equal(rows[0].pmOwnerId, undefined);
  assert.equal(rows[0].pmCheckedAt, new Date(1000).toISOString());
});

test('manual completion is final and cannot become live work during reconciliation', () => {
  const task = state.reconcileTask({ completion: 'manual', status: 'blocked', step: 'stale',
    blockedReason: 'old', errorUrl: 'https://example.test/old' });
  assert.equal(task.status, 'completed');
  assert.equal(task.progress, 100);
  for (const key of ['step', 'blockedReason', 'errorUrl']) assert.equal(task[key], undefined);
});
