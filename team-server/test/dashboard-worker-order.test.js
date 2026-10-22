const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.DASHBOARD_ORDER_SOURCE || path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function renderFleet(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  '  globalThis.sortUnderTest = sortedMachines; return;\n' + marker), context);
const sorted = devices => Array.from(context.sortUnderTest(devices), machine => machine.deviceId);
function machine(id, weekly, session = 0, extra = {}) {
  return { deviceId: id, name: id, status: 'online',
    usageUpdatedAt: new Date().toISOString(), monitoringAccountId: 'claude',
    accounts: [{ accountId: 'claude', provider: 'claude' }],
    limits: [{ accountId: 'claude', kind: 'weekly', percent: weekly },
      { accountId: 'claude', kind: 'session', percent: session }], ...extra };
}

test('least weekly usage first, independent of name and current task', () => {
  assert.deepEqual(sorted([machine('A', 85), machine('Z', 12, 95,
    { activity: { fresh: true, tasks: [{ status: 'running' }] } }), machine('M', 40)]),
  ['Z', 'M', 'A']);
});

test('five-hour exhaustion does not override the weekly usage order', () => {
  assert.deepEqual(sorted([machine('session-full', 1, 100), machine('almost-full', 99, 99),
    machine('free', 15), machine('weekly-full', 100, 0)]),
  ['session-full', 'free', 'almost-full', 'weekly-full']);
});

test('five-hour usage breaks weekly ties, names give stable numeric ordering', () => {
  assert.deepEqual(sorted([machine('Mac 10', 20, 30), machine('Mac 2', 20, 30),
    machine('Mac 3', 20, 5)]), ['Mac 3', 'Mac 2', 'Mac 10']);
});

test('missing or invalid quota data never counts as free', () => {
  for (const extra of [{ limits: [] }, { accounts: [] }, { monitoringAccountId: 'missing' }]) {
    assert.deepEqual(sorted([machine('unknown', 0, 0, extra), machine('free', 90)]), ['free', 'unknown']);
  }
  for (const value of [null, undefined, '0', NaN, -1]) {
    assert.deepEqual(sorted([machine('unknown', value), machine('free', 90)]), ['free', 'unknown']);
  }
});

test('measurement age does not override the reported weekly usage order', () => {
  for (const extra of [{ usageStale: true },
    { usageUpdatedAt: '2020-01-01T00:00:00Z' }]) {
    assert.deepEqual(sorted([machine('stale', 0, 0, extra), machine('full', 10, 100),
      machine('free', 80)]), ['stale', 'full', 'free']);
  }
  const stale = machine('stale-limit', 0);
  stale.limits[0].usageStale = true;
  assert.deepEqual(sorted([stale, machine('free', 80)]), ['stale-limit', 'free']);
});

test('worker and monitoring errors always precede ordinary workers', () => {
  for (const extra of [{ status: 'offline' }, { workerStatus: 'failed' },
    { workerIssues: [{ severity: 'error', stage: 'claude', message: 'not logged in' }] },
    { usageError: 'unavailable' }, { usageStatus: 'error' },
    { activity: { fresh: true }, service: { running: false } }]) {
    assert.deepEqual(sorted([machine('free', 10), machine('error', 90, 100, extra)]),
      ['error', 'free']);
  }
});

test('weekly 100 percent is always last, including errors and stale data', () => {
  for (const extra of [{}, { usageStale: true }, { status: 'offline' },
    { usageError: 'unavailable' }, { workerStatus: 'failed' }]) {
    assert.deepEqual(sorted([machine('capped', 100, 0, extra),
      machine('unknown', null), machine('free', 99),
      machine('error', 80, 100, { workerStatus: 'failed' })]),
    ['error', 'free', 'unknown', 'capped']);
  }
});

test('errors are ordered by weekly usage, then five-hour usage', () => {
  const error = { workerStatus: 'failed' };
  assert.deepEqual(sorted([machine('later', 30, 1, error), machine('same-week-full', 20, 100, error),
    machine('same-week-free', 20, 5, error), machine('healthy', 0)]),
  ['same-week-free', 'same-week-full', 'later', 'healthy']);
});

test('only the bound monitoring account determines the order', () => {
  const bound = machine('bound', 60);
  bound.accounts.unshift({ accountId: 'other' });
  bound.limits.unshift({ accountId: 'other', kind: 'weekly', percent: 0 },
    { accountId: 'other', kind: 'session', percent: 100 });
  assert.deepEqual(sorted([bound, machine('free', 30)]), ['free', 'bound']);
});

test('a weekly reset restores priority without mutating input', () => {
  const full = machine('reset', 100, 0);
  const free = machine('free', 70);
  const devices = [full, free];
  assert.deepEqual(sorted(devices), ['free', 'reset']);
  full.limits[0].percent = 5;
  assert.deepEqual(sorted(devices), ['reset', 'free']);
  assert.deepEqual(devices.map(item => item.deviceId), ['reset', 'free']);
});
