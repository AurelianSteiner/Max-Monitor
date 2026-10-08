const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFleetStore } = require("../fleet");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-liveness-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = Date.parse("2026-10-08T10:00:00Z");
  const store = () => createFleetStore(directory, () => time);
  const date = () => new Date(time).toISOString();
  const beat = () => store().heartbeat("DEMO1234", { member: { id: "worker", name: "Worker" } }, {
    deviceId: "610be10e-8a00-4e00-b000-000000000001", name: "Mac", workerId: "worker-1",
    reportedAt: date(), batteryPercent: 8, powerSource: "battery", isAwake: true,
    monitoringAccountId: "account", usageUpdatedAt: date(),
    accounts: [{ accountId: "account", name: "Worker Claude", provider: "claude", usageUpdatedAt: date() }],
    limits: [{ accountId: "account", label: "5h", kind: "session", percent: 43 }],
  });
  const queue = (workers) => store().updateQueue("DEMO1234", {
    tasks: [], source: { name: "ClickUp", lastSuccessAt: date() },
    ...(workers === undefined ? {} : { observedWorkers: workers }),
  });
  const worker = (overrides = {}) => ({ workerId: "worker-1", name: "Mac", lastSeenAt: date(), ...overrides });
  return { store, date, beat, queue, worker, advance: (ms) => { time += ms; } };
}

test("a running worker keeps its Mac online without refreshing app telemetry, including after restart", (t) => {
  const f = fixture(t);
  f.beat();
  const appDate = f.date();
  f.advance(11 * 60 * 60 * 1000);
  f.queue([f.worker()]);
  let snapshot = f.store().snapshot("DEMO1234");
  let machine = snapshot.machines[0];
  assert.equal(snapshot.machines.length, 1);
  assert.equal(machine.status, "online");
  assert.equal(machine.lastSeenAt, f.date());
  assert.equal(machine.heartbeatAgeSeconds, 0);
  assert.equal(machine.nativeStatus, "offline");
  assert.equal(machine.nativeLastSeenAt, appDate);
  assert.equal(machine.nativeHeartbeatAgeSeconds, 11 * 60 * 60);
  assert.equal(machine.workerStatus, "online");
  assert.equal(machine.workerHeartbeatAgeSeconds, 0);
  assert.equal(machine.usageUpdatedAt, appDate);
  assert.equal(machine.usageStatus, "stale");
  assert.equal(machine.limits[0].usageStale, true);
  assert.equal(machine.batteryPercent, 8); // Historical value, not a fresh measurement.
  assert.equal(snapshot.events.find((event) => event.type.startsWith("machine_")).type, "machine_online");

  f.advance(900000);
  f.store().updateQueue("DEMO1234", { source: { name: "ClickUp", error: "Unavailable" } });
  assert.equal(f.store().snapshot("DEMO1234").machines[0].status, "online");
  f.advance(1000);
  f.queue(); // A fresh queue without a worker heartbeat cannot keep the Mac alive.
  machine = f.store().snapshot("DEMO1234").machines[0];
  assert.equal(machine.status, "silent");
  assert.equal(machine.heartbeatAgeSeconds, 901);
  f.advance(899000);
  assert.equal(f.store().snapshot("DEMO1234").machines[0].status, "silent");
  f.advance(1000);
  snapshot = f.store().snapshot("DEMO1234");
  assert.equal(snapshot.machines[0].status, "offline");
  assert.equal(snapshot.events.find((event) => event.type.startsWith("machine_")).type, "machine_offline");
  f.queue([f.worker()]);
  snapshot = f.store().snapshot("DEMO1234");
  assert.equal(snapshot.machines[0].status, "online");
  assert.equal(snapshot.events.find((event) => event.type.startsWith("machine_")).type, "machine_online");
});

test("worker liveness requires an exact assignment and rejects implausible clocks", (t) => {
  const f = fixture(t);
  f.beat();
  f.advance(31 * 60000);
  const future = new Date(Date.parse(f.date()) + 6 * 60000).toISOString();
  f.queue([f.worker({ lastSeenAt: future }), f.worker({ workerId: "another-worker" })]);
  let machine = f.store().snapshot("DEMO1234").machines.find((m) => m.workerId === "worker-1");
  assert.equal(machine.status, "offline");
  assert.equal(machine.workerStatus, "offline");
  f.queue([]);
  assert.equal(f.store().snapshot("DEMO1234").machines[0].status, "offline");
  f.beat();
  f.queue([f.worker({ lastSeenAt: future })]);
  machine = f.store().snapshot("DEMO1234").machines[0];
  assert.equal(machine.status, "online");
  assert.equal(machine.nativeStatus, "online");
  assert.equal(machine.workerStatus, "offline");
  assert.equal(machine.lastSeenAt, f.date());
});
