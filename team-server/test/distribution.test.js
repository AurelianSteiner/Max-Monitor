const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {distribution}=require('../distribution');
const {quotaScores}=require('../quota-scores');
const now=Date.now(), at=new Date(now).toISOString();
function fixture(){
  const quota=(used,hours)=>({schema:1,account:String(used),generated_at:at,windows:{five_hour:{used:0,reset:null,at:now/1000},seven_day:{used,reset:now/1000+hours*3600,at:now/1000}},costs:{}});
  const fleet=['a','b','c','d'].map(worker=>({worker_id:worker,seen_at:at,annahme:true,occupied_tasks:0,max_tasks:3,plaetze:{newsletter:3,klaviyo:3,translation:3,korrektur:3}}));
  return {machines:fleet.map(m=>({workerId:m.worker_id,name:m.worker_id})),summary:{scheduling:{schema:1,generated_at:at,workers:{a:quota(20,24),b:quota(20,150),c:quota(30,100),d:quota(40,100)},routing:{available:true,fleet,jobs:[]}}}};
}
test('preview executes the exact immutable Worker scoring source',()=>{
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../quota-scores'))).digest('hex'),'9dadd5456f4491e39d7cb57fbbea96ff06956914be95f69a2b6219140a1c7509');
  const {summary,machines}=fixture();const v=distribution(summary,machines,now).by_kind.newsletter;
  const candidates=machines.map(m=>({worker:m.workerId,load:0,maxTasks:3,quota:summary.scheduling.workers[m.workerId]}));
  for(const row of quotaScores({candidates,kind:'newsletter',nowMs:now}))assert.equal(v.rows.find(r=>r.worker===row.worker).score,row.score);
  assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['a']);
});
test('full, stopped, stale and incapable Macs are excluded, not preferred',()=>{
  const {summary,machines}=fixture(), f=summary.scheduling.routing.fleet;
  f[0].occupied_tasks=3;f[1].annahme=false;f[2].seen_at=new Date(now-181000).toISOString();f[3].plaetze.klaviyo=0;
  const rows=distribution(summary,machines,now).by_kind.upload.rows;
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.worker,r.reason])),{a:'full',b:'not_accepting',c:'stale_worker',d:'kind_full'});
  assert.equal(rows.some(r=>r.preferred),false);
});
test('no fresh quota falls back to absolute load; ties and stale values stay explicit',()=>{
  const {summary,machines}=fixture();for(const q of Object.values(summary.scheduling.workers))for(const w of Object.values(q.windows))w.at-=901;
  summary.scheduling.routing.fleet[0].occupied_tasks=1;
  const v=distribution(summary,machines,now).by_kind.newsletter;
  assert.equal(v.mode,'load');assert.deepEqual(v.rows.filter(r=>r.preferred).map(r=>r.worker),['b','c','d']);
  assert.equal(v.rows[0].windows.seven_day.fresh,false);assert.equal(v.rows[0].windows.seven_day.remaining,80);
});
test('shared account claims reduce headroom and measured costs block a job that does not fit',()=>{
  const {summary,machines}=fixture(),s=summary.scheduling;
  s.workers.a.windows.seven_day.used=80;
  s.workers.a.costs.upload={weekly_pp:{n:3,mean:9,sd:1}};
  s.workers.b=s.workers.a;s.routing.jobs=[{worker:'b',kind:'upload'},{worker:'b',kind:'upload'}];
  const v=distribution(summary,machines,now).by_kind.upload;
  assert.equal(v.rows.find(r=>r.worker==='a').reason,'quota');
  assert.equal(v.rows.find(r=>r.worker==='a').windows.seven_day.remaining_pp,2);
  assert.equal(v.rows.find(r=>r.worker==='a').windows.seven_day.expected_pp,12);
});
test('missing register or stale snapshot never produces a preference; hidden Macs are never suggested',()=>{
  const {summary,machines}=fixture();summary.scheduling.routing.available=false;
  let v=distribution(summary,machines,now).by_kind.newsletter;assert.equal(v.mode,'unavailable');assert.equal(v.rows.some(r=>r.preferred),false);
  summary.scheduling.routing.available=true;summary.scheduling.generated_at=new Date(now-181000).toISOString();
  v=distribution(summary,machines,now).by_kind.newsletter;assert.equal(v.mode,'unavailable');
  summary.scheduling.generated_at=at;
  v=distribution(summary,machines.slice(1),now).by_kind.newsletter;assert.equal(v.rows.some(r=>r.worker==='a'),false);
});
test('fresh independent load remains visible for a paused worker without renewing intake',()=>{
  const {summary,machines}=fixture();summary.scheduling.routing.fleet[0].seen_at=new Date(now-3601000).toISOString();delete summary.scheduling.routing.fleet[0].max_tasks;
  machines[0].load={fresh:true,occupied:2,max:6};
  const row=distribution(summary,machines,now).by_kind.newsletter.rows.find(r=>r.worker==='a');
  assert.equal(row.load,2);assert.equal(row.cap,6);assert.equal(row.preferred,false);assert.equal(row.reason,'stale_worker');
});
