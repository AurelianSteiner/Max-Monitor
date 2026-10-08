const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const deviceA = "610be10e-8a00-4e00-b000-000000000051";
const deviceB = "610be10e-8a00-4e00-b000-000000000052";
const owner = "test-enrollment-owner";

test("trusted enrollment safely provisions a separate ordinary token for every worker", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-enrollment-"));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKENS = `ENROLL01:${owner}`;
  delete process.env.TEAM_TOKEN;
  const { server } = require("../server");
  const helper = await import("../../scripts/enroll-monitor-worker.mjs");
  async function start() {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
  let base = await start();
  const route = "/v1/teams/ENROLL01";
  const request = async (endpoint, { token = owner, method = "GET", body } = {}) => {
    const response = await fetch(`${base}${route}${endpoint}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const identity = { workerId: "mac-5", deviceId: deviceA, name: "Mac Fünf", role: "admin" };
  const config = () => helper.configuration({ serverURL: base, teamId: "ENROLL01", ownerToken: owner });
  t.after(async () => {
    if (server.listening) await stop();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  let fifth;
  let sixth;

  await t.test("preflight is read-only and checks the deployed fleet and enrollment endpoints", async () => {
    const check = await helper.checkEnrollment(config());
    assert.equal(check.ok, true);
    assert.equal(check.role, "member");
    assert.ok(!JSON.stringify(check).includes(owner));
    assert.equal((await request("/members")).body.members.filter(member => member.role !== "super").length, 0);
    assert.ok(!fs.existsSync(path.join(directory, "ENROLL01", "members.json")));
  });

  await t.test("simultaneous retries create exactly one ordinary member and preserve its token", async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, () => request("/workers/enroll", { method: "POST", body: identity })));
    assert.ok(attempts.every((response) => response.status === 200));
    assert.equal(new Set(attempts.map((response) => response.body.member.token)).size, 1);
    assert.equal(attempts.filter((response) => response.body.created).length, 1);
    fifth = attempts[0].body.member;
    assert.equal(fifth.role, "member");
    assert.equal((await request("/members")).body.members.filter(member => member.role !== "super").length, 1);
    assert.equal(fs.statSync(path.join(directory, "ENROLL01", "members.json")).mode & 0o777, 0o600);
    assert.equal((await helper.enrollMonitorWorker(config(), identity)).token, fifth.token);
  });

  await t.test("another Mac gets a different member token; changing a bound identity fails closed", async () => {
    sixth = await helper.enrollMonitorWorker(config(), { workerId: "mac-6", deviceId: deviceB });
    assert.notEqual(sixth.token, fifth.token);
    assert.notEqual(sixth.memberId, fifth.id);
    assert.equal((await request("/workers/enroll", { method: "POST", body: { ...identity, deviceId: deviceB } })).status, 409);
    assert.equal((await request("/workers/enroll", { method: "POST", body: { ...identity, workerId: "mac-7" } })).status, 409);
    assert.equal((await request("/members")).body.members.filter(member => member.role !== "super").length, 2);
  });

  await t.test("workers cannot enroll, read member tokens, create administrators, or update the queue", async () => {
    assert.equal((await request("/workers/enroll", { token: fifth.token })).status, 403);
    assert.equal((await request("/workers/enroll", { method: "POST", token: fifth.token, body: identity })).status, 403);
    assert.equal((await request("/members", { token: fifth.token })).status, 403);
    assert.equal((await request("/members", { method: "POST", token: fifth.token, body: { name: "Admin", role: "admin" } })).status, 403);
    assert.equal((await request("/queue", { method: "POST", token: fifth.token, body: { tasks: [], source: { name: "test" } } })).status, 403);
    assert.equal((await request("/fleet", { token: sixth.token })).status, 200);
    const response = await fetch(`${base}/v1/teams/OTHER001/workers/enroll`, { headers: { authorization: `Bearer ${fifth.token}` } });
    assert.equal(response.status, 401);
  });

  await t.test("a provisioned token can report only its own app UUID and Worker ID", async () => {
    const heartbeat = { deviceId: deviceA, workerId: "mac-5", name: "Mac Fünf", reportedAt: new Date().toISOString(), limits: [] };
    assert.equal((await request("/heartbeat", { method: "POST", token: fifth.token, body: heartbeat })).status, 200);
    assert.equal((await request("/heartbeat", { method: "POST", token: fifth.token, body: { ...heartbeat, deviceId: deviceB } })).status, 409);
    assert.equal((await request("/heartbeat", { method: "POST", token: fifth.token, body: { ...heartbeat, workerId: "mac-6" } })).status, 409);
    const snapshot = (await request("/fleet", { token: sixth.token })).body;
    assert.equal(snapshot.machines[0].memberId, fifth.id);
    assert.ok(!JSON.stringify(snapshot).includes(fifth.token));
  });

  await t.test("malformed registrations never add members", async () => {
    for (const body of [null, [], { workerId: "../escape", deviceId: deviceA }, { workerId: "mac-5", deviceId: "not-a-uuid" }, { ...identity, name: "\nsecret" }]) {
      assert.equal((await request("/workers/enroll", { method: "POST", body })).status, 400);
    }
    assert.equal((await request("/members")).body.members.filter(member => member.role !== "super").length, 2);
  });

  await t.test("restart retains the exact enrollment token; corrupt storage never overwrites prior identities", async () => {
    await stop();
    base = await start();
    assert.equal((await helper.enrollMonitorWorker(config(), identity)).token, fifth.token);
    const file = path.join(directory, "ENROLL01", "members.json");
    const valid = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "{broken-json", { mode: 0o600 });
    assert.equal((await request("/workers/enroll", { method: "POST", body: identity })).status, 500);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken-json");
    fs.writeFileSync(file, valid, { mode: 0o600 });
  });
});
