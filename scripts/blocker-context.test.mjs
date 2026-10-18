import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {currentPm,checkpointBlocker,applyBlockerContexts,PM_FIELD_ID} from './blocker-context.mjs';
import {readStoredCheckpoints,applyStoredCheckpoints} from './newsletter-monitor-bridge.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const entry=(detail='Produktfeed fehlt.',extra={})=>{
 const doc={schema:2,producer:'mac-a',runId:'run-a',runs:[{run:{run_id:'run-a',task_id:'task@123-klaviyo',detail,state:'blockiert',finished_at:'2026-10-18T10:00:00Z'}}],files:[]};
 const packed=Buffer.concat([Buffer.from('RSART2\0'),zlib.brotliCompressSync(Buffer.from(JSON.stringify(doc)))]).toString('base64');
 return {run_id:'run-a',task_id:'task@123-klaviyo',producer:'mac-a',owner:null,ready_at:8640000000000000,digest:hash(packed),packed,...extra};
};
const task=name=>({id:'task',assignees:[{id:10,username:'Former owner'}],custom_fields:[{id:PM_FIELD_ID,type:'users',value:[{id:12,username:name}]}]});
test('a full durable blocker survives DB close/reopen without writing or restoring its job',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blocker-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'state/newsletter-continuations/queue.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});
 const db=new DatabaseSync(file);db.exec('CREATE TABLE checkpoints(run_id,task_id,producer,owner,ready_at,digest,packed)');
 const e=entry();db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?,?,?)').run(...Object.values(e));db.close();
 const before=hash(fs.readFileSync(file));
 for(let i=0;i<2;i++){
  const entries=await readStoredCheckpoints(root);const row={id:'upload',workflow:'upload',status:'blocked',workerId:'mac-a',url:'https://app.clickup.com/t/task',run:{id:'run-a',jobId:e.task_id,taskId:'task'}};
  applyStoredCheckpoints([row],entries);applyBlockerContexts([row],[task(i?'New PM':'Current PM')]);
  assert.equal(row.reasonCode,'product_feed_missing');assert.equal(row.pmOwner,i?'New PM':'Current PM');assert.equal(row.workerId,undefined);
  assert.match(row.nextStep,/Produktfeed/);assert.equal(row.blockerSourceHash,e.digest);assert.match(row.blockedReason,/Zuständig: Klaviyo-Technik/);
 }
 assert.equal(hash(fs.readFileSync(file)),before);assert.equal(fs.existsSync(path.join(root,'runs')),false);
});
test('digest, producer, run and commission identities are checked even with a warm metadata cache',()=>{
 const e=entry();assert.equal(checkpointBlocker(e).reasonCode,'product_feed_missing');
 for(const changed of [{digest:'a'.repeat(64)},{producer:'mac-b'},{run_id:'run-b'},{task_id:'task@124-klaviyo'},{packed:'invalid'}])assert.equal(checkpointBlocker({...e,...changed}).reasonCode,'blocker_context_unreadable');
});
test('current PM uses only the exact users field; absent/ambiguous fields never fall back to old assignees',()=>{
 assert.equal(currentPm(task('Ben')).pmOwner,'Ben');
 for(const custom_fields of [[],[{id:'other',name:'PM',type:'users',value:[{id:10,username:'Old'}]}],[...task('A').custom_fields,...task('B').custom_fields]])assert.deepEqual(currentPm({...task('A'),custom_fields}),{});
});
test('saved onboarding, placeholder and QA blockers have actionable distinct roles and codes',()=>{
 for(const [detail,code,role] of [['Kunde fehlt im RS Hub: Designbasis nicht freigegeben.','customer_setup_incomplete','PM und Design'],['Platzhalter [XX %]: Angebotswerte fehlen','approved_content_incomplete','PM'],['Endabnahme nach zwei Fixrunden nicht bestanden','quality_review_failed','Design und QA']]){
  const c=checkpointBlocker(entry(detail));assert.equal(c.reasonCode,code);assert.equal(c.responsibleRole,role);assert.ok(c.nextStep.length>25);
 }
});
test('unrelated or completed attempts do not borrow blocked state or previous ownership',()=>{
 const row={id:'upload',workflow:'upload',status:'completed',workerId:'mac-b',url:'https://app.clickup.com/t/task',run:{id:'new',taskId:'task',jobId:'task@124-klaviyo'}};
 const before=structuredClone(row);applyStoredCheckpoints([row],[{...entry(),blocker:checkpointBlocker(entry())}]);applyBlockerContexts([row],[task('PM')]);assert.deepEqual(row,before);
});
