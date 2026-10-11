const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

test("switching off a Mac hides it even when its app reports as the enabled owner", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-disabled-macs-"));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = "disabled-macs-test-owner";
  delete process.env.TEAM_TOKENS;
  const { server } = require("../server");
  let base;
  const start = async () => {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/v1/teams/OFF12345`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await start();
  t.after(async () => { if (server.listening) await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (route, method = "GET", body, token = process.env.TEAM_TOKEN) => {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, `${method} ${route}`);
    return response.json();
  };
  const deviceId = "610be10e-8a00-4e00-b000-000000000091";
  const otherDevice = "610be10e-8a00-4e00-b000-000000000092";
  const workerId = "macbook-till-main";
  const { member } = await call("/workers/enroll", "POST", { deviceId, workerId });
  await call("/members/team-owner", "PATCH", { macWorker: true });
  const heartbeat = { deviceId, workerId, name: "MacBook Till Main", limits: [], reportedAt: new Date().toISOString() };
  await call("/heartbeat", "POST", heartbeat);
  // Similar display names must not hide a different, enabled Mac.
  await call("/heartbeat", "POST", { ...heartbeat, deviceId: otherDevice, workerId: "macbook-till-main-2" });
  const queue = {
    tasks: [{ id: "shared-task", title: "Newsletter", workflow: "newsletter", status: "completed", workerId }],
    source: { name: "Test", lastSuccessAt: new Date().toISOString() },
    observedWorkers: [{ workerId, name: workerId, lastSeenAt: new Date(Date.now() - 60 * 60000).toISOString() }],
    workerIssues: [{ id: "worker-missing", workerId, stage: "claude", severity: "error", message: "Worker Meldung fehlt", reportedAt: new Date().toISOString() }],
  };
  await call("/queue", "POST", queue);
  assert.equal((await call("/fleet")).machines.length, 2);
  await call(`/members/${member.id}`, "PATCH", { macWorker: false });
  const assertHidden = async () => {
    for (const token of [process.env.TEAM_TOKEN, member.token]) {
      const fleet = await call("/fleet", "GET", undefined, token);
      assert.deepEqual(fleet.machines.map(mac => mac.deviceId), [otherDevice]);
      assert.ok(!fleet.events.some(event => event.type.startsWith("machine_") && (event.deviceId || event.entityId) === deviceId));
      assert.ok(!fleet.events.some(event => event.type.startsWith("worker_") && (event.workerId || event.entityId) === workerId));
      assert.equal(fleet.queue.tasks[0].id, "shared-task");
    }
  };
  await assertHidden();
  // Owner telemetry and stale Hub diagnostics must not bring the disabled Mac back.
  await call("/heartbeat", "POST", heartbeat);
  await call("/queue", "POST", queue);
  await stop(); await start();
  await assertHidden();
  // An older app may omit its Worker ID; its enrolled device UUID still identifies it.
  await call("/heartbeat", "POST", { ...heartbeat, workerId: undefined });
  await assertHidden();
  await call(`/workers/${workerId}/control?deviceId=${deviceId}`);
  await assertHidden();
  // Opt-in restores retained telemetry without a fresh heartbeat or re-enrollment.
  await call(`/members/${member.id}`, "PATCH", { macWorker: true });
  const restored = (await call("/fleet")).machines.find(mac => mac.deviceId === deviceId);
  assert.equal(restored.workerId, workerId);
  assert.equal(restored.workerIssues[0].message, "Worker Meldung fehlt");
  assert.equal((await call("/members")).members.find(entry => entry.id === member.id).macWorker, true);
});
