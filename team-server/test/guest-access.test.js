const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

test("guests share the team and complete tasks without ever becoming reporting Macs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-guests-"));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = "guest-test-owner";
  delete process.env.TEAM_TOKENS;
  const { server } = require("../server");
  const start = async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  let base = await start();
  t.after(async () => { if (server.listening) await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const endpoint = "/v1/teams/DEMO1234";
  const request = async (route, method = "GET", body, token = "guest-test-owner") => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const call = (route, ...args) => request(`${endpoint}${route}`, ...args);
  const create = async (name, role) => (await call("/members", "POST", { name, role })).body.member;
  const viewer = await create("Vale", "member");
  const worker = await create("Worker", "member");
  const guest = await create("Guest", "guest");
  assert.equal(guest.role, "guest");
  assert.equal((await call("/me", "GET", undefined, guest.token)).body.role, "guest");
  const device = "610be10e-8a00-4e00-b000-000000000001";
  const workerDevice = "610be10e-8a00-4e00-b000-000000000002";
  const heartbeat = (deviceId, name) => ({ deviceId, name, accounts: [], limits: [], reportedAt: new Date().toISOString() });
  assert.equal((await call("/heartbeat", "POST", heartbeat(device, "Viewer Mac"), viewer.token)).status, 200);
  assert.equal((await call("/heartbeat", "POST", heartbeat(workerDevice, "Worker Mac"), worker.token)).status, 200);
  const report = { teamId: "DEMO1234", person: "ignored", limits: [{ label: "5h", percent: 10 }] };
  assert.equal((await request("/v1/reports", "POST", report, viewer.token)).status, 200);
  assert.equal((await request("/v1/reports", "POST", report, worker.token)).status, 200);

  const changed = await call(`/members/${viewer.id}`, "PATCH", { role: "guest" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.member.token, viewer.token);
  assert.equal(changed.body.member.name, viewer.name);
  assert.equal(changed.body.member.createdAt, viewer.createdAt);
  assert.equal((await call("/me", "GET", undefined, viewer.token)).body.role, "guest");

  for (const token of [viewer.token, guest.token, worker.token, "guest-test-owner"]) {
    const fleet = (await call("/fleet", "GET", undefined, token)).body;
    assert.deepEqual(fleet.machines.map((mac) => mac.deviceId), [workerDevice]);
    assert.ok(fleet.events.every((event) => event.deviceId !== device));
    const reports = (await call("/reports", "GET", undefined, token)).body.reports;
    assert.deepEqual(reports.map((entry) => entry.memberId), [worker.id]);
  }
  const membership = (await call("/members", "GET", undefined, guest.token)).body.members;
  assert.equal(membership.length, 3);
  assert.ok(membership.every((member) => !Object.hasOwn(member, "token")));
  assert.equal((await call(`/members/${worker.id}/history`, "GET", undefined, guest.token)).status, 200);

  const fleetPath = path.join(directory, "DEMO1234", "fleet.json");
  const before = fs.readFileSync(fleetPath, "utf8");
  for (const token of [viewer.token, guest.token]) {
    assert.equal((await call("/heartbeat", "POST", heartbeat(device, "Must not appear"), token)).status, 403);
    assert.equal((await request("/v1/reports", "POST", report, token)).status, 403);
    assert.equal((await call("/queue", "POST", { tasks: [], source: {} }, token)).status, 403);
    assert.equal((await call("/members", "POST", { name: "Escalation", role: "admin" }, token)).status, 403);
    assert.equal((await call(`/members/${worker.id}`, "PATCH", { role: "admin" }, token)).status, 403);
    assert.equal((await call(`/members/${worker.id}`, "DELETE", undefined, token)).status, 403);
    assert.equal((await call("/workers/enroll", "POST", {}, token)).status, 403);
  }
  assert.equal(fs.readFileSync(fleetPath, "utf8"), before);
  assert.equal((await call(`/members/${viewer.id}`, "PATCH", { role: "super" })).status, 400);
  assert.equal((await call(`/members/${viewer.id}`, "PATCH", null)).status, 400);
  assert.equal((await call("/members/missing", "PATCH", { role: "guest" })).status, 404);

  // Guest task actions remain available, independently of device reporting.
  await call("/queue", "POST", { tasks: [{ id: "blocked-task", title: "Review", workflow: "newsletter", status: "blocked" }], source: { name: "Test" } });
  const task = (await call("/fleet", "GET", undefined, guest.token)).body.queue.tasks[0];
  const completion = await call("/fleet/tasks/complete", "POST", { taskId: task.id, taskVersion: task.taskVersion }, guest.token);
  assert.equal(completion.status, 200);
  assert.equal(completion.body.task.status, "completed");

  await stop();
  base = await start();
  assert.equal((await call("/me", "GET", undefined, viewer.token)).body.role, "guest");
  assert.deepEqual((await call("/fleet")).body.machines.map((mac) => mac.deviceId), [workerDevice]);
  assert.equal((await call("/fleet")).body.queue.tasks[0].status, "completed");

  // Stored data is preserved; reverting a mistaken role change restores it.
  assert.equal((await call(`/members/${viewer.id}`, "PATCH", { role: "member" })).status, 200);
  assert.equal((await call("/fleet")).body.machines.length, 2);
  assert.equal((await call("/reports")).body.reports.length, 2);
  const enrolled = (await call("/workers/enroll", "POST", { workerId: "enrolled-worker", deviceId: "610be10e-8a00-4e00-b000-000000000003" })).body.member;
  assert.equal((await call(`/members/${enrolled.id}`, "PATCH", { role: "guest" })).status, 409);
  assert.equal((await call("/me", "GET", undefined, enrolled.token)).body.role, "member");
  fs.writeFileSync(path.join(directory, "DEMO1234", "members.json"), "invalid json");
  assert.equal((await call(`/members/${viewer.id}`, "PATCH", { role: "guest" })).status, 500);
});
