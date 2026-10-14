import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQueue,DEFAULT_WORKFLOWS,completionEvidence,contentKind} from './newsletter-monitor-bridge.mjs';
const now=Date.parse('2026-10-14T17:00:00Z');
const task={id:'abc',name:'Mail',date_updated:String(now),tags:['pre gen · fertig'],status:{status:'approval intern'}};
const claim={taskId:'abc',workflow:'newsletter',state:'final',outcome:'completed',heartbeat:Date.parse('2026-10-12T12:00:00Z')/1000,ts:'1791800000.001',runId:'first',workerId:'mac-1'};
test('a later source edit keeps the saved successful completion date',()=>{
 const [row]=buildQueue([task],[claim],DEFAULT_WORKFLOWS,{now});
 assert.equal(row.updatedAt,'2026-10-14T17:00:00.000Z');
 assert.equal(row.completedAt,'2026-10-12T12:00:00.000Z');
 assert.equal(row.completionSource,'slack');
});
test('a finished tag alone never supplies an invented completion timestamp',()=>{
 const [row]=buildQueue([task],[],DEFAULT_WORKFLOWS,{now});
 assert.equal(row.completedAt,undefined);
 assert.equal(row.completionSource,'clickup');
});
test('new attempts and failures do not borrow the previous attempt success',()=>{
 for(const extra of [{state:'running',outcome:undefined},{state:'final',outcome:'blocked'}])
  assert.deepEqual(completionEvidence([claim,{...claim,ts:'1792000000.001',...extra}]),{});
 assert.equal(completionEvidence([{...claim,state:'released'}]).completedAt,'2026-10-12T12:00:00.000Z');
 assert.deepEqual(completionEvidence([{...claim,heartbeat:NaN}]),{});
 assert.deepEqual(completionEvidence([{...claim,completionTimestampKnown:false}]),{});
});
test('content types use briefing fields, including the zero-valued flow dropdown',()=>{
 assert.equal(contentKind({...task,custom_fields:[{name:'Flow Type',value:0}]}),'flow');
 assert.equal(contentKind({...task,name:'Anmelde Pop-up'}),'popup');
 assert.equal(contentKind({...task,name:'Flower Power'}),'newsletter');
});
