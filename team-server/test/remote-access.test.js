const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const access = require('../remote-access');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-team-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'DEMO1234'); fs.mkdirSync(directory, { mode: 0o700 });
  for (const key of ['remote-ca', 'member']) execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(directory, key)]);
  const publicKey = access.publicKey(fs.readFileSync(path.join(directory, 'member.pub'), 'utf8').trim());
  const manifest = { schema: 1, enabled: true, teamId: 'DEMO1234', hubHost: 'hub.example.test', hubUser: 'max-monitor-access', hubHostKey: publicKey,
    workers: [{ workerId: 'macbook-1', username: 'worker', port: 23000, hostKey: publicKey }] };
  const file = path.join(directory, 'remote-access.json');
  fs.writeFileSync(file, JSON.stringify(manifest), { mode: 0o644 });
  return { root, directory, file, manifest, publicKey };
}

test('certificate binds the authenticated team/member and exact Mac with limited permissions', async t => {
  const f = fixture(t);
  const ticket = await access.issueCertificate(f.root, 'DEMO1234', 'member-one', { publicKey: f.publicKey, workerId: 'macbook-1', memberId: 'team-owner', principals: 'root', command: 'ignored' });
  assert.equal(ticket.memberId, 'member-one'); assert.equal(ticket.worker.workerId, 'macbook-1');
  const file = path.join(f.directory, 'test-cert.pub'); fs.writeFileSync(file, ticket.certificate);
  const description = execFileSync('/usr/bin/ssh-keygen', ['-L', '-f', file], { encoding: 'utf8' });
  assert.match(description, /DEMO1234\/member-one\/macbook-1/);
  assert.match(description, /max-monitor-DEMO1234-bastion/);
  assert.match(description, /max-monitor-DEMO1234-macbook-1/);
  assert.match(description, /permit-pty/); assert.match(description, /permit-port-forwarding/);
  for (const permission of ['permit-agent-forwarding', 'permit-X11-forwarding', 'permit-user-rc']) assert.ok(!description.includes(permission));
  assert.ok(!JSON.stringify(ticket).includes('PRIVATE KEY'));
  const audit = fs.readFileSync(path.join(f.directory, 'remote-access-audit.jsonl'), 'utf8');
  assert.match(audit, /member-one/); assert.ok(!audit.includes(f.publicKey));
});

test('issuer refuses excluded/unknown Macs, invalid keys, unconfigured teams and unsafe files', async t => {
  const f = fixture(t);
  for (const workerId of ['macbook-von-till-main-2', 'unknown-worker']) await assert.rejects(access.issueCertificate(f.root, 'DEMO1234', 'member-one', { publicKey: f.publicKey, workerId }), { status: 404 });
  for (const key of ['command="id" '+f.publicKey, 'ssh-ed25519 AAAA', f.publicKey+'\n', null]) await assert.rejects(access.issueCertificate(f.root, 'DEMO1234', 'member-one', { publicKey: key, workerId: 'macbook-1' }), { status: 400 });
  await assert.rejects(access.issueCertificate(f.root, 'OTHER123', 'member-one', { publicKey: f.publicKey, workerId: 'macbook-1' }), { status: 503 });
  fs.chmodSync(f.file, 0o666); assert.throws(() => access.configuration(f.root, 'DEMO1234'), { status: 503 });
  fs.chmodSync(f.file, 0o644);
  const ca = path.join(f.directory, 'remote-ca'); fs.renameSync(ca, ca+'.original'); fs.symlinkSync(ca+'.original', ca);
  await assert.rejects(access.issueCertificate(f.root, 'DEMO1234', 'member-one', { publicKey: f.publicKey, workerId: 'macbook-1' }), { status: 503 });
});

test('member issuance is throttled without allowing unbounded signer processes', async t => {
  const f = fixture(t), pending = [];
  const gate = new Promise(resolve => { t.after(resolve); });
  for (let n=0; n<4; n++) pending.push(access.issueCertificate(f.root, 'DEMO1234', 'rate-'+n, { publicKey: f.publicKey, workerId: 'macbook-1' }, { run: async () => { await gate; throw Error('intentional'); } }).catch(() => {}));
  await assert.rejects(access.issueCertificate(f.root, 'DEMO1234', 'rate-fifth', { publicKey: f.publicKey, workerId: 'macbook-1' }), { status: 429 });
  // after() releases the held signers; don't await the deliberately held promises here.
});

test('every current role may request access; removed, unknown and cross-team tokens cannot', async t => {
  const f = fixture(t);
  process.env.DATA_DIR=f.root; process.env.TEAM_TOKENS='DEMO1234:owner-token,OTHER123:other-owner'; delete process.env.TEAM_TOKEN;
  const members = ['admin','member','guest'].map(role => ({ id: role+'-member', name: role, role, macWorker: false, token: role+'-token' }));
  const memberFile = path.join(f.directory,'members.json'); fs.writeFileSync(memberFile,JSON.stringify(members));
  const { server }=require('../server'); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{ server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(token, route='/remote-access/certificate', body={ publicKey:f.publicKey,workerId:'macbook-1' }, team='DEMO1234')=>{
    const r=await fetch(`${base}/v1/teams/${team}${route}`,{method:body===null?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===null?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  for(const token of ['owner-token','admin-token','member-token','guest-token']) {
    assert.equal((await call(token,'/remote-access',null)).status,200);
    const r=await call(token); assert.equal(r.status,200); assert.ok(r.body.certificate);
  }
  for(const token of ['missing-token','other-owner']) assert.equal((await call(token)).status,401);
  assert.equal((await call('admin-token','/remote-access/certificate',undefined,'OTHER123')).status,401);
  assert.equal((await call('owner-token','/remote-access/certificate',{ publicKey:f.publicKey,workerId:'macbook-von-till-main-2' })).status,404);
  assert.equal((await call('owner-token','/remote-access/certificate',{})).status,400);
  const manifestBefore=fs.readFileSync(f.file,'utf8');
  fs.writeFileSync(memberFile,JSON.stringify(members.filter(v=>v.role!=='guest')));
  assert.equal((await call('guest-token')).status,401); assert.equal(fs.readFileSync(f.file,'utf8'),manifestBefore);
  const client=await fetch(base+'/remote-client.py'); assert.equal(client.status,200);
  const code=await client.text(); assert.match(code,/getpass/); assert.ok(!code.includes('owner-token'));
});
