const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real status projection used by navigation, badges and pipeline.
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.pmUnderTest = { stageOf, matchesStatus }; return;\n' + marker), context);
const { stageOf, matchesStatus } = context.pmUnderTest;

test('PM tab combines current clarification tasks and older relays open PM questions across workflows', () => {
  for (const workflow of ['newsletter', 'correction', 'upload', 'translation']) {
    for (const task of [
      { workflow, status: 'clarification', phase: 'Klärung nötig' },
      { workflow, status: 'queued', phase: 'Wartet · PM-Rückfrage', tags: ['ki upload · wartet'] },
    ]) {
      const original = JSON.stringify(task);
      assert.equal(stageOf(task), 'clarification');
      assert.equal(matchesStatus(task, 'clarification'), true);
      assert.equal(matchesStatus(task, 'queued'), false);
      assert.equal(matchesStatus(task, 'open'), true);
      assert.equal(JSON.stringify(task), original);
    }
  }
});

test('answered questions awaiting continuation and ordinary waiting tasks stay in Wartet', () => {
  for (const phase of ['Wartet auf Fortsetzung', 'Wartet', 'Reserviert']) {
    const task = { status: 'queued', phase };
    assert.equal(matchesStatus(task, 'clarification'), false);
    assert.equal(matchesStatus(task, 'queued'), true);
  }
  assert.equal(stageOf({ status: 'queued', phase: 'Noch nicht gestartet' }), 'marked');
});

test('a stale PM phase never overrides a running, completed or failed task', () => {
  for (const status of ['running', 'completed', 'blocked', 'failed', 'paused']) {
    const task = { status, phase: 'Wartet · PM-Rückfrage' };
    assert.equal(stageOf(task), status);
    assert.equal(matchesStatus(task, 'clarification'), false);
  }
});
