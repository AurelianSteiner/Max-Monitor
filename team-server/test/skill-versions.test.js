const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateSkillRelease, newerSkillRelease } = require('../skill-versions');
const { validateReport, publicReport } = require('../worker-reports');
const { createFleetStore } = require('../fleet');
const now = Date.now();
const release = (revision = 'a', age = 60000, version = 'V1.104') => ({ revision: revision.repeat(40),
  publishedAt: new Date(now - age).toISOString(), checkedAt: new Date(now).toISOString(),
  items: [{ id: 'content-creation', version, tree: revision.repeat(40) }] });
const report = (skills, worker = 'mac-1') => ({ schema: 1, workerId: worker, sampledAt: new Date(now).toISOString(),
  service: { running: true, lastPollAt: new Date(now).toISOString() }, activity: { state: 'idle', acceptingTasks: true, runs: [] }, skillRelease: skills });

test('skill reports accept only bounded, revision-bound public metadata', () => {
  const source = { ...release(), secret: 'not public', items: [{ ...release().items[0], sourcePath: '/private/skill' }] };
  assert.deepEqual(validateSkillRelease(source, now), release());
  for (const invalid of [ { ...source, revision: 'unknown' }, { ...source, checkedAt: new Date(now + 60000).toISOString() },
    { ...source, publishedAt: new Date(now + 60000).toISOString() }, { ...source, items: [] },
    { ...source, items: [source.items[0], source.items[0]] }, { ...source, items: [{ ...source.items[0], version: 'latest' }] },
    { ...source, items: [{ ...source.items[0], id: '../secret' }] } ]) assert.throws(() => validateSkillRelease(invalid, now));
  assert.equal(validateReport(report(undefined), now).skillRelease, undefined, 'old agents stay compatible');
});
test('skill freshness requires a recent successful skill sync and a recent agent report independently of worker liveness', () => {
  const accepted = validateReport(report(release()), now);
  assert.equal(publicReport(accepted, now + 44000).skillRelease.fresh, true);
  assert.equal(publicReport(accepted, now + 46000).skillRelease.fresh, false);
  const oldSync = { ...release(), checkedAt: new Date(now - 181000).toISOString(), publishedAt: new Date(now - 200000).toISOString() };
  const observed = publicReport(validateReport(report(oldSync), now), now);
  assert.equal(observed.activity.fresh, true); assert.equal(observed.skillRelease.fresh, false);
});
test('an older Mac cannot roll back the latest reference, including commits with the same timestamp', () => {
  const latest = release('b', 60000, 'V1.105');
  assert.equal(newerSkillRelease(latest, release('a', 120000)), latest);
  assert.equal(newerSkillRelease(latest, release('a', 60000)), latest);
  assert.equal(newerSkillRelease(latest, release('c', 60000, 'V1.106')).revision, 'c'.repeat(40));
});
test('the reference survives relay restart and old or missing reports, and becomes explicitly unverified without current sync evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-')); let clock = now;
  try {
    let store = createFleetStore(directory, () => clock);
    store.updateQueue('TEAM1234', { source: { name: 'test' }, tasks: [], observedWorkers: [
      { workerId: 'mac-1', name: 'mac-1', lastSeenAt: new Date(now).toISOString() },
      { workerId: 'mac-2', name: 'mac-2', lastSeenAt: new Date(now).toISOString() } ] });
    store.workerReport('TEAM1234', report(release('b', 60000, 'V1.105')));
    store.workerReport('TEAM1234', report(release('a', 120000), 'mac-2'));
    store = createFleetStore(directory, () => clock);
    let snapshot = store.snapshot('TEAM1234');
    assert.equal(snapshot.skillRelease.items[0].version, 'V1.105'); assert.equal(snapshot.skillRelease.fresh, true);
    assert.equal(snapshot.machines.find(m => m.workerId === 'mac-2').skillRelease.items[0].version, 'V1.104');
    clock += 46000;
    assert.equal(store.snapshot('TEAM1234').skillRelease.fresh, false);
    const fresh = { ...report(undefined), sampledAt: new Date(clock).toISOString(), service: { running: true, lastPollAt: new Date(clock).toISOString() } };
    store.workerReport('TEAM1234', fresh);
    snapshot = store.snapshot('TEAM1234');
    assert.equal(snapshot.skillRelease.items[0].version, 'V1.105'); assert.equal(snapshot.skillRelease.fresh, false);
    assert.equal(snapshot.machines.find(m => m.workerId === 'mac-1').activity.fresh, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
