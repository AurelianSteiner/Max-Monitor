const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateReport, publicReport } = require('../worker-reports');
const { createFleetStore } = require('../fleet');

const now = Date.now();
const iso = time => new Date(time).toISOString();
const report = (activity = {}) => ({ schema: 1, workerId: 'macworker-5-schwarz', sampledAt: iso(now),
  service: { running: true, lastPollAt: iso(now) }, activity: { state: 'idle', acceptingTasks: true, runs: [], ...activity } });
const source = () => ({ name: 'test', lastSuccessAt: iso(now) });

test('a direct report carries the worker admission count and maximum, never idle with occupied places', () => {
  const busy = validateReport(report({ state: 'busy', occupiedTasks: 2, maxTasks: 6 }), now);
  assert.deepEqual([busy.activity.occupiedTasks, busy.activity.maxTasks], [2, 6]);
  assert.deepEqual([publicReport(busy, now).activity.occupiedTasks, publicReport(busy, now).activity.maxTasks], [2, 6]);
  // A browser job or preview without a run row: busy, not idle.
  assert.throws(() => validateReport(report({ occupiedTasks: 1, maxTasks: 6 }), now));
  assert.equal(validateReport(report({ occupiedTasks: 0, maxTasks: 6 }), now).activity.state, 'idle');
  for (const value of [51, -1, 1.5, '3']) {
    assert.throws(() => validateReport(report({ state: 'busy', occupiedTasks: value }), now));
    assert.throws(() => validateReport(report({ state: 'busy', maxTasks: value }), now));
  }
  // Older workers send neither field.
  const legacy = validateReport(report(), now);
  assert.equal(Object.hasOwn(legacy.activity, 'occupiedTasks'), false);
  assert.equal(Object.hasOwn(legacy.activity, 'maxTasks'), false);
});

test('the fleet shows used places against the Mac maximum from the freshest worker observation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-load-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = now;
  const store = createFleetStore(directory, () => clock);
  store.updateQueue('TEAM1234', { source: source(), tasks: [], observedWorkers: [
    { workerId: 'macworker-5-schwarz', name: 'macworker-5-schwarz', lastSeenAt: iso(now - 30000), acceptingTasks: false,
      occupiedTasks: 6, maxTasks: 6, places: { korrektur: 2, newsletter: 6, klaviyo: 6, translation: 6 } },
    { workerId: 'macbook-1', name: 'macbook-1', lastSeenAt: iso(now - 30000), acceptingTasks: true },
  ] });
  let machines = store.snapshot('TEAM1234').machines;
  const mac5 = machines.find(machine => machine.workerId === 'macworker-5-schwarz');
  assert.deepEqual(mac5.load, { occupied: 6, max: 6, source: 'hub', observedAt: iso(now - 30000), fresh: true });
  assert.deepEqual(mac5.places, { klaviyo: 6, korrektur: 2, newsletter: 6, translation: 6 });
  assert.equal(machines.find(machine => machine.workerId === 'macbook-1').load, undefined, 'older worker: no count, nothing invented');
  // The 15 s direct report wins over the slower Hub heartbeat.
  store.workerReport('TEAM1234', report({ state: 'busy', acceptingTasks: true, occupiedTasks: 4 }));
  machines = store.snapshot('TEAM1234').machines;
  assert.deepEqual(machines.find(machine => machine.workerId === 'macworker-5-schwarz').load,
    { occupied: 4, max: 6, source: 'agent', observedAt: iso(now), fresh: true });
  // Both observations age out instead of showing an old load as current.
  clock = now + 200000;
  assert.equal(store.snapshot('TEAM1234').machines.find(machine => machine.workerId === 'macworker-5-schwarz').load.fresh, false);
});

test('observed worker places are bounded like the worker heartbeat', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-load-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory, () => now);
  const worker = extra => ({ source: source(), tasks: [], observedWorkers: [{ workerId: 'macbook-1', name: 'macbook-1', lastSeenAt: iso(now), ...extra }] });
  for (const extra of [{ occupiedTasks: 51 }, { maxTasks: -1 }, { occupiedTasks: '2' }, { places: { newsletter: 3, klaviyo: 3 } },
    { places: { newsletter: 3, klaviyo: 3, translation: 3, browser: 1 } }, { places: { newsletter: 99, klaviyo: 3, translation: 3 } }])
    assert.throws(() => store.updateQueue('TEAM1234', worker(extra)), /ungültig/);
  store.updateQueue('TEAM1234', worker({ occupiedTasks: 0, maxTasks: 3, places: { newsletter: 3, klaviyo: 3, translation: 3 } }));
  assert.equal(store.snapshot('TEAM1234').machines[0].load.occupied, 0);
});

// Run the dashboard's real status functions, stopping before DOM initialization.
const sourceCode = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(sourceCode.replace(marker, '  globalThis.loadUnderTest = { idleLabel, machineLoad }; return;\n' + marker), context);
const { idleLabel, machineLoad } = context.loadUnderTest;

test('the dashboard names a full Mac instead of a paused admission and shows hidden place holders', () => {
  const online = { status: 'online', workerId: 'macbook-1', workerStatus: 'online', telemetrySource: 'app' };
  const load = (occupied, max, extra = {}) => ({ occupied, max, source: 'hub', observedAt: iso(Date.now() - 20000), fresh: true, ...extra });
  // Three Sales test runs fill a 3-place Mac: the worker stops admitting because it is full.
  assert.equal(idleLabel({ ...online, acceptingTasks: false, load: load(3, 3),
    activity: { fresh: true, state: 'idle', acceptingTasks: false } }), 'voll belegt · 3 / 3');
  // A Klaviyo browser job alone is a used place, not a free Mac.
  assert.equal(idleLabel({ ...online, load: load(1, 6), activity: { fresh: true, state: 'busy', acceptingTasks: true, runs: [] } }), 'belegt · 1 / 6');
  assert.equal(idleLabel({ ...online, load: load(0, 6), activity: { fresh: true, state: 'idle', acceptingTasks: true } }), 'frei');
  // Old observations never pose as the current load.
  const stale = load(3, 3, { observedAt: iso(Date.now() - 200000) });
  assert.equal(machineLoad({ ...online, load: stale }), null);
  assert.equal(idleLabel({ ...online, acceptingTasks: false, load: stale }), 'Annahme pausiert · Tätigkeit ungeprüft');
  assert.equal(machineLoad({ ...online, status: 'offline', load: load(1, 3) }), null);
  assert.equal(idleLabel({ ...online, load: load(2) }), 'belegt · 2');
});
