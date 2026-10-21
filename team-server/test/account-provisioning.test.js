const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {validateEndpoint,enqueue,deliver,status}=require('../account-provisioning');
const {createFleetStore}=require('../fleet');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
const endpoint={publicKey,keyId:crypto.createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex')};
const deviceId='12345678-1234-4234-8234-123456789abc';
const envelope=()=>({id:crypto.randomUUID(),action:'add-account',expiresAt:new Date(Date.now()+60000).toISOString(),deviceId,keyId:endpoint.keyId,wrappedKey:crypto.randomBytes(384).toString('base64'),iv:crypto.randomBytes(12).toString('base64'),ciphertext:crypto.randomBytes(80).toString('base64')});
test('the inbox binds encrypted orders to one device/key, redacts status and erases payload after acknowledgement',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account-inbox-'));try{
    const target={workerId:'mac-test',deviceId,teamId:'RSMACS01',endpoint};const body=envelope();
    enqueue(dir,target,body);assert.equal(status(dir,'mac-test').status,'queued');
    assert.equal(deliver(dir,{workerId:'mac-test',deviceId:'wrong',accountProvisioning:endpoint},'RSMACS01'),null);
    const command=deliver(dir,{workerId:'mac-test',deviceId,accountProvisioning:endpoint},'RSMACS01');assert.equal(command.id,body.id);
    assert.ok(!JSON.stringify(status(dir,'mac-test')).includes(body.ciphertext));
    deliver(dir,{workerId:'mac-test',deviceId,accountProvisioning:{...endpoint,result:{id:body.id,status:'ready',updatedAt:new Date().toISOString(),figma:'connected'}}},'RSMACS01');
    assert.equal(status(dir,'mac-test').status,'ready');assert.ok(!fs.readFileSync(path.join(dir,'claude-account-orders/mac-test.json'),'utf8').includes(body.ciphertext));
    assert.throws(()=>enqueue(dir,target,{...envelope(),token:'must-not-be-accepted'}));
    assert.throws(()=>enqueue(dir,target,{...envelope(),deviceId:'wrong'}));
    assert.throws(()=>validateEndpoint({...endpoint,keyId:'0'.repeat(64)}));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('only admins can enqueue and a worker receives only its own sealed order through the existing report route',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account-api-'));process.env.DATA_DIR=dir;process.env.TEAM_TOKEN='account-api-owner';delete process.env.TEAM_TOKENS;
  const {server}=require('../server');server.listen(0,'127.0.0.1');await require('node:events').once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/v1/teams/RSMACS01`;
  const call=async(route,method='GET',body,token='account-api-owner')=>{
    const r=await fetch(base+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};
  };
  try{
    fs.mkdirSync(path.join(dir,'RSMACS01'),{recursive:true});fs.writeFileSync(path.join(dir,'RSMACS01/owner.json'),JSON.stringify({macWorker:true}));
    const at=new Date().toISOString(),store=createFleetStore(dir);
    store.heartbeat('RSMACS01',{role:'super',member:{id:'team-owner',name:'Owner'}},{deviceId,name:'Test Mac',workerId:'mac-test',reportedAt:at,limits:[]});
    const report={schema:1,workerId:'mac-test',deviceId,sampledAt:at,service:{running:true,lastPollAt:at},activity:{state:'idle',acceptingTasks:true,runs:[]},accountProvisioning:endpoint};
    assert.equal((await call('/workers/mac-test/report','POST',report)).status,200);
    const member=(await call('/members','POST',{name:'Viewer',role:'member'})).body.member;
    assert.equal((await call('/workers/mac-test/claude-accounts','POST',envelope(),member.token)).status,403);
    const body=envelope();assert.equal((await call('/workers/mac-test/claude-accounts','POST',body)).status,202);
    const delivered=(await call('/workers/mac-test/report','POST',{...report,sampledAt:new Date().toISOString()})).body;
    assert.equal(delivered.accountCommand.id,body.id);assert.equal(delivered.accountCommand.deviceId,deviceId);
    assert.ok(!JSON.stringify((await call('/workers/mac-test/claude-accounts')).body).includes(body.ciphertext));
    assert.equal((await call('/workers/mac-test/claude-accounts','POST',envelope())).status,409);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
