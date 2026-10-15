import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readStoredCheckpoints, applyStoredCheckpoints } from './newsletter-monitor-bridge.mjs';

const row = extra => ({ id:'correction:korrektur-cu-task@1-intern', workflow:'correction', status:'blocked', workerId:'mac-a',
  blockedReason:'Saved technical blocker', phase:'Korrektur blockiert', run:{id:'run-a',taskId:'task'}, ...extra });
const saved = extra => ({run_id:'run-a',task_id:'korrektur-cu-task@1-intern',producer:'mac-a',owner:null,ready_at:8640000000000000,...extra});

test('a saved blocker stays blocked centrally and no longer belongs to its producer Mac', () => {
  const value = row(); applyStoredCheckpoints([value],[saved()]);
  assert.equal(value.workerId,undefined);assert.equal(value.status,'blocked');
  assert.equal(value.blockedReason,'Saved technical blocker');assert.match(value.phase,/RS Hub gesichert/);
});
test('PM questions stay waiting, runnable work waits centrally, and unrelated attempts retain their owner', () => {
  const question=row({status:'queued',phase:'Wartet · PM-Rückfrage'});applyStoredCheckpoints([question],[saved()]);
  assert.equal(question.phase,'Wartet · PM-Rückfrage');assert.equal(question.workerId,undefined);
  const ready=row();applyStoredCheckpoints([ready],[saved({ready_at:1})]);assert.equal(ready.status,'queued');assert.equal(ready.workerId,undefined);
  for(const entry of [saved({run_id:'older'}),saved({owner:'mac-b'}),saved({task_id:'other'})]){
    const value=row();applyStoredCheckpoints([value],[entry]);assert.equal(value.workerId,'mac-a');
  }
  const done=row({status:'completed'});applyStoredCheckpoints([done],[saved()]);assert.equal(done.status,'completed');
});
test('status-bound newsletter, upload and translation jobs match their exact attempt and full job identity', () => {
  for(const jobId of ['abc@1792080437073','abc@1792080437073-klaviyo','abc@1792080437073-uebersetzung-en']){
    const value=row({id:'clickup:newsletter:abc',workflow:'newsletter',run:{id:'run-a',taskId:'abc',jobId}});
    applyStoredCheckpoints([value],[saved({task_id:jobId})]);assert.equal(value.workerId,undefined);
    const other=row({id:'clickup:newsletter:abc',workflow:'newsletter',run:{id:'run-a',taskId:'abc',jobId}});
    applyStoredCheckpoints([other],[saved({task_id:jobId.replace('1792080437073','1792080437074')})]);assert.equal(other.workerId,'mac-a');
  }
});
test('central inventory reads only unowned descriptors and never creates a missing database', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(await readStoredCheckpoints(root),[]);assert.equal(fs.existsSync(path.join(root,'state')),false);
  const file=path.join(root,'state/newsletter-continuations/queue.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new DatabaseSync(file);db.exec('CREATE TABLE checkpoints(run_id,task_id,producer,owner,ready_at)');
  db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?)').run('run-a','task','mac-a',null,1);
  db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?)').run('run-b','other','mac-a','mac-b',1);db.close();
  assert.deepEqual((await readStoredCheckpoints(root)).map(e=>e.run_id),['run-a']);
});
