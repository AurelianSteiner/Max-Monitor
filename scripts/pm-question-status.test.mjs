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
    assert.equal(current.status, 'queued');
    assert.equal(current.phase, 'Wartet · PM-Rückfrage');
    assert.equal(current.blockedReason, 'Q3: Gutscheincode?');
    assert.equal(current.blockerReason, 'Q3: Gutscheincode?');
    assert.equal(current.reasonCode, 'pm_decision_pending');
    assert.equal(current.responsibleRole, 'PM');
    assert.match(current.nextStep, /bestehenden Rückfragen-Thread/);
    assert.equal(current.attemptId, 'run1');
  }
});

test('an explicitly requeued checkpoint still exposes its own unanswered PM question', () => {
  const current=row('upload',{status:'queued',workerId:undefined,phase:'Wartet · Fortsetzung im RS Hub gesichert',run:undefined});
  applyPmQuestions([current],{sets:[set()]},new Map([[current.id,{id:'run1',taskId:'t1',workerId:'mac1'}]]));
  assert.equal(current.phase,'Wartet · PM-Rückfrage');assert.equal(current.reasonCode,'pm_decision_pending');
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
  assert.equal(current.reasonCode,'continuation_pending');assert.equal(current.responsibleRole,'Produktion');
  assert.match(current.nextStep,/gespeicherte PM-Antwort/);
  for (const overrides of [{sourceVersion:'old'},{revision:1},{state:'blocked'}]) {
    const current = row(); applyPmQuestions([current],{sets:[accepted],jobs:[{...job,...overrides}]});assert.equal(current.status,'blocked');
  }
});

test('a partial answer keeps every workflow in PM clarification until the remaining question is answered', () => {
  for (const [workflow,stage] of [['newsletter','newsletter'],['correction','korrektur'],['upload','klaviyo'],['translation','translation']]) {
    const current=row(workflow,workflow==='translation'?{id:'clickup:translation-de:t1'}:{});
    const partial=set(stage,{language:'DE',questions:[
      {id:'Q1',title:'Produkt behalten?',status:'accepted',revision:1},
      {id:'Q2',title:'Herkunftsangabe?',status:'open',revision:1},
    ]});
    const jobs=[{setId:'s1',questionId:'Q1',sourceVersion:'v1',revision:1,state:'queued'}];
    applyPmQuestions([current],{sets:[partial],jobs});
    assert.equal(current.phase,'Wartet · PM-Rückfrage',workflow);
    assert.equal(current.status,'queued');assert.equal(current.reasonCode,'pm_decision_pending');
    assert.equal(current.responsibleRole,'PM');assert.equal(current.blockedReason,'Q2: Herkunftsangabe?');
    assert.match(current.nextStep,/Q2: Herkunftsangabe/);
    partial.questions[1].status='accepted';jobs.push({...jobs[0],questionId:'Q2'});
    const ready=row(workflow,workflow==='translation'?{id:'clickup:translation-de:t1'}:{});
    applyPmQuestions([ready],{sets:[partial],jobs});
    assert.equal(ready.phase,'Wartet auf Fortsetzung');assert.equal(ready.reasonCode,'continuation_pending');
  }
});

test('a retired historical question set cannot hide the active replacement on the same source run', () => {
  const current=row();applyPmQuestions([current],{sets:[set('klaviyo',{id:'retired',questions:[{id:'Q3',status:'replaced'}]}),set()]});
  assert.equal(current.status,'queued');assert.equal(current.blockedReason,'Q3: Gutscheincode?');
});

test('successive PM follow-ups ignore answered journals already dispatched to the same head run', () => {
  for (const [workflow, stage] of [['newsletter','newsletter'], ['correction','korrektur'], ['upload','klaviyo'], ['translation','translation']]) {
    for (const round of [2, 3, 4]) {
      const old = Array.from({ length: round - 1 }, (_, i) => set(stage, { id: `old${i}`, runId: `previous${i}`,
        headRunId: 'run1', language: 'DE', questions: [{ id: `Q${i + 1}`, title: 'Ersatz verwenden', status: 'accepted', revision: 1 }] }));
      const followup = set(stage, { id: 'followup', language: 'DE',
        questions: [{ id: `Q${round}`, title: 'Welches Ersatzprodukt?', status: 'open', revision: 1 }] });
      const jobs = old.map(s => ({ setId: s.id, questionId: s.questions[0].id, sourceVersion: s.sourceVersion,
        revision: 1, state: 'dispatched', dispatchRunId: 'run1' }));
      for (const sets of [[...old, followup], [followup, ...old].reverse(), [followup, ...old]]) {
        const snapshot = JSON.stringify({ sets, jobs });
        const current = row(workflow, workflow === 'translation' ? { id: 'clickup:translation-de:t1' } : {});
        applyPmQuestions([current], { sets, jobs });
        assert.equal(current.phase, 'Wartet · PM-Rückfrage', `${workflow}, round ${round}`);
        assert.equal(current.reasonCode, 'pm_decision_pending');
        assert.equal(current.blockedReason, `Q${round}: Welches Ersatzprodukt?`);
        assert.equal(current.responsibleRole, 'PM');
        assert.equal(JSON.stringify({ sets, jobs }), snapshot, 'history and answers remain unchanged');
      }
    }
  }
});

test('an answered follow-up queues its continuation despite its dispatched predecessor', () => {
  const previous = set('newsletter', { id: 'previous', runId: 'before', headRunId: 'run1',
    questions: [{ id: 'Q1', title: 'Ersatz verwenden?', status: 'accepted', revision: 1 }] });
  const followup = set('newsletter', { id: 'followup', questions: [{ id: 'Q2', title: 'Welches Produkt?', status: 'accepted', revision: 2 }] });
  const jobs = [
    { setId: 'previous', questionId: 'Q1', sourceVersion: 'v1', revision: 1, state: 'dispatched', dispatchRunId: 'run1' },
    { setId: 'followup', questionId: 'Q2', sourceVersion: 'v1', revision: 2, state: 'queued' },
  ];
  const current = row('newsletter');
  applyPmQuestions([current], { sets: [previous, followup], jobs });
  assert.equal(current.phase, 'Wartet auf Fortsetzung');
  assert.equal(current.reasonCode, 'continuation_pending');
  for (const overrides of [{ revision: 1 }, { sourceVersion: 'obsolete' }, { state: 'dispatched' }]) {
    const blocked = row('newsletter');
    applyPmQuestions([blocked], { sets: [previous, followup], jobs: [jobs[0], { ...jobs[1], ...overrides }] });
    assert.equal(blocked.status, 'blocked', 'obsolete or dispatched answers cannot disguise a technical failure');
  }
});

test('a source-invalidated answer shows the actual source check instead of an old missing-product blocker', () => {
  const old = set('newsletter', { id: 'old', runId: 'previous', headRunId: 'run1',
    questions: [{ id: 'Q1', title: 'Ersatzprodukt?', status: 'accepted', revision: 1 }] });
  const current = set('newsletter', { id: 'current', sourceChange: {
    reason: 'Der Figma-Rahmen wurde seit der gespeicherten Quellenprüfung geändert. Die gespeicherte PM-Antwort bleibt erhalten.', at: Date.parse('2026-10-14T09:00:00Z') },
    questions: [{ id: 'Q2', title: 'Welches Produkt?', status: 'replaced', revision: 2, answer: { value: 'Govinda' } }] });
  const source = { sets: [old, current], jobs: [
    { setId: 'old', questionId: 'Q1', sourceVersion: 'v1', state: 'dispatched', revision: 1 },
    { setId: 'current', questionId: 'Q2', sourceVersion: 'v1', state: 'blocked', revision: 1 },
  ] };
  for (let refresh = 0; refresh < 3; refresh++) {
    const next = row('newsletter', { blockedReason: 'Ersatzprodukt fehlt', reasonCode: 'blocker_review_required' });
    applyPmQuestions([next], source);
    assert.equal(next.status, 'blocked'); assert.equal(next.phase, 'Blockiert · Quellenabgleich');
    assert.equal(next.reasonCode, 'preparation_source_changed'); assert.equal(next.responsibleRole, 'Technik');
    assert.match(next.blockedReason, /PM-Antwort gespeichert \(Q2: Govinda\)/);
    assert.match(next.blockedReason, /Figma-Rahmen/); assert.doesNotMatch(next.blockedReason, /Ersatzprodukt fehlt/);
  }
  const reason = current.sourceChange.reason;
  current.sourceChange.reason = 'Der Briefingtext wurde nach der PM-Antwort geändert.';
  const business = row('newsletter'); applyPmQuestions([business], source);
  assert.equal(business.status, 'queued'); assert.equal(business.phase, 'Wartet · PM-Rückfrage');
  assert.equal(business.reasonCode, 'pm_source_changed'); assert.equal(business.responsibleRole, 'PM');
  current.sourceChange.reason = reason;
  current.questions[0].status = 'accepted'; current.questions[0].revision = 1; delete current.sourceChange;
  source.jobs[1].state = 'queued';
  const resumed = row('newsletter'); applyPmQuestions([resumed], source);
  assert.equal(resumed.phase, 'Wartet auf Fortsetzung'); assert.equal(resumed.reasonCode, 'continuation_pending');
  const foreign = row('newsletter', { run: { id: 'newer', taskId: 't1' } });
  applyPmQuestions([foreign], source); assert.equal(foreign.status, 'blocked');
});

test('portable PM dispatch remains waiting while the central checkpoint publication catches up', () => {
  const previous = set('newsletter', { id: 'old', runId: 'earlier', headRunId: 'run1',
    questions: [{ id: 'Q1', status: 'accepted', revision: 1 }] });
  const current = set('newsletter', { id: 'current', questions: [{ id: 'Q2', status: 'accepted', revision: 1 }] });
  const job = { setId: 'current', questionId: 'Q2', sourceVersion: 'v1', revision: 1,
    state: 'dispatched', runId: 'run1', dispatchRunId: 'run1' };
  const source = { sets: [previous, current], jobs: [{ ...job, setId: 'old', questionId: 'Q1', runId: 'earlier' }, job] };
  for (let poll = 0; poll < 3; poll++) {
    const next = row('newsletter', { blockedReason: 'Ersatzprodukt fehlt' }); applyPmQuestions([next], source);
    assert.equal(next.phase, 'Wartet auf Fortsetzung'); assert.equal(next.reasonCode, 'continuation_pending');
    assert.equal(next.blockedReason, undefined);
  }
  for (const overrides of [{ dispatchRunId: 'executed-run' }, { runId: 'other' }, { revision: 2 }, { sourceVersion: 'old' }]) {
    const next = row('newsletter'); applyPmQuestions([next], { ...source, jobs: [{ ...job, ...overrides }] });
    assert.equal(next.status, 'blocked', 'an executed or foreign dispatch cannot hide a new technical blocker');
  }
});

// Fehleraudit 21.10.2026 (Teaworld 19.10., Kamelur 20.10.): 29 of 34 saved answers
// were taken over within 1.8 min; two stayed unclaimed for about two hours unnoticed.
test('a complete saved answer left unclaimed for 15 min is a technical stall naming the owner Mac', () => {
  const answeredAt = Date.parse('2026-10-19T12:58:16Z');
  const stalled = (overrides = {}) => set('newsletter', { workerId: 'macworker-5-schwarz',
    questions: [{ id: 'Q1', title: 'Ersatzprodukt?', status: 'accepted', revision: 1, answer: { value: 'Govinda' } }], ...overrides });
  const job = { setId: 's1', questionId: 'Q1', sourceVersion: 'v1', revision: 1, state: 'queued', createdAt: answeredAt };
  const current = () => row('newsletter', { workerId: 'macworker-5-schwarz' });
  for (const minutes of [15, 16, 111]) {
    const next = current();
    applyPmQuestions([next], { sets: [stalled()], jobs: [job] }, new Map(), { now: answeredAt + minutes * 60000 });
    assert.equal(next.status, 'blocked', `${minutes} min`); assert.equal(next.phase, 'Blockiert · PM-Antwort nicht übernommen');
    assert.equal(next.reasonCode, 'continuation_stalled'); assert.equal(next.responsibleRole, 'Technik');
    // A stable answer time, not a minute count: the diagnosis binds operator decisions (fleet.js taskVersion).
    assert.equal(next.blockedReason, 'Gespeicherte PM-Antwort seit 19.10., 14:58 nach über 15 min nicht übernommen (Besitzer: Schwarz). Antwort: Q1: Govinda');
    assert.equal(next.blockerReason, next.blockedReason); assert.match(next.nextStep, /^Auf Schwarz /);
    assert.doesNotMatch(`${next.blockedReason} ${next.nextStep}`, /macworker-5-schwarz/);
    assert.equal(next.updatedAt, '2026-10-19T13:13:16.000Z'); assert.equal(next.attemptId, 'run1');
  }
  for (const minutes of [0.2, 1.8, 14.9]) {
    const next = current();
    applyPmQuestions([next], { sets: [stalled()], jobs: [job] }, new Map(), { now: answeredAt + minutes * 60000 });
    assert.equal(next.status, 'queued', `${minutes} min`); assert.equal(next.phase, 'Wartet auf Fortsetzung');
    assert.equal(next.reasonCode, 'continuation_pending'); assert.equal(next.responsibleRole, 'Produktion');
  }
  // The newest answer of the set starts the clock (Bos Food: Q1 waited 26 h for Q2).
  const late = { ...job, questionId: 'Q2', createdAt: answeredAt + 26 * 3600000 };
  const both = stalled({ questions: [...stalled().questions, { id: 'Q2', title: 'Herkunft?', status: 'accepted', revision: 1, answer: { value: 'EU' } }] });
  const fresh = current(); applyPmQuestions([fresh], { sets: [both], jobs: [job, late] }, new Map(), { now: late.createdAt + 5 * 60000 });
  assert.equal(fresh.reasonCode, 'continuation_pending');
  // An unknown answer time never escalates.
  const undated = current(); applyPmQuestions([undated], { sets: [stalled()], jobs: [{ ...job, createdAt: undefined }] }, new Map(), { now: answeredAt + 3600000 });
  assert.equal(undated.reasonCode, 'continuation_pending');
});

test('an old answer still waiting for a person or already taken over is no stall', () => {
  const answeredAt = Date.parse('2026-10-19T12:58:16Z'), now = answeredAt + 26 * 3600000;
  const job = { setId: 's1', questionId: 'Q1', sourceVersion: 'v1', revision: 1, state: 'queued', createdAt: answeredAt };
  const accepted = { id: 'Q1', title: 'Produkt behalten?', status: 'accepted', revision: 1, answer: { value: 'Ja' } };
  // Partial answer: the remaining question stays a PM decision.
  const partial = row('newsletter');
  applyPmQuestions([partial], { sets: [set('newsletter', { questions: [accepted, { id: 'Q2', title: 'Herkunftsangabe?', status: 'open', revision: 1 }] })], jobs: [job] }, new Map(), { now });
  assert.equal(partial.status, 'queued'); assert.equal(partial.phase, 'Wartet · PM-Rückfrage'); assert.equal(partial.reasonCode, 'pm_decision_pending');
  // The worker claims only when every set of the order is settled (pm-questions.js sameTaskReady).
  for (const sibling of [set('translation', { id: 's2', language: 'FR', runId: 'other', questions: [{ id: 'Q1', title: 'Code?', status: 'open', revision: 1 }] }),
    set('translation', { id: 's2', language: 'FR', runId: 'other', questions: [{ id: 'Q1', status: 'conflict', revision: 2 }] })]) {
    const waiting = row('translation', { id: 'clickup:translation-en:t1' });
    applyPmQuestions([waiting], { sets: [set('translation', { language: 'EN', questions: [accepted] }), sibling], jobs: [job] }, new Map(), { now });
    assert.equal(waiting.reasonCode, 'continuation_pending', sibling.questions[0].status);
  }
  const conflict = row('newsletter');
  applyPmQuestions([conflict], { sets: [set('newsletter', { questions: [accepted, { id: 'Q2', status: 'conflict', revision: 2 }] })], jobs: [job] }, new Map(), { now });
  assert.equal(conflict.reasonCode, 'continuation_pending');
  // A started claim or dispatch is progress of the continuation itself: a dispatch to its own
  // continuation run, or one to the asking run whose checkpoint is stored in the RS Hub.
  for (const [state, dispatchRunId, phase] of [['running', 'run1'], ['uncertain', 'run1'], ['dispatched', 'run2'],
    ['dispatched', 'run1', 'Blockiert · Fortschritt im RS Hub gesichert']]) {
    const claimed = row('newsletter', phase ? { phase } : {});
    applyPmQuestions([claimed], { sets: [set('newsletter', { questions: [accepted, { ...accepted, id: 'Q2' }] })],
      jobs: [job, { ...job, questionId: 'Q2', state, runId: 'run1', dispatchRunId }] }, new Map(), { now });
    assert.equal(claimed.reasonCode, 'continuation_pending', `${state} ${dispatchRunId}`);
  }
  // A test or archived journal of the same order never holds a production answer back.
  const unrelated = row('newsletter');
  applyPmQuestions([unrelated], { sets: [set('newsletter', { questions: [accepted] }), set('newsletter', { id: 's2', mode: 'test', runId: 'x', questions: [{ id: 'Q9', status: 'open', revision: 1 }] }),
    set('newsletter', { id: 's3', archivedAt: 1, runId: 'y', questions: [{ id: 'Q8', status: 'open', revision: 1 }] })], jobs: [job] }, new Map(), { now });
  assert.equal(unrelated.reasonCode, 'continuation_stalled'); assert.match(unrelated.blockedReason, /Besitzer: mac1\)/);
});

// Fehleraudit 30.10.2026 (Gartenfachmarkt24 86c91vafx): the PM answered „streichen“ at 22:14;
// the answer was dispatched for the central queue, but the 537 MB checkpoint was never
// published. The queued row without phase (owner PM) showed no reason at all.
test('an answer dispatched to the asking run but never stored or started is a visible stall', () => {
  const answeredAt = Date.parse('2026-10-29T21:14:53.762Z');
  const answered = set('newsletter', { workerId: 'macbook-2', runId: 'run1', headRunId: 'run1',
    questions: [{ id: 'Q1', title: 'Produkt 3 streichen?', status: 'accepted', revision: 1, answer: { value: 'streichen' } }] });
  const job = { setId: 's1', questionId: 'Q1', sourceVersion: 'v1', revision: 1, state: 'dispatched', runId: 'run1', dispatchRunId: 'run1', createdAt: answeredAt };
  const held = () => row('newsletter', { status: 'queued', workerId: 'macbook-2', blockerOwner: 'pm' });
  const late = held(); applyPmQuestions([late], { sets: [answered], jobs: [job] }, new Map(), { now: answeredAt + 3 * 3600000 });
  assert.equal(late.status, 'blocked'); assert.equal(late.phase, 'Blockiert · PM-Antwort nicht übernommen');
  assert.equal(late.reasonCode, 'continuation_stalled'); assert.equal(late.responsibleRole, 'Technik');
  assert.match(late.blockedReason, /nicht übernommen \(Besitzer: Blau\)\. Antwort: Q1: streichen$/);
  const early = held(); applyPmQuestions([early], { sets: [answered], jobs: [job] }, new Map(), { now: answeredAt + 5 * 60000 });
  assert.equal(early.status, 'queued'); assert.equal(early.phase, 'Wartet auf Fortsetzung');
  // An old answer dispatched just now (e.g. after a question the run decided itself) is no stall yet.
  const fresh = held(); applyPmQuestions([fresh], { sets: [answered], jobs: [{ ...job, dispatchedAt: answeredAt + 3 * 3600000 - 60000 }] }, new Map(), { now: answeredAt + 3 * 3600000 });
  assert.equal(fresh.phase, 'Wartet auf Fortsetzung');
  // A stored central checkpoint waits for a free Mac; a continuation run is progress.
  const stored = row('newsletter', { status: 'queued', phase: 'Wartet · Fortsetzung im RS Hub gesichert', workerId: 'macbook-2' });
  applyPmQuestions([stored], { sets: [answered], jobs: [job] }, new Map(), { now: answeredAt + 3 * 3600000 });
  assert.equal(stored.reasonCode, 'continuation_pending');
  const continued = held(); applyPmQuestions([continued], { sets: [answered], jobs: [{ ...job, dispatchRunId: 'run2' }] }, new Map(), { now: answeredAt + 3 * 3600000 });
  assert.equal(continued.status, 'queued'); assert.equal(continued.reasonCode, undefined, 'a row without own question binding stays as it is');
  // Only a row the PM owns; an ordinary queued row stays untouched.
  const plain = row('newsletter', { status: 'queued', workerId: 'macbook-2' });
  applyPmQuestions([plain], { sets: [answered], jobs: [job] }, new Map(), { now: answeredAt + 3 * 3600000 });
  assert.equal(plain.status, 'queued'); assert.equal(plain.reasonCode, undefined);
});

test('archived journals cannot replace an active decision or revive a retired question', () => {
  const old=set('klaviyo',{id:'archived',archivedAt:1234});
  const only=row();applyPmQuestions([only],{sets:[old]});assert.equal(only.status,'blocked');
  const current=row();applyPmQuestions([current],{sets:[old,set()]});
  assert.equal(current.reasonCode,'pm_decision_pending');assert.equal(current.blockedReason,'Q3: Gutscheincode?');
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
