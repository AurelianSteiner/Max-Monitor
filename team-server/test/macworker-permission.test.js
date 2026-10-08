const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");

test("MacWorker is independent of access roles and survives reconnects", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-macworker-"));
  const owner = "macworker-test-owner";
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = owner;
  delete process.env.TEAM_TOKENS;
  const { server } = require("../server");
  const prefix = "/v1/teams/WORK1234";
  let base;
  const start = async () => {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await start();
  t.after(async () => { if (server.listening) await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (route, method = "GET", body, token = owner) => {
    const response = await fetch(base + (route === "/v1/reports" ? route : prefix + route), {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (name, role, macWorker) => (await call("/members", "POST", { name, role, macWorker })).body.member;
  const device = index => `610be10e-8a00-4e00-b000-${String(index).padStart(12, "0")}`;
  const heartbeat = (index, workerId) => ({ deviceId: device(index), name: `Mac ${index}`, workerId,
    batteryPercent: 73, powerSource: "battery", reportedAt: new Date().toISOString(),
    monitoringAccountId: "account-1", accounts: [{ accountId: "account-1", provider: "claude", name: "Monitoring", usageUpdatedAt: new Date().toISOString() }],
    limits: [{ accountId: "account-1", label: "5h", kind: "session", percent: 37, usageUpdatedAt: new Date().toISOString() }] });
  const report = { teamId: "WORK1234", person: "ignored", limits: [{ label: "5h", percent: 37 }] };
  const member = await create("Member", "member");
  const admin = await create("Admin", "admin");
  const guest = await create("Guest", "guest");
  assert.equal(member.macWorker, true);
  assert.equal(admin.macWorker, false);
  assert.equal(guest.macWorker, false);
  assert.equal((await call("/me")).body.macWorker, false);

  await t.test("enabled admins and guests send complete telemetry without extra privileges", async () => {
    for (const [index, identity] of [admin, guest].entries()) {
      assert.equal((await call("/heartbeat", "POST", heartbeat(index + 1), identity.token)).status, 403);
      assert.equal((await call(`/members/${identity.id}`, "PATCH", { macWorker: true })).status, 200);
      const me = (await call("/me", "GET", undefined, identity.token)).body;
      assert.equal(me.role, identity.role); assert.equal(me.macWorker, true);
      assert.equal((await call("/heartbeat", "POST", heartbeat(index + 1), identity.token)).status, 200);
      assert.equal((await call("/v1/reports", "POST", report, identity.token)).status, 200);
      assert.equal((await call("/members", "POST", { name: "No escalation", role: "admin" }, identity.token)).status, 403);
      assert.equal((await call(`/members/${member.id}`, "PATCH", { macWorker: false }, identity.token)).status, 403);
      const visible = (await call("/members", "GET", undefined, identity.token)).body.members;
      assert.ok(visible.every(entry => !Object.hasOwn(entry, "token")));
    }
    assert.equal((await call("/queue", "POST", { tasks: [], source: { name: "Test" } }, guest.token)).status, 403);
    const fleet = (await call("/fleet")).body;
    assert.equal(fleet.heartbeatIntervalSeconds, 60);
    assert.equal(fleet.machines.length, 2);
    assert.ok(fleet.machines.every(mac => mac.batteryPercent === 73 && mac.limits[0].percent === 37));
  });

  await t.test("role edits preserve the independent flag and opt-out immediately stops reporting", async () => {
    const changed = await call(`/members/${member.id}`, "PATCH", { role: "guest" });
    assert.equal(changed.body.member.macWorker, true);
    assert.equal(changed.body.member.token, member.token);
    assert.equal((await call("/heartbeat", "POST", heartbeat(3, "member-worker"), member.token)).status, 200);
    assert.equal((await call(`/members/${member.id}`, "PATCH", { macWorker: false })).status, 200);
    assert.equal((await call("/heartbeat", "POST", heartbeat(3, "member-worker"), member.token)).status, 403);
    assert.equal((await call("/v1/reports", "POST", report, member.token)).status, 403);
    assert.ok(!(await call("/fleet")).body.machines.some(mac => mac.memberId === member.id));
    assert.equal((await call(`/members/${member.id}/history`)).status, 404);
    assert.equal((await call(`/members/${member.id}`, "PATCH", { macWorker: true })).status, 200);
    assert.ok((await call("/fleet")).body.machines.some(mac => mac.memberId === member.id));
  });

  await t.test("the owner resumes their existing worker Mac without duplication or losing owner access", async () => {
    const enrollment = { workerId: "owner-main", deviceId: device(4) };
    const previous = (await call("/workers/enroll", "POST", enrollment)).body.member;
    assert.equal((await call("/heartbeat", "POST", heartbeat(4, "owner-main"), previous.token)).status, 200);
    const enabled = await call("/members/team-owner", "PATCH", { macWorker: true });
    assert.equal(enabled.status, 200); assert.equal(enabled.body.member.role, "super");
    assert.ok(!Object.hasOwn(enabled.body.member, "token"));
    assert.equal((await call("/me")).body.role, "super");
    assert.equal((await call("/heartbeat", "POST", heartbeat(4, "owner-main"))).status, 200);
    const machines = (await call("/fleet")).body.machines.filter(mac => mac.workerId === "owner-main");
    assert.equal(machines.length, 1); assert.equal(machines[0].memberId, "team-owner");
    assert.equal((await call("/members/team-owner", "DELETE")).status, 403);
    assert.equal((await call("/members/team-owner", "PATCH", { role: "guest" })).status, 409);
    assert.equal((await call("/members/team-owner", "PATCH", { macWorker: false }, admin.token)).status, 403);
    // Removing the superseded member must not tombstone the owner's resumed Mac.
    assert.equal((await call(`/members/${previous.id}`, "DELETE")).status, 200);
    assert.equal((await call("/heartbeat", "POST", heartbeat(4, "owner-main"))).status, 200);
    assert.equal((await call("/members/team-owner", "PATCH", { macWorker: false })).status, 200);
    assert.equal((await call("/heartbeat", "POST", heartbeat(4, "owner-main"))).status, 403);
    assert.ok(!(await call("/fleet")).body.machines.some(mac => mac.memberId === "team-owner"));
    await call("/members/team-owner", "PATCH", { macWorker: true });
  });

  await t.test("an in-flight heartbeat cannot bypass a disabled flag", async () => {
    const seen = once(server, "request");
    const request = http.request(base + prefix + "/heartbeat", { method: "POST", headers: { Authorization: `Bearer ${guest.token}`, "Content-Type": "application/json" } });
    const response = once(request, "response");
    const payload = JSON.stringify(heartbeat(2));
    request.write(payload.slice(0, 10)); await seen;
    await call(`/members/${guest.id}`, "PATCH", { macWorker: false });
    request.end(payload.slice(10));
    const [result] = await response; result.resume();
    assert.equal(result.statusCode, 403);
  });

  await t.test("settings persist, reject malformed input, and never overwrite corrupt owner storage", async () => {
    await stop(); await start();
    assert.equal((await call("/me")).body.macWorker, true);
    assert.equal((await call("/me", "GET", undefined, guest.token)).body.macWorker, false);
    assert.equal((await call(`/members/${admin.id}`, "PATCH", { macWorker: "true" })).status, 400);
    assert.equal((await call("/members", "POST", { name: "Invalid", role: "guest", macWorker: 1 })).status, 400);
    const file = path.join(directory, "WORK1234", "owner.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "corrupt");
    assert.equal((await call("/me")).body.macWorker, false);
    assert.equal((await call("/members/team-owner", "PATCH", { macWorker: true })).status, 500);
    assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
  });
});
