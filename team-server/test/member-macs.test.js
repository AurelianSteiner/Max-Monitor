const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");

test("only current members appear as Macs and admin deletion is permanent", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-member-macs-"));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = "member-macs-test-owner";
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
  const route = "/v1/teams/MACS1234";
  const owner = "member-macs-test-owner";
  const call = async (endpoint, method = "GET", body, token = owner) => {
    const response = await fetch(`${base}${endpoint === "/v1/reports" ? endpoint : route + endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, role) => (await call("/members", "POST", { name, role })).body.member;
  const admin = await create("Admin", "admin");
  const guest = await create("Gast", "guest");
  const member = await create("Mac-Mitglied", "member");
  const survivor = await create("Bleibt", "member");
  const device = (number) => `610be10e-8a00-4e00-b000-${String(number).padStart(12, "0")}`;
  const heartbeat = (number, workerId) => ({ deviceId: device(number), name: `Mac ${number}`, workerId, accounts: [], limits: [], reportedAt: new Date().toISOString() });
  const enrollment = { deviceId: device(3), workerId: "hub-member" };
  const hub = (await call("/workers/enroll", "POST", enrollment)).body.member;
  await call("/heartbeat", "POST", heartbeat(1, "member-one"), member.token);
  await call("/heartbeat", "POST", heartbeat(2, "member-two"), member.token);
  await call("/heartbeat", "POST", heartbeat(4, "survivor"), survivor.token);
  await call("/v1/reports", "POST", { teamId: "MACS1234", person: "ignored", limits: [{ label: "5h", percent: 10 }] }, member.token);
  const queue = { tasks: [{ id: "shared-task", title: "Gemeinsame Aufgabe", workflow: "newsletter", status: "running", workerId: "member-one" }], source: { name: "Test" }, observedWorkers: ["hub-member", "member-one", "orphan-hub"].map((workerId) => ({ workerId, name: workerId, lastSeenAt: new Date().toISOString() })) };
  assert.equal((await call("/queue", "POST", queue, admin.token)).status, 200);
  const dir = path.join(directory, "MACS1234");
  const fleetPath = path.join(dir, "fleet.json");
  // Simulate telemetry retained from the old role rules and removed memberships.
  const state = JSON.parse(fs.readFileSync(fleetPath, "utf8"));
  for (const [index, ownerId] of [admin.id, guest.id, "missing-member", "__team_owner__"].entries()) {
    state.machines.push({ ...state.machines[0], deviceId: device(index + 10), workerId: `hidden-${index}`, ownerId });
    state.events.push({ type: "machine_registered", entityId: device(index + 10), deviceId: device(index + 10) });
    fs.writeFileSync(path.join(dir, "reports", `${ownerId}.json`), JSON.stringify({ memberId: ownerId, person: "Hidden", limits: [] }));
  }
  fs.writeFileSync(fleetPath, JSON.stringify(state));
  await t.test("every viewer sees only members, including exactly bound Hub workers", async () => {
    for (const token of [owner, admin.token, guest.token, member.token]) {
      const result = (await call("/fleet", "GET", undefined, token)).body;
      assert.deepEqual(new Set(result.machines.map((machine) => machine.memberId)), new Set([member.id, survivor.id, hub.id]));
      assert.equal(result.machines.length, 4);
      assert.equal(result.capabilities.canDeleteMachines, [owner, admin.token].includes(token));
      assert.ok(result.events.every((event) => !event.deviceId || Number(event.deviceId.slice(-12)) < 10));
      assert.deepEqual((await call("/reports", "GET", undefined, token)).body.reports.map((report) => report.memberId), [member.id]);
    }
    for (const token of [owner, admin.token, guest.token]) {
      assert.equal((await call("/heartbeat", "POST", heartbeat(20, "forbidden"), token)).status, 403);
      assert.equal((await call("/v1/reports", "POST", { teamId: "MACS1234", person: "Hidden", limits: [{ label: "5h", percent: 0 }] }, token)).status, 403);
    }
  });
  await t.test("changing a member to admin immediately hides their Mac without deleting telemetry", async () => {
    assert.equal((await call(`/members/${survivor.id}`, "PATCH", { role: "admin" })).status, 200);
    assert.ok(!(await call("/fleet")).body.machines.some((machine) => machine.memberId === survivor.id));
    assert.equal((await call("/heartbeat", "POST", heartbeat(4, "survivor"), survivor.token)).status, 403);
    assert.equal((await call(`/members/${survivor.id}`, "PATCH", { role: "member" })).status, 200);
    assert.ok((await call("/fleet")).body.machines.some((machine) => machine.memberId === survivor.id));
  });
  await t.test("members and guests cannot delete; admins cannot delete other access roles", async () => {
    for (const token of [member.token, guest.token]) assert.equal((await call(`/members/${member.id}`, "DELETE", undefined, token)).status, 403);
    for (const target of [admin, guest]) assert.equal((await call(`/members/${target.id}`, "DELETE", undefined, admin.token)).status, 403);
  });
  await t.test("admin deletion revokes access and purges every Mac, report and history", async () => {
    assert.equal((await call(`/members/${member.id}`, "DELETE", undefined, admin.token)).status, 200);
    assert.equal((await call("/me", "GET", undefined, member.token)).status, 401);
    assert.equal((await call("/heartbeat", "POST", heartbeat(1, "member-one"), member.token)).status, 401);
    assert.ok(!(await call("/members")).body.members.some((entry) => entry.id === member.id));
    assert.ok(!fs.existsSync(path.join(dir, "reports", `${member.id}.json`)));
    assert.ok(!fs.existsSync(path.join(dir, "history", `${member.id}.ndjson`)));
    const stored = JSON.parse(fs.readFileSync(fleetPath, "utf8"));
    assert.ok(stored.machines.every((mac) => mac.ownerId !== member.id));
    assert.ok(stored.events.every((event) => ![device(1), device(2)].includes(event.deviceId || event.entityId)));
    assert.ok(stored.observedWorkers.every((worker) => worker.workerId !== "member-one"));
    assert.equal(stored.queue.tasks[0].id, "shared-task");
    assert.equal((await call(`/members/${member.id}/history`)).status, 404);
  });
  await t.test("Hub-only deletion blocks re-enrollment and survives restart and stale queue sync", async () => {
    assert.equal((await call(`/members/${hub.id}`, "DELETE", undefined, admin.token)).status, 200);
    await stop(); base = await start();
    assert.equal((await call("/queue", "POST", queue, admin.token)).status, 200);
    const visible = (await call("/fleet")).body;
    assert.deepEqual(visible.machines.map((machine) => machine.memberId), [survivor.id]);
    assert.equal(visible.queue.tasks[0].id, "shared-task");
    assert.equal((await call("/workers/enroll", "POST", enrollment)).status, 410);
    assert.equal((await call("/workers/enroll", "POST", { ...enrollment, deviceId: device(30) })).status, 410);
    assert.equal((await call("/workers/enroll", "POST", { ...enrollment, workerId: "new-worker" })).status, 410);
    assert.equal((await call("/heartbeat", "POST", heartbeat(1, "member-one"), survivor.token)).status, 410);
    const stored = JSON.parse(fs.readFileSync(fleetPath, "utf8"));
    assert.ok(stored.observedWorkers.every((worker) => !["member-one", "hub-member"].includes(worker.workerId)));
  });
  await t.test("a heartbeat started before deletion cannot restore the Mac", async () => {
    const racing = await create("Buffered", "member");
    const seen = once(server, "request");
    const pending = http.request(`${base}${route}/heartbeat`, { method: "POST", headers: { Authorization: `Bearer ${racing.token}`, "Content-Type": "application/json" } });
    const response = once(pending, "response");
    const payload = JSON.stringify(heartbeat(31, "buffered"));
    pending.write(payload.slice(0, 10));
    await seen;
    assert.equal((await call(`/members/${racing.id}`, "DELETE", undefined, admin.token)).status, 200);
    pending.end(payload.slice(10));
    const [result] = await response;
    result.resume();
    assert.equal(result.statusCode, 401);
    assert.ok(!(await call("/fleet")).body.machines.some((mac) => mac.deviceId === device(31)));
  });
  await t.test("corrupt storage fails without losing the membership and can be retried", async () => {
    const validFleet = fs.readFileSync(fleetPath, "utf8");
    const membersPath = path.join(dir, "members.json");
    const validMembers = fs.readFileSync(membersPath, "utf8");
    fs.writeFileSync(fleetPath, "{broken");
    assert.equal((await call(`/members/${survivor.id}`, "DELETE", undefined, admin.token)).status, 500);
    assert.equal(fs.readFileSync(membersPath, "utf8"), validMembers);
    fs.writeFileSync(fleetPath, validFleet);
    fs.writeFileSync(membersPath, "{broken");
    assert.equal((await call(`/members/${survivor.id}`, "DELETE")).status, 500);
    assert.equal(fs.readFileSync(fleetPath, "utf8"), validFleet);
    fs.writeFileSync(membersPath, validMembers);
    assert.equal((await call(`/members/${survivor.id}`, "DELETE", undefined, admin.token)).status, 200);
  });
});
