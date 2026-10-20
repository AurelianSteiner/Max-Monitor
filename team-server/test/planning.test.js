const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const model = require('../public/planning-model');
const { readPlanning, savePlanning, planningEvidence } = require('../planning');
const NOW = Date.parse('2026-10-20T06:00:00Z');
function fixture(count = 1, shared = false) {
  const costs = Object.fromEntries(model.KINDS.map(k => [k, {
    five_hour_pp: { mean: 10, sd: 0, n: 10 }, weekly_pp: { mean: 10, sd: 0, n: 10 }, duration_seconds: { mean: 3600, sd: 0, n: 10 }
  }]));
  const workers = {}, fleet = [];
  for (let i = 0; i < count; i++) {
    const id = 'mac-' + i;
    workers[id] = { account: shared ? 'same-account' : 'account-' + i, costs: structuredClone(costs),
      windows: { five_hour: { used: 0, at: NOW / 1000, reset: null }, seven_day: { used: 0, at: NOW / 1000, reset: NOW / 1000 + 86400 * 6 } } };
    fleet.push({ worker_id: id, seen_at: new Date(NOW).toISOString(), annahme: true, max_tasks: 1,
      plaetze: { newsletter: 1, korrektur: 1, klaviyo: 1, translation: 1, sales: 1 } });
  }
  return { generated_at: new Date(NOW).toISOString(), scheduling: { generated_at: new Date(NOW).toISOString(), workers, routing: { available: true, fleet } }, backlog: {}, backlogFresh: true };
}
const config = extra => ({ ...structuredClone(model.DEFAULTS), horizon: 7, startMode: 'cycle', hoursPerDay: 12, reserve: 0, conservative: false, includeQueue: false,
  newsletters: 1, correctionsPerNewsletter: 0, uploadsPerNewsletter: 0, ...extra });
const run = (s, c, expanded = false) => model.evaluate(s, config(c), expanded, NOW);
test('weekly quota bounds the whole period; daily capacity is not multiplied into a weekly promise', () => {
  const r = run(fixture(), {});
  assert.equal(r.maximum, 10); assert.equal(r.fits, true); assert.equal(r.remaining.newsletter, 9);
  assert.ok(r.utilization <= 1);
});
test('shared accounts count once; independent accounts add their measured capacity', () => {
  assert.equal(run(fixture(2, true), {}).maximum, 10);
  assert.equal(run(fixture(2), {}).maximum, 20);
});
test('complete packages include correction rounds and upload, rounded upwards', () => {
  assert.equal(run(fixture(), { correctionsPerNewsletter: 1, uploadsPerNewsletter: 1 }).maximum, 3);
  const r = run(fixture(), { newsletters: 3, correctionsPerNewsletter: .5, uploadsPerNewsletter: 1 });
  assert.equal(r.requested.correction, 2); assert.equal(r.fits, true);
  assert.equal(r.remaining.upload, 2);
});
test('reserve and observed variance reduce the feasible mix', () => {
  const s = fixture(); s.scheduling.workers['mac-0'].costs.newsletter.weekly_pp.sd = 10;
  assert.equal(run(s, { conservative: true, reserve: 20 }).maximum, 4);
});
test('one-day throughput respects per-kind and total physical slots', () => {
  const s = fixture();
  s.scheduling.workers['mac-0'].costs.newsletter.weekly_pp.mean = 1;
  s.scheduling.workers['mac-0'].costs.newsletter.five_hour_pp.mean = 1;
  assert.equal(run(s, { horizon: 1, hoursPerDay: 8 }).maximum, 8);
  s.scheduling.routing.fleet[0].max_tasks = 2;
  assert.equal(run(s, { horizon: 1, hoursPerDay: 8 }).maximum, 8);
  s.scheduling.routing.fleet[0].plaetze.newsletter = 2;
  assert.equal(run(s, { horizon: 1, hoursPerDay: 8 }).maximum, 16);
});
test('5-hour window resets at its own time and does not grant five full windows per day', () => {
  const s = fixture(), c = s.scheduling.workers['mac-0'].costs.newsletter;
  c.five_hour_pp.mean = 50; c.weekly_pp.mean = 1; c.duration_seconds.mean = 900;
  assert.equal(run(s, { horizon: 1, hoursPerDay: 12 }).maximum, 6);
});
test('live quota uses actual used values; unconfirmed expired resets and stale windows exclude the account', () => {
  const s = fixture(), q = s.scheduling.workers['mac-0']; q.windows.seven_day.used = 90;
  assert.equal(run(s, { startMode: 'live', horizon: 1 }).maximum, 1);
  q.windows.seven_day.reset = NOW / 1000 - 1;
  assert.equal(run(s, { startMode: 'live', horizon: 1 }).machines, 0);
  q.windows.seven_day.reset = NOW / 1000 + 86400; q.windows.five_hour.at -= 901;
  assert.equal(run(s, { startMode: 'live', horizon: 1 }).machines, 0);
});
test('fresh full-cycle planning does not pretend to know current remaining budget', () => {
  const s = fixture(); s.scheduling.workers['mac-0'].windows = {};
  assert.equal(run(s, { startMode: 'cycle' }).maximum, 10);
  assert.equal(run(s, { startMode: 'live' }).machines, 0);
});
test('existing queue is reserved before the new mix; unknown backlog prevents a fit claim', () => {
  const s = fixture(); s.backlog = { correction: 8 };
  assert.equal(run(s, { includeQueue: true }).maximum, 2);
  s.unsupportedBacklog = 1;
  const r = run(s, { includeQueue: true }); assert.equal(r.ready, false); assert.equal(r.fits, false);
  s.unsupportedBacklog = 0; s.backlogFresh = false;
  assert.equal(run(s, { includeQueue: true }).ready, false);
});
test('missing, zero-cost or small-sample inputs never silently become capacity', () => {
  const s = fixture(), cost = s.scheduling.workers['mac-0'].costs.newsletter;
  for (const metric of ['duration_seconds', 'five_hour_pp', 'weekly_pp']) {
    const previous = cost[metric]; cost[metric] = { mean: 0, n: 10, sd: 0 };
    assert.equal(run(s, {}).ready, false); cost[metric] = previous;
  }
  cost.weekly_pp.n = 4;
  assert.equal(run(s, {}).ready, false);
  const c = { overrides: { 'mac-0': { newsletter: { weekly: 10 } } } };
  assert.equal(run(s, c).ready, true); assert.equal(run(s, c).manual, true);
});
test('per-account costs are not pooled across different subscriptions', () => {
  const s = fixture(2); s.scheduling.workers['mac-1'].costs.newsletter.weekly_pp.mean = 20;
  assert.equal(run(s, {}).maximum, 15);
});
test('more Macs without more accounts cannot increase quota; new reference accounts are explicit scenarios', () => {
  const s = fixture(), c = { extraMacs: 2, extraAccounts: 0, referenceWorker: 'mac-0' };
  assert.equal(run(s, c, true).maximum, 10);
  assert.equal(run(s, { ...c, extraAccounts: 2 }, true).maximum, 30);
  assert.equal(run(s, { ...c, extraAccounts: 2, fiveHourFactor: 2, weeklyFactor: 2 }, true).maximum, 50);
});
test('account overrides apply once across Macs sharing that account', () => {
  const s = fixture(2, true);
  const r = run(s, { overrides: { 'mac-1': { newsletter: { weekly: 20 } } } });
  assert.equal(r.maximum, 5);
});
test('stale/paused machines and missing reservation evidence remain explicit', () => {
  const s = fixture(); s.scheduling.routing.fleet[0].annahme = false;
  assert.equal(run(s, { startMode: 'live' }).ready, false);
  assert.equal(run(s, { startMode: 'cycle' }).ready, true);
  s.scheduling.routing.available = false;
  assert.equal(run(s, {}).ready, false);
});
test('Berlin work calendar handles weekends and the October DST transition', () => {
  const friday = Date.parse('2026-10-23T08:00:00Z');
  const next = model.calendar(config({ horizon: 1 }), friday)[0];
  assert.equal(next.date, '2026-10-26'); assert.equal(new Date(next.start).toISOString(), '2026-10-26T07:00:00.000Z');
  const days = model.calendar(config({ horizon: 7 }), friday);
  assert.equal(days.filter(d => d.hours > 0).length, 5);
  assert.equal(days.reduce((n, d) => n + d.hours, 0), 60);
});
test('config rejects invalid ranges, unknown fields and inherited-looking keys', () => {
  for (const extra of [{ extraAccounts: 1 }, { startHour: 20, hoursPerDay: 12 }, { reserve: -1 }, { newsletters: NaN }, { weeklyFactor: 0 }, { fiveHourFactor: 100 }, { horizon: 365 }, { surprise: true }, { overrides: { x: { newsletter: { tokens: 1 } } } }])
    assert.equal(model.validConfig(config(extra)), false, JSON.stringify(extra));
  assert.equal(model.validConfig(config()), true);
});
test('central planning persists atomically with revisions and never writes an effort policy', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readPlanning(dir).revision, 0);
  assert.equal(savePlanning(dir, { revision: 0, config: config() }, { id: 'admin' }).revision, 1);
  assert.equal(fs.statSync(path.join(dir, 'planning.json')).mode & 0o777, 0o600);
  assert.throws(() => savePlanning(dir, { revision: 0, config: config() }, {}), { status: 409 });
  assert.throws(() => savePlanning(dir, { revision: 1, config: config({ extraAccounts: 2 }) }, {}), { status: 400 });
  assert.equal(fs.existsSync(path.join(dir, 'effort-policy.json')), false);
});
test('queue evidence excludes human holds and reserves running tasks completely', () => {
  const s = fixture(), tasks = [
    { status: 'queued', workflow: 'pre-gen' }, { status: 'running', workflow: 'correction' },
    { status: 'queued', workflow: 'upload', tags: ['manuell'] }, { status: 'queued', workflow: 'newsletter', phase: 'Wartet · PM-Rückfrage' },
    { status: 'paused', workflow: 'upload' }, { status: 'queued', workflow: 'new-kind' }
  ];
  const e = planningEvidence(s, { queue: { tasks, source: { lastSuccessAt: new Date(NOW).toISOString() } } }, NOW);
  assert.equal(e.backlog.newsletter, 1); assert.equal(e.backlog.correction, 1); assert.equal(e.backlog.upload, 0);
  assert.equal(e.unsupportedBacklog, 1); assert.equal(e.deferred, 3); assert.equal(e.backlogFresh, true);
  assert.equal(JSON.stringify(e).includes('new-kind'), false);
});
test('planning cannot restore hidden or deleted Macs through quota snapshots', () => {
  const summary = fixture(2);
  const e = planningEvidence(summary, { machines: [{ workerId: 'mac-0', name: 'Visible' }], queue: { tasks: [] } }, NOW);
  assert.deepEqual(Object.keys(e.scheduling.workers), ['mac-0']);
  assert.deepEqual(e.scheduling.routing.fleet.map(m => m.worker_id), ['mac-0']);
  assert.equal(summary.scheduling.routing.fleet.length, 2);
});
