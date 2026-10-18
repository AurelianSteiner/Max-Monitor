import test from 'node:test';
import assert from 'node:assert/strict';
import {buildQueue, collectSnapshot, DEFAULT_WORKFLOWS} from './newsletter-monitor-bridge.mjs';
const now=Date.parse('2026-10-18T20:00:00Z'),epoch='1792160117500';
const claim={taskId:'T',jobId:`korrektur-cu-T@${epoch}-intern`,workflow:'correction',state:'final',outcome:'blocked',runId:'original-run',workerId:'macbook-1',ts:'1792160325.000346',heartbeat:now/1000-60};
const task=(status,more={})=>({id:'T',name:'Manually continued correction',status:{status},tags:[],...more});
const rows=(source,run=claim)=>buildQueue(source?[source]:[],[run],DEFAULT_WORKFLOWS,{now});
test('manual status handoffs retire an old correction failure without inventing completion',()=>{
 for(const status of ['approval intern','approval extern','go live','done'])assert.deepEqual(rows(task(status)),[]);
 assert.equal(rows(null)[0].status,'blocked','unknown source remains visible');
 assert.equal(rows(task('revision intern',{statusSince:epoch}))[0].status,'blocked');
 assert.deepEqual(rows(task('revision intern',{statusSince:epoch,tags:[{name:'manuell'}]})),[]);
 const current=rows(task('revision intern',{statusSince:'1792300000000'}));
 assert.equal(current.length,1);assert.equal(current[0].id,'correction:korrektur-cu-T@1792300000000-intern');assert.equal(current[0].status,'queued');
 assert.equal(rows(task('approval extern'),{...claim,state:'running',outcome:undefined})[0].status,'running','live writer remains visible');
 assert.equal(rows(task('approval extern'),{...claim,outcome:'completed'})[0].status,'completed','actual successful history is retained');
});
const response=data=>({ok:true,status:200,json:async()=>data});
test('a missing task in aggregate queries is read before retiring its historical correction',async()=>{
 for(const outcome of ['moved','failed','wrong-task']){
 let reads=0;
 const snapshot=await collectSnapshot({now,config:{clickup:{workspace_id:'1'},slack:{channel_id:'C'},hub:{}},fleetReader:async()=>[],claimReader:async()=>[claim],
 hubFetch:async target=>{let url=new URL(target);if(url.pathname.endsWith('/space'))return response({spaces:[]});if(url.pathname.endsWith('/task'))return response({tasks:[],last_page:true});
 if(url.pathname.endsWith('/task/T')){reads++;if(outcome==='failed')return {ok:false,status:503};return response({...task('approval extern'),...(outcome==='wrong-task'?{id:'other'}:{})});}throw Error('Unexpected '+url);}});
 assert.equal(reads,1);
 if(outcome==='moved'){assert.equal(snapshot.source.error,undefined);assert.deepEqual(snapshot.tasks,[]);}else{assert.equal(snapshot.tasks,undefined);assert.ok(snapshot.source.error);}
 }
});
