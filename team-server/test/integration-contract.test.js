const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateReport, publicReport } = require('../worker-reports');
const { validateCapabilities, publicCapabilities, MCP_FRESH_MS } = require('../integration-contract');
const { createFleetStore } = require('../fleet');
const now = Date.parse('2026-10-18T01:00:00Z'), iso = offset => new Date(now + offset).toISOString();
const revision = char => char.repeat(40);
const receipt = (extra = {}) => ({ schema: 'rs-hub-capabilities/v1', checkedAt: iso(0), connected: true,
  fullAccess: true, writesEnabled: true, scope: 'all-customers', version: '1.8.5', toolCount: 27,
  releaseRevision: revision('a'), reasonCode: 'ok', contracts: { incidents: 1, blockers: 1, release: 1 }, ...extra });
const report = (extra = {}) => ({ schema: 1, workerId: 'simulation-worker', sampledAt: iso(0),
  workerVersion: 'V1.718', workerRevision: revision('b'),
  service: { running: true, lastPollAt: iso(0) },
  activity: { state: 'idle', acceptingTasks: true, occupiedTasks: 0, maxTasks: 3, runs: [] }, ...extra });
const bridge = (time, version, rev) => ({ workerId: 'simulation-worker', name: 'Simulation', lastSeenAt: iso(time),
  workerVersion: version, workerRevision: revision(rev), acceptingTasks: true });
function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-integration-simulation-'));
  try { return run(createFleetStore(dir, () => now), dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('F-FLEET-02: public observer status carries the observed running revision and evidence source', () => {
  const visible = publicReport(validateReport(report(), now), now);
  assert.equal(visible.workerVersion, 'V1.718');
  assert.equal(visible.workerRevision, revision('b'));
  assert.equal(visible.workerVersionObservedAt, iso(0));
  assert.equal(visible.workerVersionSource, 'worker-observer');
});

test('F-FLEET-02: old queue bridge cannot overwrite newer observer version, including after restart', () => withStore((store, dir) => {
  store.workerReport('SIMTEAM', report());
  store.updateQueue('SIMTEAM', { tasks: [], source: { name: 'Simulation' }, observedWorkers: [bridge(-10000, 'V1.717', 'a')] });
  for (const current of [store, createFleetStore(dir, () => now)]) {
    const row = current.snapshot('SIMTEAM').machines[0];
    assert.equal(row.workerVersion, 'V1.718'); assert.equal(row.workerRevision, revision('b'));
    assert.equal(row.workerVersionSource, 'worker-observer');
  }
}));

test('F-FLEET-02: newer Hub version beats an older direct sample and late bridge cannot roll it back', () => withStore(store => {
  store.workerReport('SIMTEAM', report({ sampledAt: iso(-20000) }));
  store.updateQueue('SIMTEAM', { tasks: [], source: { name: 'Simulation' }, observedWorkers: [bridge(-1000, 'V1.719', 'c')] });
  store.updateQueue('SIMTEAM', { tasks: [], source: { name: 'Delayed simulation' }, observedWorkers: [bridge(-10000, 'V1.717', 'a')] });
  const row = store.snapshot('SIMTEAM').machines[0];
  assert.equal(row.workerVersion, 'V1.719'); assert.equal(row.workerRevision, revision('c'));
  assert.equal(row.workerVersionSource, 'hub-heartbeat');
  assert.equal(row.workerVersionObservedAt, iso(-1000));
}));

test('F-FLEET-03: stale full rights never become fresh merely because the worker polls again', () => withStore(store => {
  store.workerReport('SIMTEAM', report({ rsHubMcp: receipt({ checkedAt: iso(-MCP_FRESH_MS - 1) }) }));
  const status = store.workerReportStatus('SIMTEAM', 'simulation-worker');
  assert.equal(status.agentStatus, 'online'); assert.equal(status.activity.fresh, true);
  assert.equal(status.rsHubMcp.fresh, false); assert.equal(status.rsHubMcp.ready, false);
}));

test('F-FLEET-03: auth, restricted scope and network failures affect capability health and preserve liveness', () => {
  for (const failure of [
    { connected: true, fullAccess: false, writesEnabled: false, scope: 'restricted', reasonCode: 'MCP_AUTH_REQUIRED' },
    { connected: true, writesEnabled: false, reasonCode: 'MCP_WRITES_DISABLED' },
    { connected: false, fullAccess: null, writesEnabled: null, scope: 'unknown', version: null, toolCount: null, releaseRevision: null, reasonCode: 'SSH_NETWORK_FAILED' },
  ]) withStore(store => {
    store.updateQueue('SIMTEAM', { tasks: [], source: { name: 'Simulation' }, observedWorkers: [bridge(-1000, 'V1.718', 'b')] });
    store.workerReport('SIMTEAM', report({ rsHubMcp: receipt(failure) }));
    const machine = store.snapshot('SIMTEAM').machines[0];
    assert.equal(machine.status, 'online'); assert.equal(machine.workerStatus, 'online');
    assert.equal(machine.rsHubMcp.fresh, true); assert.equal(machine.rsHubMcp.ready, false);
    assert.equal(machine.rsHubMcp.reasonCode, failure.reasonCode);
  });
});

test('F-FLEET-03: malformed optional integration telemetry never rejects a valid task poll', () => {
  for (const bad of [null, 'bad', {}, receipt({ checkedAt: iso(60000) }), receipt({ fullAccess: 'yes' }),
    receipt({ toolCount: 1001 }), receipt({ releaseRevision: '/Users/customer/secret' }), receipt({ reasonCode: 'Bearer secret' })]) {
    const accepted = validateReport(report({ rsHubMcp: bad, integrationContract: { schema: 999 } }), now);
    assert.equal(publicReport(accepted, now).activity.fresh, true);
    assert.equal(accepted.rsHubMcp, undefined);
    assert.equal(accepted.integrationContract, undefined);
  }
});

test('F-FLEET-03: delayed cached success cannot erase a newer failed MCP probe', () => withStore(store => {
  store.workerReport('SIMTEAM', report({ sampledAt: iso(-1000), rsHubMcp: receipt({ connected: false, reasonCode: 'network' }) }));
  store.workerReport('SIMTEAM', report({ rsHubMcp: receipt({ checkedAt: iso(-60000) }) }));
  assert.equal(store.workerReportStatus('SIMTEAM', 'simulation-worker').rsHubMcp.reasonCode, 'network');
  assert.equal(store.workerReportStatus('SIMTEAM', 'simulation-worker').rsHubMcp.ready, false);
}));

test('common contract strips arbitrary data and independently exposes matching component revisions', () => withStore(store => {
  const contract = { schema: 1, worker: { revision: revision('b'), version: 'V1.718', token: 'never-public' },
    skills: { revision: revision('c'), contractDigest: 'd'.repeat(64) }, rsHubMcp: receipt(), token: 'never-public' };
  store.workerReport('SIMTEAM', report({ rsHubMcp: receipt(), integrationContract: contract }));
  const visible = store.workerReportStatus('SIMTEAM', 'simulation-worker');
  assert.equal(visible.integrationContract.worker.revision, revision('b'));
  assert.equal(visible.integrationContract.skills.contractDigest, 'd'.repeat(64));
  assert.equal(visible.integrationContract.rsHubMcp.ready, true);
  assert.equal(JSON.stringify(visible).includes('never-public'), false);
}));

test('capability freshness boundary and ready require all full-access receipt fields', () => {
  assert.equal(publicCapabilities(validateCapabilities(receipt(), now), now + MCP_FRESH_MS).ready, true);
  assert.equal(publicCapabilities(validateCapabilities(receipt(), now), now + MCP_FRESH_MS + 1).ready, false);
  for (const delta of [{ fullAccess: false }, { writesEnabled: false }, { scope: 'restricted' }, { connected: false }])
    assert.equal(publicCapabilities(validateCapabilities(receipt(delta), now), now).ready, false);
});

// Wire payload frozen from Worker integration.capabilityReceipt; successful Hub
// replies intentionally use null rather than a synthetic success reason code.
test('Worker capabilityReceipt null success reason survives relay wire serialization', () => {
  const wire = JSON.parse(JSON.stringify(receipt({ reasonCode: null })));
  const accepted = validateCapabilities(wire, now);
  assert.equal(accepted.reasonCode, null);
  assert.equal(publicCapabilities(accepted, now).ready, true);
  assert.equal(validateCapabilities(receipt({ connected: false, reasonCode: null }), now), undefined);
});

test('actual Worker producer wire fixture roundtrips through the real report and public fleet contract', () => {
  const wire = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/worker-capability-receipt.json'), 'utf8'));
  const checked = Date.parse(wire.receipt.checkedAt);
  const accepted = validateReport(report({ sampledAt: wire.receipt.checkedAt, service: { running: true, lastPollAt: wire.receipt.checkedAt }, rsHubMcp: wire.receipt, integrationContract: wire.contract }), checked);
  const visible = publicReport(accepted, checked);
  assert.equal(visible.rsHubMcp.connected, true);
  assert.equal(visible.rsHubMcp.reasonCode, null);
  assert.equal(visible.rsHubMcp.ready, true);
  assert.equal(visible.rsHubMcp.fullAccess, true);
  assert.equal(visible.integrationContract.worker.revision, 'b'.repeat(40));
  assert.equal(visible.integrationContract.rsHubMcp.ready, true);
});
