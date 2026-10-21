const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateClaudeAccounts,publicClaudeAccounts}=require('../claude-accounts');
const {createFleetStore}=require('../fleet');
const now=Date.now();
const data=()=>({selectedAccountId:'account-2',accounts:[{id:'primary',name:'Account 1',status:'limited',updatedAt:new Date(now).toISOString(),windows:[{kind:'session',percent:100,reset:new Date(now+3600000).toISOString()}]},
  {id:'account-2',name:'Account 2',status:'ready',updatedAt:new Date(now).toISOString(),windows:[{kind:'weekly',percent:25}]}]});
test('worker account labels and reset windows persist independently of monitoring login',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account-relay-'));try{
    const store=createFleetStore(dir,()=>now);
    store.heartbeat('TEAM1234',{role:'super'},{deviceId:'12345678-1234-4234-8234-123456789abc',name:'Test',workerId:'mac-test',reportedAt:new Date(now).toISOString(),limits:[]});
    store.workerReport('TEAM1234',{schema:1,workerId:'mac-test',sampledAt:new Date(now).toISOString(),service:{running:true,lastPollAt:new Date(now).toISOString()},activity:{state:'idle',acceptingTasks:true,runs:[]},claudeAccounts:data()});
    const m=store.snapshot('TEAM1234').machines[0];assert.equal(m.claudeAccounts.accounts.length,2);assert.equal(m.claudeAccounts.selectedAccountId,'account-2');
    assert.equal(m.claudeAccounts.accounts[0].windows[0].percent,100);
    assert.equal(createFleetStore(dir,()=>now).snapshot('TEAM1234').machines[0].claudeAccounts.accounts[1].name,'Account 2');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('malformed usage cannot become an account or percentage; metadata is allowlisted',()=>{
  const value=data();value.token='secret';value.accounts[0].service='secret';
  const accepted=validateClaudeAccounts(value);assert.ok(!JSON.stringify(accepted).includes('secret'));
  for(const change of [d=>d.accounts.push(d.accounts[0]),d=>d.accounts[0].name='sk-ant-oat01-secret',d=>d.accounts[0].windows[0].percent=101,d=>d.selectedAccountId='other']){
    const bad=data();change(bad);assert.throws(()=>validateClaudeAccounts(bad));
  }
  assert.equal(publicClaudeAccounts(accepted,now+11*60000).accounts[0].stale,true);
});
