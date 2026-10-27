import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
  const ready=row({status:'queued',blockedReason:undefined});applyStoredCheckpoints([ready],[saved({ready_at:1})]);assert.equal(ready.status,'queued');assert.equal(ready.workerId,undefined);
  for(const entry of [saved({run_id:'older'}),saved({owner:'mac-b'}),saved({task_id:'other'})]){
    const value=row();applyStoredCheckpoints([value],[entry]);assert.equal(value.workerId,'mac-a');
  }
  const done=row({status:'completed'});applyStoredCheckpoints([done],[saved()]);assert.equal(done.status,'completed');
});

test('scheduled technical retries wait in the central queue for every workflow', () => {
  for (const workflow of ['newsletter', 'upload', 'translation', 'correction']) {
    for (const ready_at of [1, Date.now() + 1800000]) {
      for (const phase of ['Wartet · automatische Fortsetzung']) {
        const value = row({ workflow, status:'queued', phase, run:{id:'run-a',jobId:'task@1',taskId:'task'} });
        const entry = saved({task_id:'task@1',ready_at,blocker:{blockerState:'technisch_blockiert',
          blockerKind:'technical_failure',blockerReason:'Exact FileStage association failed',reasonCode:'technical_blocker'}});
        applyStoredCheckpoints([value],[entry]);
        assert.equal(value.status,'queued');
        assert.equal(value.blockedReason,undefined);
        assert.match(value.phase,/^Wartet/);
        assert.equal(value.workerId,undefined);
        assert.equal(entry.ready_at,ready_at);
        assert.equal(entry.owner,null);
      }
    }
  }
  // A finite legacy descriptor is also a queued continuation.
  const legacy=row();applyStoredCheckpoints([legacy],[saved({ready_at:1})]);
  assert.equal(legacy.status,'queued');assert.equal(legacy.blockedReason,undefined);
});

test('the retry inventory reads verified run state even when its retry time is finite', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state/newsletter-continuations/queue.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new DatabaseSync(file);db.exec('CREATE TABLE checkpoints(run_id,task_id,producer,owner,ready_at,digest,packed)');
  for (const state of ['technisch_blockiert','paused']) {
    const run_id='run-'+state, task_id='task-'+state;
    const value={schema:2,producer:'mac-a',runId:run_id,runs:[{run:{run_id,task_id,state,detail:'FileStage association failed'}}]};
    const packed=Buffer.concat([Buffer.from('RSART2\0'),zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)))]).toString('base64');
    db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?)').run(run_id,task_id,'mac-a',null,1,crypto.createHash('sha256').update(packed).digest('hex'),packed);
  }
  db.close();
  const entries=await readStoredCheckpoints(root);
  for (const entry of entries) {
    assert.equal(entry.blocker.blockerState,entry.run_id.slice(4));
    const value=row({status:'queued',run:{id:entry.run_id,jobId:entry.task_id}});
    applyStoredCheckpoints([value],[entry]);
    assert.equal(value.status,'queued');
  }
});

test('a new running attempt and completed work supersede the previous failed retry', () => {
  const entry=saved({run_id:'20261023T103732Z-job',task_id:'task@1',ready_at:1,blocker:{blockerState:'technisch_blockiert'}});
  for (const status of ['running','completed']) {
    const value=row({status,run:{id:'20261023T110000Z-job',jobId:'task@1'}});
    applyStoredCheckpoints([value],[entry]);assert.equal(value.status,status);assert.equal(value.workerId,'mac-a');
  }
  const delayed=row({status:'queued',run:{id:'20261023T100000Z-job',jobId:'task@1'}});
  applyStoredCheckpoints([delayed],[entry]);assert.equal(delayed.status,'queued');assert.equal(delayed.attemptId,entry.run_id);
});
test('status-bound newsletter, upload and translation jobs match their exact attempt and full job identity', () => {
  for(const jobId of ['abc@1792080437073','abc@1792080437073-klaviyo','abc@1792080437073-uebersetzung-en']){
    const value=row({id:'clickup:newsletter:abc',workflow:'newsletter',run:{id:'run-a',taskId:'abc',jobId}});
    applyStoredCheckpoints([value],[saved({task_id:jobId})]);assert.equal(value.workerId,undefined);
    const other=row({id:'clickup:newsletter:abc',workflow:'newsletter',run:{id:'run-a',taskId:'abc',jobId}});
    applyStoredCheckpoints([other],[saved({task_id:jobId.replace('1792080437073','1792080437074')})]);assert.equal(other.workerId,'mac-a');
  }
});
test('a newer saved blocked attempt supersedes delayed Slack metadata for exactly the same commission', () => {
  const value=()=>row({run:{id:'20261015T164302Z-job',jobId:'task@123',taskId:'task'}});
  const entry=saved({run_id:'20261015T170058Z-job',task_id:'task@123'});
  const current=value();applyStoredCheckpoints([current],[entry]);assert.equal(current.workerId,undefined);assert.equal(current.attemptId,entry.run_id);
  for(const overrides of [{status:'running'},{run:{id:'20261015T180058Z-job',jobId:'task@123',taskId:'task'}},
    {run:{id:'20261015T164302Z-job',jobId:'task@124',taskId:'task'}}]){
    const different={...value(),...overrides};applyStoredCheckpoints([different],[entry]);assert.equal(different.workerId,'mac-a');
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
test('a stored run without readable text never replaces a readable reason of the same commission', () => {
  const missing = { blockerReason: 'Der gespeicherte Vorgang enthält noch keinen lesbaren Blockergrund.', reasonCode: 'blocker_context_missing',
    responsibleRole: 'Technik', nextStep: 'x', blockerSource: 'checkpoint' };
  const key = 'Klaviyo-Quellenbindung: Klaviyo-Schlüssel fehlt im RS Hub (KEY_NOT_SET) für smileypack';
  const readable = row({ blockedReason: key }); applyStoredCheckpoints([readable], [saved({ blocker: missing })]);
  assert.equal(readable.blockedReason, key); assert.equal(readable.reasonCode, undefined);
  assert.equal(readable.status, 'blocked'); assert.match(readable.phase, /RS Hub gesichert/);
  const typed = { ...missing, blockerReason: 'Gesicherter Grund', reasonCode: 'technical_blocker' };
  const replaced = row({ blockedReason: key }); applyStoredCheckpoints([replaced], [saved({ blocker: typed })]);
  assert.equal(replaced.blockerReason, 'Gesicherter Grund'); assert.equal(replaced.reasonCode, 'technical_blocker');
  const empty = row({ blockedReason: undefined }); applyStoredCheckpoints([empty], [saved({ blocker: missing })]);
  assert.equal(empty.reasonCode, 'blocker_context_missing');
  // A newer stored attempt does not keep the older claim's typed owner.
  const newer = row({ blockerOwner: 'pm', run: { id: '20261015T164302Z-job', jobId: 'task@123', taskId: 'task' } });
  applyStoredCheckpoints([newer], [saved({ run_id: '20261015T170058Z-job', task_id: 'task@123' })]);
  assert.equal(newer.blockerOwner, undefined);
  const same = row({ blockerOwner: 'pm' }); applyStoredCheckpoints([same], [saved()]);
  assert.equal(same.blockerOwner, 'pm');
});
