import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyPmQuestions, readPmQuestions } from './pm-question-status.mjs';

const row = (workflow = 'upload', overrides = {}) => ({ id: 'clickup:upload:t1', workflow,
  status: 'blocked', workerId: 'mac1', updatedAt: '2026-10-13T10:00:00Z',
  run: { id: 'run1', taskId: 't1' }, ...overrides });
const set = (stage = 'klaviyo', overrides = {}) => ({ id: 's1', mode: 'production', stage,
  workerId: 'mac1', taskId: 't1', runId: 'run1', threadTs: '1791888023.663269',
  createdAt: Date.parse('2026-10-13T11:00:00Z'), sourceVersion: 'v1',
  questions: [{ id: 'Q3', title: 'Gutscheincode?', status: 'open', revision: 2 }], ...overrides });

test('all production kinds show their actual unanswered questions, including upload and language binding', () => {
  for (const [workflow, stage, id, language] of [['newsletter','newsletter'], ['correction','korrektur'],
    ['upload','klaviyo'], ['translation','translation','clickup:translation-en:t1','EN']]) {
    const current = row(workflow, id ? { id } : {});
    applyPmQuestions([current], { sets: [set(stage, { language })] });
    assert.equal(current.status, 'clarification');
    assert.equal(current.phase, 'Klärung nötig');
    assert.equal(current.blockedReason, 'Q3: Gutscheincode?');
    assert.equal(current.attemptId, 'run1');
  }
});

test('another run, worker, stage, task, language, test or retired question cannot change the queue', () => {
  for (const overrides of [{ runId:'old' }, { workerId:'other' }, { taskId:'other' },
    { stage:'newsletter' }, { mode:'test' }, { questions:[{id:'Q3',status:'replaced'}] }]) {
    const current = row(); applyPmQuestions([current], { sets:[set('klaviyo', overrides)] });
    assert.equal(current.status,'blocked');
  }
  const current = row('translation',{id:'clickup:translation-fr:t1'});
  applyPmQuestions([current], {sets:[set('translation',{language:'EN'})]});
  assert.equal(current.status,'blocked');
  for (const status of ['running','queued','completed']) {
    const current = row('upload',{status});applyPmQuestions([current],{sets:[set()]});assert.equal(current.status,status);
  }
  const ambiguous = row(); applyPmQuestions([ambiguous],{sets:[set(),set('klaviyo',{id:'s2'})]});assert.equal(ambiguous.status,'blocked');
});

test('accepted current answers show queued continuation while capacity is occupied; obsolete jobs do not', () => {
  const accepted = set('klaviyo',{questions:[{id:'Q3',title:'Code?',status:'accepted',revision:2}]});
  const job = {setId:'s1',questionId:'Q3',sourceVersion:'v1',revision:2,state:'queued'};
  const current = row(); applyPmQuestions([current],{sets:[accepted],jobs:[job]});
  assert.equal(current.status,'queued');assert.equal(current.phase,'Wartet auf Fortsetzung');
  for (const overrides of [{sourceVersion:'old'},{revision:1},{state:'blocked'}]) {
    const current = row(); applyPmQuestions([current],{sets:[accepted],jobs:[{...job,...overrides}]});assert.equal(current.status,'blocked');
  }
});

test('a retired historical question set cannot hide the active replacement on the same source run', () => {
  const current=row();applyPmQuestions([current],{sets:[set('klaviyo',{id:'retired',questions:[{id:'Q3',status:'replaced'}]}),set()]});
  assert.equal(current.status,'clarification');assert.equal(current.blockedReason,'Q3: Gutscheincode?');
});

test('the monitor reads the durable journal without modifying it and uses the authoritative job state', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pm-status-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.sqlite'),db=new DatabaseSync(file);
  db.exec('CREATE TABLE question_sets(doc TEXT); CREATE TABLE question_jobs(doc TEXT,state TEXT);');
  db.prepare('INSERT INTO question_sets VALUES (?)').run(JSON.stringify(set()));
  db.prepare('INSERT INTO question_jobs VALUES (?,?)').run(JSON.stringify({state:'running',setId:'s1'}),'queued');db.close();
  const before=fs.readFileSync(file);const state=readPmQuestions(file);
  assert.equal(state.sets[0].id,'s1');assert.equal(state.jobs[0].state,'queued');assert.deepEqual(fs.readFileSync(file),before);
  assert.deepEqual(readPmQuestions(path.join(dir,'absent.sqlite')),{sets:[],jobs:[]});
});
