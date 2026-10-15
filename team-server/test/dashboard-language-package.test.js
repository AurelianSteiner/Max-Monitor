const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.check = { stageOf, matchesStatus, completionLabel, runningPackage, workerName, tasks, setTasks: items => snapshot = { queue: { tasks: items } } }; return;\n' + marker), context);
const ui = context.check;
const master = { id: 'clickup:newsletter:de1', workflow: 'newsletter', packageId: 'de1', status: 'running', workerId: 'mac-worker-6-64d66918' };
const en = { id: 'clickup:translation-en:de1', workflow: 'translation', status: 'queued', tags: ['en translation'] };

test('waiting EN belongs to Running while its package runs; execution ownership stays unchanged', () => {
  ui.setTasks([master, en]);
  assert.equal(ui.stageOf(en), 'running');
  assert.equal(ui.matchesStatus(en, 'running'), true);
  assert.equal(ui.matchesStatus(en, 'queued'), false);
  assert.equal(ui.completionLabel(en), 'Paket läuft');
  assert.equal(en.status, 'queued');
  assert.equal(en.workerId, undefined);
  assert.equal(ui.workerName(master.workerId), 'MacWorker 6');
});

test('explicit source binding joins separate EN tasks, never matching titles alone', () => {
  const separate = { ...en, id: 'clickup:newsletter:en2', workflow: 'newsletter', packageId: 'de1', language: 'en' };
  ui.setTasks([master, separate]);
  assert.equal(ui.stageOf(separate), 'running');
  const unrelated = { ...separate, packageId: 'other', title: master.title };
  assert.notEqual(ui.stageOf(unrelated), 'running');
});

test('blocked, paused, completed and PM states remain outside a running package', () => {
  ui.setTasks([master, en]);
  for (const status of ['blocked', 'failed', 'paused', 'completed', 'clarification']) {
    assert.equal(ui.stageOf({ ...en, status }), status);
  }
  assert.notEqual(ui.stageOf({ ...en, blockedReason: 'Freigabe fehlt', phase: 'Wartet · PM-Rückfrage' }), 'running');
  assert.notEqual(ui.stageOf({ ...en, phase: 'Pausiert · automatische Fortsetzung' }), 'running');
  assert.notEqual(ui.stageOf({ ...en, workflow: 'upload' }), 'running');
  ui.setTasks([{ ...master, status: 'completed' }, en]);
  assert.notEqual(ui.stageOf(en), 'running');
  ui.setTasks([{ ...master, workerId: null }, en]);
  assert.notEqual(ui.stageOf(en), 'running');
});

test('an EN mail already in review does not leave an idle duplicate in Waiting', () => {
  const completed = { ...master, title: 'EN | Herbst', language: 'en', status: 'completed', sourceStatus: 'approval extern' };
  ui.setTasks([completed, en]);
  assert.deepEqual(Array.from(ui.tasks(), task => task.id), [completed.id]);
  for (const change of [{ status: 'blocked' }, { workerId: 'another-mac' }, { blockedReason: 'Freigabe fehlt' }]) {
    ui.setTasks([completed, { ...en, ...change }]);
    assert.equal(ui.tasks().length, 2);
  }
  for (const change of [{ language: 'de' }, { id: 'clickup:newsletter:another' }, { sourceStatus: 'pre-gen' }]) {
    ui.setTasks([{ ...completed, ...change }, en]);
    assert.equal(ui.tasks().length, 2);
  }
});
