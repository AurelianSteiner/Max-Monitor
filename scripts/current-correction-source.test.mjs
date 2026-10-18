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
