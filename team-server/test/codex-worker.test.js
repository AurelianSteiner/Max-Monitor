const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { validateReport } = require('../worker-reports');
const { validateCodexAccount, publicCodexAccount } = require('../codex-account');
const { createFleetStore } = require('../fleet');
const { controlForWorker } = require('../worker-control');
const { workerProfile } = require('../worker-kinds');
const { planningEvidence } = require('../planning');
const { distribution } = require('../distribution');
const workerId = 'hausdraches-macbook-air-f1e2b4ad';
const deviceId = 'af722b73-9a39-4025-909c-64590db06d1c';
const now = Date.now(), at = new Date(now).toISOString();
const reset = new Date(now + 86400000).toISOString();
const account = () => ({ status: 'ready', accountId: 'codex-worker-account', name: 'Koralle Codex',
  email: 'koralle@example.test', checkedAt: at, updatedAt: at,
  windows: [{ kind: 'weekly', percent: 37.5, reset }] });
const report = () => ({ schema: 1, workerId, workerKind: 'codex-repair', deviceId, sampledAt: at,
  codexAccount: account(), service: { running: true, lastPollAt: at },
  activity: { state: 'idle', acceptingTasks: true, runs: [], occupiedTasks: 0, maxTasks: 1 } });

test('legacy Claude scheduling snapshots cannot count Codex repair capacity as newsletter capacity', () => {
  const machines = [{ workerId, name:'Koralle' }, { workerId:'macbook-1', name:'Rot' }];
  const summary = { scheduling:{ schema:1,generated_at:at, workers:{
    [workerId]:{account:'old-claude'},'macbook-1':{account:'newsletter-account'} },
    routing:{available:true,fleet:[],jobs:[]} } };
  assert.deepEqual(planningEvidence(summary,{machines}).accounts.map(account=>account.id),['newsletter-account']);
  for (const view of Object.values(distribution(summary,machines,now).by_kind))
    assert.deepEqual(view.rows.map(row=>row.worker),['macbook-1']);
});

test('Koralle admits repair/onboarding only; legacy newsletter admission fails closed', () => {
  const members = [{ id: 'koralle', macWorker: true, enrollment: { workerId, deviceId } }];
  assert.equal(workerProfile(workerId).provider, 'codex');
  assert.equal(controlForWorker(workerId, members, [], deviceId).reason, 'wrong_worker_kind');
  for (const workflow of ['newsletter', 'sales', 'translation', 'upload', 'correction'])
    assert.equal(controlForWorker(workerId, members, [], deviceId, workflow).enabled, false);
  for (const workflow of ['technical-repair', 'customer-onboarding'])
    assert.equal(controlForWorker(workerId, members, [], deviceId, workflow).enabled, true);
  members[0].macWorker = false;
  assert.equal(controlForWorker(workerId, members, [], deviceId, 'technical-repair').reason, 'disabled');
  assert.equal(controlForWorker(workerId, [], [], deviceId, 'technical-repair').reason, 'unregistered');
});

test('Codex account reports preserve consumed weekly percent/reset and independent freshness', () => {
  const value = validateCodexAccount({ ...account(), accessToken: 'never-stored' }, now);
  assert.equal(value.windows[0].percent, 37.5); assert.equal(value.windows[0].reset, reset);
  assert.equal(value.accessToken, undefined);
  assert.equal(publicCodexAccount(value, now + 600001).stale, true);
  assert.equal(publicCodexAccount(value, now).stale, false);
  for (const changed of [{ windows: [{ kind: 'weekly', percent: NaN }] },
    { windows: [{ kind: 'weekly', percent: 101 }] }, { windows: [] },
    { updatedAt: null }, { name: 'Bearer secret' }, { accountId: null },
    { checkedAt: new Date(now + 60000).toISOString() }])
    assert.throws(() => validateCodexAccount({ ...account(), ...changed }, now));
  assert.deepEqual(validateCodexAccount({ status: 'not_configured', checkedAt: at, windows: [] }, now).windows, []);
  assert.throws(() => validateReport({ ...report(), workerKind: 'newsletter' }, now));
  assert.throws(() => validateReport({ ...report(), workerId: 'macbook-1' }, now));
  const run = { id: 'repair:1', runId: 'attempt-1', title: 'Technische Reparatur', status: 'running' };
  assert.equal(validateReport({ ...report(), activity: { state: 'busy', acceptingTasks: false,
    runs: [{ ...run, workflow: 'technical-repair' }] } }, now).activity.runs[0].workflow, 'technical-repair');
  assert.throws(() => validateReport({ ...report(), activity: { state: 'busy', acceptingTasks: true,
    runs: [{ ...run, workflow: 'newsletter' }] } }, now));
});

test('a native Claude heartbeat cannot overwrite Codex quotas or fabricate usage before login', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fleet-')); let clock = now;
  try {
    const store = createFleetStore(directory, () => clock);
    const heartbeat = { deviceId, workerId, name: 'MacBook Air', reportedAt: at, monitoringAccountId: 'old-claude',
      accounts: [{ accountId: 'old-claude', name: 'Old Claude', provider: 'claude', usageUpdatedAt: at }],
      limits: [{ accountId: 'old-claude', label: '7d', kind: 'weekly', percent: 99, usageUpdatedAt: at }] };
    store.heartbeat('CORAL123', { role: 'member', member: { id: 'koralle' } }, heartbeat);
    let machine = store.snapshot('CORAL123').machines[0];
    assert.equal(machine.workerKind, 'codex-repair'); assert.equal(machine.provider, 'codex');
    assert.equal(machine.monitoringAccountId, null); assert.deepEqual(machine.limits, []);
    store.workerReport('CORAL123', report());
    store.heartbeat('CORAL123', { role: 'member', member: { id: 'koralle' } }, heartbeat);
    machine = store.snapshot('CORAL123').machines[0];
    assert.equal(machine.accounts[0].provider, 'codex'); assert.equal(machine.limits[0].percent, 37.5);
    assert.equal(machine.limits[0].resetsAt, reset); assert.equal(machine.usageStale, false);
    assert.equal(machine.claudeAccounts, undefined); assert.equal(machine.accountProvisioning, undefined);
    clock += 600001;
    machine = store.snapshot('CORAL123').machines[0];
    assert.equal(machine.usageStale, true); assert.equal(machine.limits[0].percent, 37.5);
    store.workerReport('CORAL123', { ...report(), sampledAt: new Date(clock).toISOString(),
      service: { running: true, lastPollAt: new Date(clock).toISOString() },
      codexAccount: { status: 'not_configured', checkedAt: new Date(clock).toISOString(), windows: [] } });
    machine = store.snapshot('CORAL123').machines[0];
    assert.equal(machine.monitoringAccountId, null); assert.deepEqual(machine.limits, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP profile, report binding and workflow admission use existing authenticated routes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-http-'));
  process.env.DATA_DIR = directory; process.env.TEAM_TOKEN = 'test-owner'; delete process.env.TEAM_TOKENS;
  const { server } = require('../server'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/v1/teams/CORAL123`;
  const call = async (route, method = 'GET', body, token = 'test-owner') => {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const member = (await call('/workers/enroll', 'POST', { workerId, deviceId })).body.member;
  assert.equal((await call('/me', 'GET', undefined, member.token)).body.workerKind, 'codex-repair');
  assert.equal((await call(`/workers/${workerId}/control`)).body.reason, 'wrong_worker_kind');
  assert.equal((await call(`/workers/${workerId}/control?workflow=technical-repair&deviceId=${deviceId}`)).body.enabled, true);
  assert.equal((await call(`/workers/${workerId}/report`, 'POST', report())).body.accepted, true);
  assert.equal((await call(`/workers/${workerId}/report`, 'POST', report(), member.token)).status, 403);
  assert.equal((await call(`/workers/${workerId}/report`, 'POST', { ...report(), deviceId: '00000000-0000-4000-8000-000000000000' })).status, 409);
  assert.equal((await call(`/workers/${workerId}/claude-accounts`)).status, 409);
});
