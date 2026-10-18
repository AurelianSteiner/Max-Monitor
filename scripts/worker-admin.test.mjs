import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maintenance, main as hubMain } from './worker-admin-hub.mjs';
import { parseArguments, sourceDeviceId } from './worker-admin.mjs';
const id = 'f23406d4-5b18-433c-b656-45de7747d648', source = 'macbook-till-main';
const bytes = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const publicKey = 'ssh-ed25519 '+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),bytes]).toString('base64');
const settings = {serverURL:'https://monitor.example.test',teamId:'DEMO1234',ownerToken:'owner-private'};
const member = {id:'source-member',token:'a'.repeat(32),enrollment:{workerId:source,deviceId:id}};
const body = {operation:'ticket',sourceWorkerId:source,deviceId:id,publicKey,workerId:'macbook-1'};
test('missing worker cache reuses only the private remote profile bound to this source', async t => {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-source-profile-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const file=path.join(home,'.local/share/max-monitor-remote/profile.json');await fs.mkdir(path.dirname(file),{recursive:true});
  const entry={workerId:source,username:'worker',port:23000,hostKey:publicKey,deviceId:id};
  await fs.writeFile(file,JSON.stringify(entry),{mode:0o600});
  assert.equal(await sourceDeviceId({workerId:source},{home}),id);
  await assert.rejects(sourceDeviceId({workerId:'macbook-von-till-main-2'},{home}));
  await fs.writeFile(file,JSON.stringify({...entry,deviceId:undefined}));
  assert.equal(await sourceDeviceId({workerId:source},{home}),null);
  await fs.chmod(file,0o644);await assert.rejects(sourceDeviceId({workerId:source},{home}));
});
function fixtures({ members = [member], authorize = () => source } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url,options});
    const data = url.endsWith('/members') ? {members}
      : url.endsWith('/certificate') ? {schema:1,teamId:'DEMO1234',worker:{workerId:'macbook-1'},certificate:'public-ticket',token:member.token,ownerToken:settings.ownerToken}
      : url.endsWith('/remote-access') ? {workers:[{workerId:'macbook-1',username:'worker'}]}
      : {generatedAt:'now',machines:[{workerId:'macbook-1',status:'online',activity:{runs:[]},token:'never-output'}]};
    return {ok:true,status:200,json:async()=>data};
  };
  return {calls,settings,fetchImpl,authorize,readMembers:()=>members};
}
test('maintenance uses the exactly bound ordinary member and never returns tokens', async () => {
  const f=fixtures(), result=await maintenance(body,f);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].options.headers.Authorization,'Bearer '+member.token);
  assert.deepEqual(JSON.parse(f.calls[0].options.body),{workerId:'macbook-1',publicKey});
  assert.ok(!JSON.stringify(result).includes(member.token));assert.ok(!JSON.stringify(result).includes('owner-private'));assert.ok(!('token' in result));
});
test('missing local device cache uses the unique authoritative enrollment and still requires source policy', async () => {
  const request={...body};delete request.deviceId;
  const f=fixtures();assert.ok((await maintenance(request,f)).certificate);
  const denied=fixtures({authorize:()=>{throw Error('denied');}});await assert.rejects(maintenance(request,denied));
  assert.equal(denied.calls.length,0);
  const ambiguous=fixtures({members:[member,{...member,id:'other-source',enrollment:{workerId:source,deviceId:'07c19201-43e8-4b31-80b0-55ea305e8ff6'}}]});
  await assert.rejects(maintenance(request,ambiguous));assert.equal(ambiguous.calls.length,0);
});
test('ambiguous or changed device identity and source policy denial stop before issuing tickets', async () => {
  for(const members of [[],[member,member],[{...member,enrollment:{...member.enrollment,deviceId:'07c19201-43e8-4b31-80b0-55ea305e8ff6'}}]]) {
    const f=fixtures({members});await assert.rejects(maintenance(body,f));assert.equal(f.calls.length,0);
  }
  for(const authorize of [()=>{throw Error('denied');},()=> 'macbook-von-till-main-2']) {
    const f=fixtures({authorize});await assert.rejects(maintenance(body,f));assert.equal(f.calls.length,0);
  }
});
test('list uses the same member authority and returns only bounded fleet fields', async () => {
  const f=fixtures(), result=await maintenance({...body,operation:'list'},f);
  assert.equal(result.workers[0].status,'online');assert.equal(result.sourceWorkerId,source);assert.equal(f.calls.length,2);
  for(const call of f.calls)assert.equal(call.options.headers.Authorization,'Bearer '+member.token);
  assert.ok(!JSON.stringify(result).includes('never-output'));
});
test('list preserves paused admission and actual occupied places with their freshness', async () => {
  const f=fixtures(), previousFetch=f.fetchImpl;
  f.fetchImpl=async (url,options)=>url.endsWith('/fleet') ? {ok:true,json:async()=>({generatedAt:'now',machines:[{
    workerId:'macbook-1',status:'online',workerRevision:'a'.repeat(40),workerVersionObservedAt:'2026-10-19T00:00:00Z',
    activity:{state:'idle',fresh:true,acceptingTasks:false,sampledAt:'2026-10-19T00:00:00Z',runs:[],token:'never-output'},
    load:{occupied:0,max:3,fresh:true,source:'agent',observedAt:'2026-10-19T00:00:00Z',token:'never-output'},
  }]})} : previousFetch(url,options);
  const worker=(await maintenance({...body,operation:'list'},f)).workers[0];
  assert.deepEqual(worker.activity,{state:'idle',fresh:true,acceptingTasks:false,sampledAt:'2026-10-19T00:00:00Z'});
  assert.deepEqual(worker.load,{occupied:0,max:3,fresh:true,source:'agent',observedAt:'2026-10-19T00:00:00Z'});
  assert.equal(worker.workerRevision,'a'.repeat(40));
  assert.ok(!JSON.stringify(worker).includes('never-output'));
  f.fetchImpl=async (url,options)=>url.endsWith('/fleet') ? {ok:true,json:async()=>({generatedAt:'later',machines:[{
    workerId:'macbook-1',activity:{state:'idle',fresh:false,acceptingTasks:true,runs:[]},
    load:{occupied:1,max:3,fresh:false,source:'hub'},
  }]})} : previousFetch(url,options);
  const stale=(await maintenance({...body,operation:'list'},f)).workers[0];
  assert.equal(stale.activity.fresh,false);assert.equal(stale.load.fresh,false);
});
test('invalid requests and ambiguous command syntax cannot become local shell commands', async () => {
  for(const patch of [{operation:'exec'},{sourceWorkerId:'worker;id'},{workerId:'worker;id'},{deviceId:'name'},{publicKey:'ssh-ed25519 AAAA'}]) {
    const f=fixtures();await assert.rejects(maintenance({...body,...patch},f));assert.equal(f.calls.length,0);
  }
  const command='printf "%s" "$(id -u)"';assert.equal(parseArguments(['exec','macbook-1','--',command]).command,command);
  for(const args of [['exec','macbook-1','id'],['exec','macbook-1','--','id','-u'],['check','macbook-1','--','id'],['check','worker;id'],['exec','macbook-1','--','x\0y']])assert.throws(()=>parseArguments(args));
});
test('stdio bridge emits only public output and enforces its input budget', async () => {
  const f=fixtures();let output='';const writer=new Writable({write(chunk,encoding,done){output+=chunk;done();}});
  const previous=process.env.MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE;
  try {
    await hubMain(['--stdin'],{...f,input:Readable.from([JSON.stringify(body)]),output:writer});
    assert.ok(!output.includes(member.token));assert.ok(!output.includes('owner-private'));
    await assert.rejects(hubMain(['--stdin'],{...f,input:Readable.from(['x'.repeat(4097)]),output:writer}));
  } finally {if(previous===undefined)delete process.env.MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE;else process.env.MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE=previous;}
});
