const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFleetStore } = require('../fleet');
const identities = require('../worker-identities.json');

test('eight cosmetic aliases preserve persisted device, enrollment and task identities', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-colors-'));
  const now = new Date().toISOString();
  const store = createFleetStore(directory);
  const colored = Object.entries(identities).filter(([, value]) => value.color);
  assert.equal(colored.length, 8);
  assert.equal(new Set(colored.map(([, value]) => value.color)).size, 8);
  assert.equal(new Set(colored.map(([, value]) => value.name)).size, 8);
  try {
    colored.forEach(([workerId], index) => {
      const deviceId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      store.heartbeat('DEMO1234', { role: 'super' }, { schema: 1, deviceId, name: 'Original macOS name',
        workerId, reportedAt: now, isAwake: true, limits: [], accounts: [] });
    });
    const tasks = colored.map(([workerId], index) => ({id: `job-${index}`, title: 'Running job',
      workflow: 'newsletter', status: 'running', workerId, attemptId: `attempt-${index}`}));
    store.updateQueue('DEMO1234', {source: {name: 'Test'}, tasks});
    const file = path.join(directory, 'DEMO1234/fleet.json');
    const before = JSON.parse(fs.readFileSync(file));
    const result = store.snapshot('DEMO1234');
    for (const machine of result.machines) {
      assert.equal(machine.name, identities[machine.workerId].name);
      assert.equal(machine.deviceName, 'Original macOS name');
      const persisted = before.machines.find(entry => entry.deviceId === machine.deviceId);
      assert.equal(persisted.workerId, machine.workerId);
      assert.equal(persisted.name, 'Original macOS name');
    }
    for (const task of result.queue.tasks) {
      const original = tasks.find(entry => entry.id === task.id);
      assert.equal(task.workerId, original.workerId);
      assert.equal(task.attemptId, original.attemptId);
      assert.equal(task.status, original.status);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).machines, before.machines);
    assert.deepEqual(result.workerIdentities['macbook-von-till-main-2'], {name: 'MacBook von Till', personal: true});
    assert.equal(result.workerIdentities['macbook-till-main'], undefined);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
