const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {distribution}=require('../distribution');
const pacing=require('../quota-pacing');
// Wednesday 12:00 Berlin; the weekly reset in three days puts the pace line at 51.8 % used.
const NOW=Date.parse('2026-10-21T10:00:00Z'), at=new Date(NOW).toISOString(), S=NOW/1000, RESET=S+3*86400;
const iso=seconds=>new Date(seconds*1000).toISOString();
function quota(weekly,five=0){
  return {schema:1,account:'account-'+weekly,generated_at:at,windows:{five_hour:{used:five,reset:five?S+3600:null,at:S},seven_day:{used:weekly,reset:RESET,at:S}},costs:{}};
}
function fixture(weekly=[52,52,52,52]){
  const fleet=['a','b','c','d'].map(worker=>({worker_id:worker,seen_at:at,annahme:true,occupied_tasks:0,max_tasks:3,plaetze:{newsletter:3,klaviyo:3,translation:3,korrektur:3}}));
  return {machines:fleet.map(m=>({workerId:m.worker_id,name:m.worker_id})),summary:{scheduling:{schema:1,generated_at:at,
    workers:Object.fromEntries(fleet.map((m,i)=>[m.worker_id,quota(weekly[i])])),routing:{available:true,fleet,jobs:[]}}}};
}
const view=(f,kind='newsletter')=>distribution(f.summary,f.machines,NOW).by_kind[kind];
const row=(v,worker)=>v.rows.find(r=>r.worker===worker);
const workerSource=[process.env.AI_NEWSLETTER_CREATION_DIR,path.join(os.homedir(),'Documents/AI Newsletter Creation')]
  .filter(Boolean).map(dir=>path.join(dir,'src/quota-pacing.js')).find(file=>fs.existsSync(file));

test('preview runs the immutable vendored Worker pacing module',()=>{
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../quota-pacing'))).digest('hex'),'8cb1690025081db0fb06650e1ec3c1187948cd3f1f76570077161c1fcbb1c5b6');
});
test('vendored pacing module is byte-identical to the Worker source',{skip:workerSource?false:'no ai-newsletter-creation checkout with src/quota-pacing.js'},()=>{
  assert.ok(fs.readFileSync(workerSource).equals(fs.readFileSync(require.resolve('../quota-pacing'))),workerSource);
});
test('equal quotas order Macs exactly by load and keys equal the Worker order key',()=>{
  const f=fixture(),fleet=f.summary.scheduling.routing.fleet;
  fleet[1].occupied_tasks=1;fleet[2].occupied_tasks=2;
  const v=view(f);
  assert.equal(v.mode,'quota');
  assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['a','d']);
  assert.ok(Math.abs(row(v,'b').key-row(v,'a').key-1)<1e-9);assert.ok(Math.abs(row(v,'c').key-row(v,'a').key-2)<1e-9);
  const analysis=pacing.analyseFleet(pacing.fleetMacs(fleet.map(m=>({...m,quota:f.summary.scheduling.workers[m.worker_id]})),{jobs:[]}),NOW);
  for(const r of v.rows){
    const expected=pacing.macKey(analysis.get(r.worker),r.load,'newsletter');
    assert.equal(r.key,expected.key);assert.equal(r.slot,expected.slot);
  }
  assert.equal(row(v,'a').slot,'single');
  assert.ok(Math.abs(row(v,'a').windows.seven_day.target-51.7857)<1e-3);
  assert.equal(row(v,'a').windows.seven_day.remaining,48);assert.equal(row(v,'a').windows.seven_day.reset,RESET);
  assert.equal(row(v,'a').windows.five_hour.reset,null);assert.equal(row(v,'a').windows.five_hour.fresh,true);
});
test('an account ahead of its weekly pace or near a busy 5h window yields to one on pace',()=>{
  const f=fixture([72,52,52,52]);
  f.summary.scheduling.workers.c=quota(52,40);
  const v=view(f);
  assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['b','d']);
  assert.ok(Math.abs(row(v,'a').key-row(v,'b').key-2)<1e-9,'20 pp ahead weighs two tasks');
  assert.ok(Math.abs(row(v,'c').key-row(v,'b').key-1)<1e-9,'40 % of a 5h window ending within the hour weighs one task');
  assert.equal(v.rows.filter(r=>!r.reason).length,4);
});
test('per-account guards explain refusals for the kind that does not fit',()=>{
  const f=fixture(),s=f.summary.scheduling;
  s.workers.a=quota(52,85);s.workers.b=quota(99.5);
  s.routing.fleet[2].quota_slots=[{slot:'single',status:'limited',at,five_hour:{used:100,reset:iso(S+3600)},seven_day:{used:60,reset:iso(RESET)},runs:[]}];
  const newsletter=view(f),upload=view(f,'upload');
  assert.deepEqual(Object.fromEntries(newsletter.rows.map(r=>[r.worker,r.reason])),{a:'guard_5h',b:'guard_weekly',c:'limited',d:null});
  assert.equal(row(newsletter,'a').key,null);assert.equal(row(newsletter,'a').preferred,false);
  assert.equal(row(upload,'a').reason,null,'a short upload still fits under the 90 % plan');
  assert.deepEqual(upload.rows.filter(r=>r.preferred).map(r=>r.worker),['d']);
  assert.equal(row(newsletter,'c').slot,'single');assert.equal(row(newsletter,'c').windows.five_hour.remaining,0);
});
test('soft cap and look-ahead pacing slow accounts far ahead of their pace and the fleet',()=>{
  const f=fixture([87,93,52,52]);
  f.summary.scheduling.routing.jobs=[{worker:'a',kind:'newsletter'}];
  const v=view(f);
  assert.equal(row(v,'a').reason,'soft_cap');assert.equal(row(v,'a').load,1);
  assert.equal(row(v,'b').reason,'paced');
  assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['c','d']);
});
test('per-account heartbeat slots take precedence over the Max Monitor row and name the chosen account',()=>{
  const f=fixture(),s=f.summary.scheduling;
  s.workers.a=quota(99);
  s.routing.fleet[0].quota_slots=[
    {slot:'primary',status:'ready',at,five_hour:{used:10,reset:iso(S+3600)},seven_day:{used:80,reset:iso(RESET)},runs:[]},
    {slot:'account-2',status:'ready',at,five_hour:{used:0,reset:null},seven_day:{used:40,reset:iso(RESET)},runs:[{kind:'upload',started:at}]}];
  const a=row(view(f),'a');
  assert.equal(a.reason,null);assert.equal(a.slot,'account-2');assert.equal(a.preferred,true);
  assert.equal(a.windows.seven_day.remaining,60);assert.ok(a.windows.seven_day.gap<-11);
  assert.deepEqual(view(f).rows.filter(r=>r.preferred).map(r=>r.worker),['a']);
  s.routing.fleet[0].quota_slots[1].status='limited';
  assert.equal(row(view(f),'a').slot,'primary');
});
test('full, stopped, stale and incapable Macs are excluded, not preferred',()=>{
  const f=fixture(),fleet=f.summary.scheduling.routing.fleet;
  fleet[0].occupied_tasks=3;fleet[1].annahme=false;fleet[2].seen_at=new Date(NOW-181000).toISOString();fleet[3].plaetze.klaviyo=0;
  const rows=view(f,'upload').rows;
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.worker,r.reason])),{a:'full',b:'not_accepting',c:'stale_worker',d:'kind_full'});
  assert.equal(rows.some(r=>r.preferred),false);assert.equal(rows.some(r=>r.key!==null),false);
});
test('no fresh quota falls back to absolute load; ties and stale values stay explicit',()=>{
  const f=fixture();for(const q of Object.values(f.summary.scheduling.workers))for(const w of Object.values(q.windows))w.at-=901;
  f.summary.scheduling.routing.fleet[0].occupied_tasks=1;
  const v=view(f);
  assert.equal(v.mode,'load');assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['b','c','d']);
  assert.equal(v.rows[0].windows.seven_day.fresh,false);assert.equal(v.rows[0].windows.seven_day.remaining,48);
  assert.equal(v.rows[0].windows.seven_day.target,undefined);
});
test('missing register or stale snapshot never produces a preference; hidden Macs are never suggested',()=>{
  const f=fixture();f.summary.scheduling.routing.available=false;
  let v=view(f);assert.equal(v.mode,'unavailable');assert.equal(v.rows.some(r=>r.preferred),false);
  f.summary.scheduling.routing.available=true;f.summary.scheduling.generated_at=new Date(NOW-181000).toISOString();
  v=view(f);assert.equal(v.mode,'unavailable');
  f.summary.scheduling.generated_at=at;
  v=distribution(f.summary,f.machines.slice(1),NOW).by_kind.newsletter;assert.equal(v.rows.some(r=>r.worker==='a'),false);
  assert.equal(distribution(null,f.machines,NOW).by_kind.newsletter.mode,'unavailable');
});
test('fresh independent load remains visible for a paused worker without renewing intake',()=>{
  const f=fixture();f.summary.scheduling.routing.fleet[0].seen_at=new Date(NOW-3601000).toISOString();delete f.summary.scheduling.routing.fleet[0].max_tasks;
  f.machines[0].load={fresh:true,occupied:2,max:6};
  const r=row(view(f),'a');
  assert.equal(r.load,2);assert.equal(r.cap,6);assert.equal(r.preferred,false);assert.equal(r.reason,'stale_worker');
});

const providerIdentity=(account='a',organization='b')=>({schema:1,provider:'anthropic',account:account.repeat(64),organization:organization.repeat(64),verifiedAt:at,source:'oauth-profile'});
function sharedFixture(){
  const f=fixture([20,20]),fleet=f.summary.scheduling.routing.fleet;
  for(const [i,m]of fleet.entries())m.quota_slots=[{slot:i?'account-2':'primary',status:'ready',at,identity:providerIdentity(),
    five_hour:{used:60,reset:iso(S+5*3600)},seven_day:{used:20,reset:iso(RESET)},
    runs:[{id:'ordinary:actual-'+i,identity:providerIdentity(),kind:'newsletter',started:null}]}];
  return f;
}
test('preview uses one shared provider gauge and the remaining costs of both physical owners',()=>{
  const f=sharedFixture(),v=view(f);
  for(const r of v.rows){assert.equal(r.reason,'guard_5h');assert.equal(r.windows.five_hour.remaining,40);assert.equal(r.windows.seven_day.remaining,80);}
  const fleet=f.summary.scheduling.routing.fleet;
  const a=pacing.analyseFleet(pacing.fleetMacs(fleet),NOW).get('a')[0];
  assert.equal(a.runs,2);assert.equal(a.u5,60);
  fleet[1].quota_slots[0].runs[0].id=fleet[0].quota_slots[0].runs[0].id;
  assert.equal(pacing.analyseFleet(pacing.fleetMacs(fleet),NOW).get('a')[0].runs,1,'one proven duplicate owner is charged once');
});
test('preview keeps same-organization different accounts separate and local access errors local',()=>{
  const f=sharedFixture(),fleet=f.summary.scheduling.routing.fleet;
  fleet[1].quota_slots[0].identity=providerIdentity('c');fleet[1].quota_slots[0].runs=[];
  assert.equal(row(view(f),'b').reason,null);
  fleet[1].quota_slots[0].identity=providerIdentity();fleet[0].quota_slots[0].status='error';fleet[1].quota_slots[0].at=new Date(NOW-1000).toISOString();
  fleet[0].quota_slots[0].runs=[];
  const v=view(f);assert.equal(row(v,'a').reason,'limited');assert.equal(row(v,'b').reason,null);
});
test('preview transports a fresh shared limit independently from an older gauge and honors its reset',()=>{
  const f=sharedFixture(),fleet=f.summary.scheduling.routing.fleet;
  fleet[0].quota_slots[0]={...fleet[0].quota_slots[0],status:'limited',at:iso(S-3600),statusAt:at,blockedUntil:iso(S+3600),runs:[]};
  fleet[1].quota_slots[0].runs=[];
  assert.equal(row(view(f),'b').reason,'limited');
  fleet[0].quota_slots[0].blockedUntil=iso(S-1);
  assert.equal(row(view(f),'b').reason,null);
});
