const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFleetStore } = require('../fleet');

test('the PM name survives relay persistence; invalid metadata cannot replace the queue', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-pm-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createFleetStore(dir);
  const task = { id: 'pm-task', title: 'Rückfrage', workflow: 'newsletter', status: 'clarification',
    pmOwner: 'Ben Schulte', pmOwnerId: '42', pmCheckedAt: '2026-10-18T12:00:00Z' };
  const publish = value => store.updateQueue('DEMO1234', { source: { name: 'ClickUp' }, tasks: [value] });
  publish(task);
  const read = () => createFleetStore(dir).snapshot('DEMO1234').queue.tasks[0];
  assert.equal(read().pmOwner, 'Ben Schulte');
  assert.equal(read().pmOwnerId, '42');
  for (const metadata of [{ pmOwner: 'x'.repeat(101) }, { pmOwnerId: 'x'.repeat(65) }, { pmCheckedAt: 'invalid' }]) {
    assert.throws(() => publish({ ...task, ...metadata }), error => error.status === 400);
    assert.equal(read().pmOwner, 'Ben Schulte');
  }
  const { pmOwner, pmOwnerId, pmCheckedAt, ...legacy } = task;
  publish(legacy);
  assert.equal(read().pmOwner, undefined);
});
