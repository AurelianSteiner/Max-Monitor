import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, collectSnapshot, DEFAULT_WORKFLOWS, parseClaim } from './newsletter-monitor-bridge.mjs';

const now=Date.parse('2026-10-18T22:00:00Z');
const source=(status='revision intern',extra={})=>({id:'t1',name:'Mail',status:{status},statusSince:'1000',tags:[],...extra});
const claim=(extra={})=>parseClaim({ts:'1792360700.000001',text:'*Korrektur · Kunde*\nNeue Aufgabe: <https://app.clickup.com/t/t1|Mail>',
  reactions:[{name:'x'}],metadata:{event_type:'ai_korrektur_claim',event_payload:{task_id:'korrektur-cu-t1@1000-intern',
    run_id:'run1',worker:'macbook-1',state:'final',heartbeat:now/1000,...extra}}});
const corrections=(task,c)=>buildQueue(task?[task]:[],[c],DEFAULT_WORKFLOWS,{now}).filter(r=>r.workflow==='correction'&&r.attemptId===c.runId);

test('an unfinished terminal correction belongs only to its current status epoch and manual authority',()=>{
  const c=claim();assert.equal(corrections(source(),c)[0].status,'blocked');
  for(const raw of [source('approval intern'),source('revision extern'),source('revision intern',{statusSince:'2000'}),
    source('revision intern',{tags:[{name:'manuell'}]})]) assert.equal(corrections(raw,c).length,0);
});

test('actual live writers stay visible after a source move, and a completed exact run stays history',()=>{
  const live=claim({state:'running'});assert.equal(corrections(source('approval intern'),live)[0].status,'running');
  assert.equal(corrections(source('revision intern',{tags:[{name:'manuell'}]}),live)[0].status,'running');
  const done={...claim(),outcome:'completed'};assert.equal(corrections(source('approval intern'),done)[0].status,'completed');
  const paused=claim({state:'running',paused:true,portable:true});assert.equal(corrections(source('approval intern'),paused).length,0);
  assert.equal(corrections(source(),paused)[0].status,'queued');
});

test('missing historical correction sources are freshly read, and a failed read preserves the prior snapshot',async()=>{
  for(const failed of [false,true]){
    let reads=0;
    const snapshot=await collectSnapshot({now,config:{clickup:{workspace_id:'test'},slack:{channel_id:'test'},hub:{}},
      claimReader:async()=>[claim()],fleetReader:async()=>[],hubFetch:async target=>{
        const url=new URL(target);
        if(url.pathname.endsWith('/task/t1')){reads++;return failed?{ok:false,status:503,json:async()=>({})}
          :{ok:true,status:200,json:async()=>source('approval intern')};}
        return {ok:true,status:200,json:async()=>({spaces:[],tasks:[],last_page:true})};
      }});
    assert.equal(reads,1);
    if(failed){assert.equal(snapshot.tasks,undefined);assert.match(snapshot.source.error,/ClickUp/);}
    else assert.deepEqual(snapshot.tasks,[]);
  }
});

// Hub hotfix 22.10.2026: ClickUp answers HTTP 404 for a deleted source task. That
// source is no order any more; only its live and completed attempts stay visible.
const attempt=(job,run,{ts='1792360700.000001',reactions=[{name:'x'}],...extra}={})=>parseClaim({ts,
  text:`*Korrektur · Kunde*\nNeue Aufgabe: <https://app.clickup.com/t/${/cu-([^@]+)@/.exec(job)[1]}|Mail>`,reactions,
  metadata:{event_type:'ai_korrektur_claim',event_payload:{task_id:job,run_id:run,worker:'macbook-1',state:'final',heartbeat:now/1000,...extra}}});

test('an unavailable correction source hides only its historical reservations, judged by the current attempt',()=>{
  const claims=[
    attempt('korrektur-cu-t1@1000-intern','blocked'),
    attempt('korrektur-cu-t1@2000-intern','running',{state:'running'}),
    attempt('korrektur-cu-t1@3000-intern','done',{reactions:[{name:'white_check_mark'}]}),
    attempt('korrektur-cu-t1@4000-intern','portable',{state:'running',paused:true,portable:true}),
    // An older success never stands in for the latest failed run of the same order.
    attempt('korrektur-cu-t1@5000-extern','old-success',{ts:'1792360600.000001',reactions:[{name:'white_check_mark'}]}),
    attempt('korrektur-cu-t1@5000-extern','new-failure'),
    attempt('korrektur-cu-t2@1000-intern','other'),
  ];
  const listed=options=>Object.fromEntries(buildQueue([],claims,DEFAULT_WORKFLOWS,{now,...options})
    .filter(row=>row.workflow==='correction').map(row=>[row.attemptId,row.status]));
  assert.deepEqual(listed(),{blocked:'blocked',running:'running',done:'completed',portable:'queued','new-failure':'blocked',other:'blocked'});
  assert.deepEqual(listed({unavailableCorrectionSources:new Set(['t1'])}),{running:'running',done:'completed',other:'blocked'});
});

test('a deleted correction source (HTTP 404) keeps the snapshot fresh; any other read failure still preserves the cache',async()=>{
  const run=async status=>{
    let reads=0;const warnings=[];
    const snapshot=await collectSnapshot({now,config:{clickup:{workspace_id:'test'},slack:{channel_id:'test'},hub:{}},
      claimReader:async()=>[claim(),attempt('korrektur-cu-t1@2000-intern','running',{ts:'1792360800.000001',state:'running'})],
      fleetReader:async()=>[],warn:message=>warnings.push(message),hubFetch:async target=>{
        const url=new URL(target);
        if(url.hostname==='slack.com')return {ok:true,status:200,json:async()=>({ok:true,messages:[],has_more:false})};
        if(url.pathname.endsWith('/task/t1')){reads++;return {ok:false,status,json:async()=>({err:'Task not found'})};}
        return {ok:true,status:200,json:async()=>({spaces:[],tasks:[],last_page:true})};
      }});
    return {snapshot,reads,warnings};
  };
  const gone=await run(404);
  assert.equal(gone.reads,1);
  assert.equal(gone.snapshot.source.error,undefined);
  assert.deepEqual(gone.snapshot.tasks.map(row=>[row.attemptId,row.status]),[['running','running']]);
  assert.equal(gone.warnings.length,1);
  assert.match(gone.warnings[0],/Korrekturquelle t1 nicht mehr verfügbar \(HTTP 404\)/);
  assert.ok(gone.snapshot.source.detail.includes('· 1 nicht mehr verfügbare Korrekturquelle'),gone.snapshot.source.detail);
  for(const status of [500,403]){
    const failed=await run(status);
    assert.equal(failed.reads,1);
    assert.equal(failed.snapshot.tasks,undefined);
    assert.match(failed.snapshot.source.error,new RegExp(`ClickUp: HTTP ${status}`));
    assert.deepEqual(failed.warnings,[]);
  }
});
