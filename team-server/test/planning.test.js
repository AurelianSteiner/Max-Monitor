const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../public/planning-model');
const { planningEvidence } = require('../planning');
const NOW = Date.parse('2026-10-20T12:00:00Z');
function fixture(count = 7) {
  return { generated_at: new Date(NOW).toISOString(), accounts: Array.from({ length: count }, (_, i) => ({ id: 'account-' + i,
    windows: { five_hour: { used: 0, at: NOW / 1000, reset: NOW / 1000 + 3600 }, seven_day: { used: 0, at: NOW / 1000, reset: NOW / 1000 + 86400 } } })),
    averages: model.KINDS.map((key, i) => ({ key, five_hour_pp: { mean: [10, 5, 2][i], n: 20 }, weekly_pp: { mean: [1, .5, .2][i], n: 20 } })) };
}
const cap = (s, mode = 'full', period = 'week') => model.capacity(s, mode, period, NOW);
test('current planning rejects expired or unknown reset windows until a new sample arrives', () => {
  for (const reset of [NOW / 1000 - 1, NOW / 1000, undefined, NaN]) {
    const source = fixture(1); source.accounts[0].windows.five_hour.reset = reset;
    assert.equal(cap(source, 'current').available, false);
    assert.equal(model.initial(cap(source, 'current')).newsletter, 0);
    assert.equal(cap(source, 'full').available, true, 'hypothetical full capacity stays explicit');
  }
  assert.equal(cap(fixture(1), 'current').available, true);
});
function assertFits(c, mix) {
  for (const window of ['fiveHour', 'weekly']) assert.ok(model.KINDS.reduce((n, k) => n + mix[k] * c.costs[k][window], 0) <= c.budgets[window] + 1e-7);
}
test('starts with all capacity in newsletters and zero corrections/uploads', () => {
  assert.deepEqual(model.initial(cap(fixture())), { newsletter: 700, correction: 0, upload: 0 });
  assert.equal(model.initial(cap(fixture(), 'full', 'day')).newsletter, 100);
});
test('current limits reduce available work; full mode includes every same-plan account', () => {
  const s = fixture();
  for (const account of s.accounts) account.windows.seven_day.used = 50;
  assert.equal(model.initial(cap(s, 'current')).newsletter, 350);
  assert.equal(model.initial(cap(s, 'full')).newsletter, 700);
  s.accounts[0].windows.seven_day.used = 100;
  assert.equal(model.initial(cap(s, 'current')).newsletter, 300);
});
test('5-hour usage can independently constrain the mix', () => {
  const s = fixture(1); s.accounts[0].windows.five_hour.used = 99;
  assert.equal(model.initial(cap(s, 'current', 'day')).newsletter, 0);
  s.accounts[0].windows.five_hour.used = 0;
  assert.equal(model.initial(cap(s, 'current', 'day')).newsletter, 14);
});
test('100 newsletters per day automatically gets 100 uploads and the remaining corrections', () => {
  const c = cap(fixture(10), 'full', 'day');
  const mix = model.balance(c, { newsletter: 100, correction: 0, upload: 0 }, 'newsletter');
  assert.deepEqual(mix, { newsletter: 100, upload: 100, correction: 45 }); assertFits(c, mix);
  const changed = model.balance(c, { ...mix, upload: 50 }, 'upload');
  assert.equal(changed.newsletter, 100); assert.equal(changed.upload, 50); assert.equal(changed.correction, 65); assertFits(c, changed);
});
test('correction changes rebalance uploads, without changing newsletter volume', () => {
  const c = cap(fixture());
  const mix = model.balance(c, { newsletter: 300, correction: 560, upload: 0 }, 'correction');
  assert.deepEqual(mix, { newsletter: 300, correction: 560, upload: 600 }); assertFits(c, mix);
});
test('quantities and upload matching stay inside both limits', () => {
  const c = cap(fixture());
  for (const kind of model.KINDS) for (const value of [0, 1, 200, 699, 700, 10000, -5, NaN]) {
    const mix = model.balance(c, { newsletter: 300, correction: 200, upload: 100, [kind]: value }, kind);
    assertFits(c, mix); assert.ok(model.usage(c, mix).percent <= 100);
    for (const quantity of Object.values(mix)) assert.ok(Number.isInteger(quantity) && quantity >= 0);
  }
});
test('global averages work for accounts without their own task history; account duplicates count once', () => {
  const s = fixture(2); s.accounts.push(structuredClone(s.accounts[0]));
  for (const mean of s.averages) { mean.five_hour_pp.n = 1; mean.weekly_pp.n = 1; }
  assert.equal(cap(s).accounts, 2); assert.equal(model.initial(cap(s)).newsletter, 200);
});
test('unknown or stale counters stay unavailable rather than silently becoming zero usage', () => {
  const s = fixture(); delete s.accounts[0].windows.five_hour;
  assert.equal(cap(s, 'current').available, false); assert.equal(cap(s, 'full').available, true);
  s.generated_at = new Date(NOW - 180001).toISOString(); assert.equal(cap(s).available, false);
  const missing = fixture(); missing.averages[0].weekly_pp.mean = null;
  assert.equal(cap(missing).available, false); assert.equal(model.maximum(cap(missing), 'newsletter'), 0);
});
test('visible accounts are included regardless of intake, slots or individual samples, shared IDs use newest counters', () => {
  const s = { generated_at: new Date(NOW).toISOString(), by_kind: fixture().averages, scheduling: { workers: {
    a: { account: 'shared', windows: { five_hour: { used: 50, at: 1 } } },
    b: { account: 'shared', windows: { five_hour: { used: 25, at: 2 } } }, c: { account: 'hidden', windows: {} }
  } } };
  const result = planningEvidence(s, { machines: [{ workerId: 'a' }, { workerId: 'b' }] });
  assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].windows.five_hour.used, 25);
  assert.deepEqual(result.averages, s.by_kind); assert.equal(JSON.stringify(result).includes('hidden'), false);
});
