const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real status projection used by navigation, badges and pipeline.
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, { dataset: {}, replaceChildren() {} });
  return elements.get(id);
}
const context = { document: { getElementById: element, createElement: () => ({ dataset: {}, append() {} }) }, window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.pmUnderTest = { stageOf, matchesStatus, tasks, completionLabel, renderQueue,\n'
  + '    setState(items, options = {}) {\n'
  + '      snapshot = { queue: { tasks: items, source: { lastSuccessAt: "2026-10-18T10:00:00Z" } }, machines: [] };\n'
  + '      statusFilter = options.status || "clarification"; query = options.query || "";\n'
  + '    } }; return;\n' + marker), context);
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

test('PM projection preserves language package behavior and review duplicate filtering', () => {
  const { setState, tasks, completionLabel } = context.pmUnderTest;
  const base = { id: 'clickup:newsletter:abc', workflow: 'newsletter', status: 'running', workerId: 'mac-1' };
  const language = { id: 'clickup:translation-en:abc', workflow: 'translation', status: 'queued', phase: 'Wartet' };
  setState([base, language]);
  assert.equal(stageOf(language), 'running');
  assert.equal(completionLabel(language), 'Paket läuft');
  const question = { ...language, phase: 'Wartet · PM-Rückfrage' };
  setState([base, question]);
  assert.equal(stageOf(question), 'clarification');
  assert.equal(completionLabel(question), 'PM Rückfragen');
  const reviewed = { ...base, status: 'completed', language: 'en', sourceStatus: 'approval intern' };
  setState([reviewed, language]);
  assert.equal(tasks().length, 1);
  setState([reviewed, question]);
  assert.equal(tasks().length, 2);
});

test('PM empty state distinguishes no open questions from questions hidden by filters', () => {
  const { setState, renderQueue } = context.pmUnderTest;
  const pm = { id: 'question', title: 'Offene Frage', status: 'clarification' };
  setState([]);
  renderQueue([]);
  assert.equal(element('queue-empty').textContent, 'Aktuell sind keine PM-Rückfragen offen.');
  setState([pm], { query: 'nicht vorhanden' });
  renderQueue([pm]);
  assert.equal(element('queue-empty').textContent, 'Keine PM-Rückfragen für diese Filter. Entferne die Suche oder Filter, um alle PM-Rückfragen zu sehen.');
  setState([], { status: 'queued' });
  renderQueue([]);
  assert.equal(element('queue-empty').textContent, 'Keine Aufgaben für diesen Filter.');
});

test('dashboard HTML names the existing clarification tab PM Rückfragen after Blockiert', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
  assert.match(html, /data-status="blocked"[\s\S]*data-status="clarification" title="Alle Aufgaben mit offenen PM-Rückfragen">\s*PM Rückfragen/);
});
