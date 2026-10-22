const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const now = Date.parse('2026-10-22T13:30:00Z');
class Clock extends Date { static now() { return now; } }
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl, Date: Clock };
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
vm.runInNewContext(source.replace(marker,
  '  snapshot = {}; globalThis.lines = fleetAccountLines; return;\n' + marker), context);
const current = new Date(now).toISOString(), future = new Date(now + 3600000).toISOString();
const single = () => ({ status: 'online', usageUpdatedAt: current, monitoringAccountId: 'a',
  accounts: [{accountId: 'a', name: 'test@example.test'}],
  limits: ['session', 'weekly'].map(kind => ({accountId: 'a', kind, percent: 25, resetsAt: future, usageUpdatedAt: current})) });
const pool = () => ({claudeAccounts: {selectedAccountId: 'a', accounts: ['a', 'b'].map(id => ({
  id, email: id + '@example.test', status: 'ready', updatedAt: current,
  windows: ['session', 'weekly'].map(kind => ({kind, percent: 25, reset: future}))
}))}});

test('single accounts and both ready pool accounts are available independently of selection', () => {
  assert.equal(context.lines(single())[0].available, true);
  const lines = context.lines(pool());
  assert.equal(lines[0].available, true);
  assert.equal(lines[1].available, true);
  assert.equal(lines[0].next, true);
  assert.equal(lines[1].next, false);
  assert.match(lines[1].title, /Freies Kontingent/);
});

test('either exhausted quota window makes a single account unavailable; raw percentages decide', () => {
  for (const index of [0, 1]) {
    const m = single(); m.limits[index].percent = 100;
    assert.equal(context.lines(m)[0].available, false);
    assert.match(context.lines(m)[0].availability, /Limit erreicht/);
    m.limits[index].percent = 99.9;
    assert.equal(context.lines(m)[0].available, true);
  }
});

test('provider failures and stale or missing measurements never show free quota', () => {
  const cases = [
    m => m.usageError = 'Netzwerkanfrage fehlgeschlagen',
    m => m.usageUpdatedAt = new Date(now - 16 * 60000).toISOString(),
    m => m.limits[0].usageError = 'Fehler',
    m => m.limits[0].usageStale = true,
    m => m.limits.pop(),
    m => m.limits[0].percent = null,
    m => m.status = 'offline',
    m => m.limits[0].resetsAt = new Date(now - 1).toISOString(),
  ];
  for (const mutate of cases) { const m = single(); mutate(m); assert.equal(context.lines(m)[0].available, false); }
});

test('pool statuses, missing freshness and future blocks make the affected account unavailable', () => {
  for (const mutate of [a => a.status = 'limited', a => a.status = 'error', a => a.status = 'unknown',
    a => a.updatedAt = 'invalid', a => a.stale = true, a => a.blockedUntil = future,
    a => a.windows[1].percent = 100, a => a.windows = []]) {
    const m = pool(); mutate(m.claudeAccounts.accounts[1]);
    const lines = context.lines(m);
    assert.equal(lines[0].available, true);
    assert.equal(lines[1].available, false);
  }
});

test('unused windows without a reset remain available and unbound accounts are never borrowed', () => {
  const m = single(); m.limits.forEach(limit => { limit.percent = 0; delete limit.resetsAt; });
  assert.equal(context.lines(m)[0].available, true);
  m.monitoringAccountId = 'unbound';
  assert.equal(context.lines(m).length, 0);
});
