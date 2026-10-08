const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { createFleetStore, FleetError } = require("../fleet");

const deviceA = "610be10e-8a00-4e00-b000-000000000001";
const deviceB = "610be10e-8a00-4e00-b000-000000000002";
function heartbeat(deviceId = deviceA, overrides = {}) {
  const date = new Date().toISOString();
  return { deviceId, name: "Mac Studio", workerId: "studio-1", reportedAt: date, batteryPercent: 78, powerSource: "ac", isCharging: true, isAwake: true, monitoringAccountId: "account-a", accounts: [{ accountId: "account-a", name: "Worker Claude", provider: "claude", usageUpdatedAt: overrides.usageUpdatedAt ?? date, usageError: overrides.usageError }], limits: [{ accountId: "account-a", label: "5 Stunden", kind: "session", percent: 43 }], usageUpdatedAt: date, ...overrides };
}

test("Mac quota is explicitly bound and never inferred from Account Limits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-binding-"));
  const clock = Date.now();
  const store = createFleetStore(directory, () => clock);
  const who = { role: "member", member: { id: "worker-1", name: "Worker" } };
  const accounts = [
    { accountId: "account-a", name: "Worker", provider: "claude" },
    { accountId: "account-b", name: "Personal", provider: "claude" },
  ];
  const limits = [
    { accountId: "account-a", label: "5h", kind: "session", percent: 0 },
    { accountId: "account-b", label: "5h", kind: "session", percent: 12 },
  ];
  try {
    const legacy = store.heartbeat("DEMO1234", who, heartbeat(deviceA, { monitoringAccountId: undefined, accounts, limits }));
    assert.equal(legacy.monitoringAccountStatus, "notConfigured");
    assert.deepEqual(legacy.limits, []);
    assert.deepEqual(legacy.accounts, []);
    assert.equal(legacy.batteryPercent, 78);
    const before = store.snapshot("DEMO1234");
    assert.throws(() => store.heartbeat("DEMO1234", who, heartbeat(deviceA, { accounts, limits })), /genau einen/);
    assert.deepEqual(store.snapshot("DEMO1234"), before);

    const bound = store.heartbeat("DEMO1234", who, heartbeat(deviceA, { accounts: [accounts[0]], limits: [limits[0]] }));
    assert.equal(bound.monitoringAccountStatus, "connected");
    assert.equal(bound.limits[0].percent, 0);
    assert.equal(bound.accounts[0].name, "Worker");

    const switched = store.heartbeat("DEMO1234", who, heartbeat(deviceA, {
      monitoringAccountId: "account-b", accounts: [{ ...accounts[1], usageError: "Keine Messung" }],
      limits: [], usageError: "Keine Messung",
    }));
    assert.deepEqual(switched.limits, []);
    assert.equal(switched.accounts[0].accountId, "account-b");

    const unlinked = store.heartbeat("DEMO1234", who, heartbeat(deviceA, {
      monitoringAccountId: undefined, accounts: [], limits: [], usageError: "Abfrage fehlgeschlagen",
    }));
    assert.deepEqual(unlinked.limits, []);
    assert.deepEqual(unlinked.accounts, []);
    assert.equal(unlinked.monitoringAccountStatus, "notConfigured");
    assert.equal(unlinked.status, "online");
    assert.deepEqual(createFleetStore(directory).snapshot("DEMO1234").machines[0].limits, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
function task(id = "clickup:newsletter:abc", overrides = {}) {
  return { id, title: "Newsletter erstellen", workflow: "newsletter", status: "queued", tags: ["pre gen.", "pre gen · wartet"], url: "https://app.clickup.com/t/abc", ...overrides };
}

test("shared authenticated relay supports fleet without changing existing report roles", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-relay-"));
  const oldEnv = { DATA_DIR: process.env.DATA_DIR, TEAM_TOKEN: process.env.TEAM_TOKEN, TEAM_TOKENS: process.env.TEAM_TOKENS };
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = "test-owner-token";
  delete process.env.TEAM_TOKENS;
  const { server } = require("../server");
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
  t.after(async () => {
    if (server.listening) await stop();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function request(route, { method = "GET", token = "test-owner-token", body, raw } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  const endpoint = "/v1/teams/DEMO1234";
  const member = (await request(`${endpoint}/members`, { method: "POST", body: { name: "Worker Eins" } })).body.member;
  const second = (await request(`${endpoint}/members`, { method: "POST", body: { name: "Worker Zwei" } })).body.member;
  const admin = (await request(`${endpoint}/members`, { method: "POST", body: { name: "Queue Bridge", role: "admin" } })).body.member;

  await t.test("fleet and heartbeat require a valid token for this team", async () => {
    assert.equal((await request(`${endpoint}/fleet`, { token: null })).status, 401);
    assert.equal((await request(`${endpoint}/fleet`, { token: "wrong" })).status, 401);
    assert.equal((await request(`${endpoint}/fleet`, { token: "é".repeat("test-owner-token".length) })).status, 401);
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: null, body: heartbeat() })).status, 401);
    assert.equal((await request("/v1/teams/OTHER123/fleet", { token: member.token })).status, 401);
  });

  await t.test("every role sees all devices; stable device ID cannot be stolen", async () => {
    const created = await request(`${endpoint}/heartbeat`, { method: "POST", token: member.token, body: heartbeat(deviceA, { apiKey: "must-not-persist" }) });
    assert.equal(created.status, 200);
    assert.equal(created.body.machine.memberId, member.id);
    assert.equal(created.body.machine.usageStatus, "fresh");
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: second.token, body: heartbeat(deviceB, { name: "Mac Mini", workerId: "mini-1" }) })).status, 200);
    for (const token of [member.token, second.token, admin.token, "test-owner-token"]) {
      const result = await request(`${endpoint}/fleet`, { token });
      assert.equal(result.status, 200);
      assert.equal(result.body.machines.length, 2);
      assert.equal(result.body.heartbeatIntervalSeconds, 600);
      assert.ok(!JSON.stringify(result.body).includes(member.token));
      assert.ok(!JSON.stringify(result.body).includes("must-not-persist"));
    }
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: second.token, body: heartbeat() })).status, 409);
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", body: heartbeat() })).status, 409);
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: second.token, body: heartbeat(deviceB, { workerId: "studio-1" }) })).status, 409);
    assert.ok(!fs.readFileSync(path.join(directory, "DEMO1234", "fleet.json"), "utf8").includes("must-not-persist"));
  });

  await t.test("malformed telemetry is rejected atomically", async () => {
    for (const body of [null, [], heartbeat("../../escape"), heartbeat(deviceA, { batteryPercent: 101 }), heartbeat(deviceA, { batteryPercent: "42" }), heartbeat(deviceA, { isAwake: "true" }), heartbeat(deviceA, { reportedAt: "not-a-date" }), heartbeat(deviceA, { limits: [{ accountId: "a", kind: "session", label: "x", percent: 3.5 }] })]) {
      assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: member.token, body })).status, 400);
    }
    assert.equal((await request(`${endpoint}/heartbeat`, { method: "POST", token: member.token, raw: "{" })).status, 400);
    assert.equal((await request(`${endpoint}/fleet`, { token: second.token })).body.machines.length, 2);
  });

  await t.test("server receive time governs availability even with a badly skewed Mac clock", async () => {
    const future = "2099-01-01T00:00:00.000Z";
    const result = await request(`${endpoint}/heartbeat`, { method: "POST", token: member.token, body: heartbeat(deviceA, { reportedAt: future, usageUpdatedAt: future }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.machine.status, "online");
    assert.equal(result.body.machine.usageStale, true);
    assert.ok(result.body.machine.clockSkewSeconds > 100000);
    assert.ok(Math.abs(Date.now() - Date.parse(result.body.machine.lastSeenAt)) < 5000);
  });

  await t.test("only admin/owner can publish full queue snapshots and failures retain cached tasks", async () => {
    const first = { tasks: [task(), task("clickup:upload:abc", { workflow: "upload", status: "running", workerId: "mini-1", phase: "Klaviyo Draft" })], source: { name: "ClickUp", lastSuccessAt: new Date().toISOString() } };
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: member.token, body: first })).status, 403);
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: first })).status, 200);
    let shared = (await request(`${endpoint}/fleet`, { token: second.token })).body;
    assert.equal(shared.queue.tasks.length, 2);
    assert.equal(shared.queue.source.status, "fresh");
    assert.ok(shared.events.some((event) => event.type === "task_running" && event.taskId === "clickup:upload:abc" && event.at));
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: { tasks: [], source: { name: "ClickUp", error: "ClickUp ist vorübergehend nicht erreichbar" } } })).status, 200);
    shared = (await request(`${endpoint}/fleet`, { token: member.token })).body;
    assert.equal(shared.queue.tasks.length, 2);
    assert.equal(shared.queue.source.status, "error");
    const savedSuccess = shared.queue.source.lastSuccessAt;
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: { source: { name: "ClickUp", error: "Noch nicht erreichbar" } } })).status, 200);
    assert.equal((await request(`${endpoint}/fleet`)).body.queue.source.lastSuccessAt, savedSuccess);
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: { source: { name: "ClickUp" } } })).status, 400);
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: { tasks: [], source: { name: "ClickUp" } } })).status, 200);
    shared = (await request(`${endpoint}/fleet`)).body;
    assert.equal(shared.queue.tasks.length, 0);
    assert.ok(shared.events.some((event) => event.type === "queue_source_recovered"));
  });

  await t.test("task event history preserves the worker at each change and explicit unassignment", async () => {
    const id = "clickup:upload:history";
    for (const [workerId, phase] of [["mini-1", "First worker"], ["mini-2", "Second worker"], [null, "Unassigned"]]) {
      const body = { tasks: [task(id, { workflow: "upload", status: "running", workerId, phase })], source: { name: "ClickUp" } };
      assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body })).status, 200);
    }
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: { tasks: [], source: { name: "ClickUp" } } })).status, 200);
    const events = (await request(`${endpoint}/fleet`, { token: member.token })).body.events.filter((event) => event.taskId === id);
    assert.equal(events.find((event) => event.message === "First worker").workerId, "mini-1");
    assert.equal(events.find((event) => event.message === "Second worker").workerId, "mini-2");
    const unassigned = events.find((event) => event.message === "Unassigned");
    assert.equal(Object.hasOwn(unassigned, "workerId"), true);
    assert.equal(unassigned.workerId, null);
    assert.ok(events.every((event) => event.workflow === "upload"));
    assert.equal(events.find((event) => event.type === "task_removed").workerId, null);
  });

  await t.test("queue has independent 2 MB body budget while reports retain 64 KB", async () => {
    const tasks = Array.from({ length: 350 }, (_, index) => task(`task-${index}`, { title: "Newsletter ".repeat(20) }));
    const queue = { tasks, source: { name: "ClickUp" } };
    assert.ok(Buffer.byteLength(JSON.stringify(queue)) > 64 * 1024);
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, body: queue })).status, 200);
    assert.equal((await request(`${endpoint}/queue`, { method: "POST", token: admin.token, raw: JSON.stringify({ tasks: [], source: { name: "x" }, excess: "x".repeat(2 * 1024 * 1024) }) })).status, 413);
    assert.equal((await request("/v1/reports", { method: "POST", body: { teamId: "DEMO1234", person: "Legacy", limits: [{ label: "Legacy", percent: 150 }], excess: "x".repeat(65 * 1024) } })).status, 413);
    assert.equal((await request(`${endpoint}/fleet`)).body.queue.tasks.length, 350);
  });

  await t.test("legacy reports, histories and member token privacy still work", async () => {
    assert.equal((await request("/v1/reports", { method: "POST", token: member.token, body: { teamId: "DEMO1234", person: "Wrong Name", limits: [{ label: "7 Tage", percent: 150 }] } })).status, 200);
    const reports = (await request(`${endpoint}/reports`, { token: second.token })).body.reports;
    assert.equal(reports[0].person, member.name);
    assert.equal(reports[0].limits[0].percent, 150);
    assert.equal((await request(`${endpoint}/members/${member.id}/history`, { token: second.token })).body.samples.length, 1);
    assert.equal((await request(`${endpoint}/members`, { token: second.token })).status, 403);
    assert.ok((await request(`${endpoint}/members`, { token: admin.token })).body.members.every((item) => !item.token));
  });

  await t.test("only whitelisted dashboard assets are public and API responses remain private", async () => {
    for (const route of ["/fleet", "/monitor", "/fleet-assets/dashboard.css", "/fleet-assets/dashboard.js"]) {
      const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-security-policy").includes("script-src 'self'"));
      assert.ok(!response.headers.get("content-security-policy").includes("unsafe-inline"));
    }
    assert.equal((await request("/fleet-assets/server.js", { token: null })).status, 404);
    assert.equal((await request("/fleet-assets/%2e%2e/members.json", { token: null })).status, 404);
    assert.equal((await request(`${endpoint}/fleet`)).headers.get("cache-control"), "no-store");
  });

  await t.test("fleet cache survives an actual HTTP server restart", async () => {
    await stop();
    base = await start();
    const shared = await request(`${endpoint}/fleet`, { token: second.token });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.machines.length, 2);
    assert.equal(shared.body.queue.tasks.length, 350);
  });

  await t.test("live updates reach every viewer and revoked members stop receiving signals", async () => {
    assert.equal((await request(`${endpoint}/fleet/events`, { token: null })).status, 401);
    assert.equal((await request('/v1/teams/OTHER123/fleet/events', { token: member.token })).status, 401);
    const viewer = (await request(`${endpoint}/members`, { method: "POST", body: { name: "Live Viewer" } })).body.member;
    const streams = [];
    async function open(token) {
      const abort = new AbortController();
      const response = await fetch(`${base}${endpoint}/fleet/events`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/event-stream/);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      const reader = response.body.getReader();
      let buffer = '';
      const stream = { abort, async next() {
        const timer = setTimeout(() => abort.abort(), 3000);
        try {
          while (true) {
            const end = buffer.indexOf('\n\n');
            if (end !== -1) {
              const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              if (/^event: fleet$/m.test(event)) return true;
              continue;
            }
            const part = await reader.read();
            if (part.done) return false;
            buffer += new TextDecoder().decode(part.value);
          }
        } finally { clearTimeout(timer); }
      } };
      streams.push(stream); return stream;
    }
    try {
      const first = await open(member.token);
      const other = await open(viewer.token);
      assert.deepEqual(await Promise.all([first.next(), other.next()]), [true, true]);
      for (const [status, workerId] of [['queued', null], ['running', 'mini-1'], ['running', 'mini-2'], ['queued', null]]) {
        const body = { tasks: [task('live-task', { status, workerId })], source: { name: 'ClickUp', lastSuccessAt: new Date().toISOString() } };
        assert.equal((await request(`${endpoint}/queue`, { method: 'POST', token: admin.token, body })).status, 200);
        assert.deepEqual(await Promise.all([first.next(), other.next()]), [true, true]);
        const snapshots = await Promise.all([member, viewer].map(who => request(`${endpoint}/fleet`, { token: who.token })));
        for (const result of snapshots) {
          assert.equal(result.body.queue.tasks.length, 1);
          assert.equal(result.body.queue.tasks[0].status, status);
          assert.equal(result.body.queue.tasks[0].workerId ?? null, workerId);
        }
      }
      assert.equal((await request(`${endpoint}/queue`, { method: 'POST', token: admin.token, body: { source: { name: 'ClickUp', error: 'Source unavailable' } } })).status, 200);
      assert.deepEqual(await Promise.all([first.next(), other.next()]), [true, true]);
      assert.equal((await request(`${endpoint}/fleet`, { token: member.token })).body.queue.tasks[0].id, 'live-task');
      assert.equal((await request(`${endpoint}/members/${viewer.id}`, { method: 'DELETE' })).status, 200);
      await request(`${endpoint}/queue`, { method: 'POST', token: admin.token, body: { tasks: [], source: { name: 'ClickUp' } } });
      assert.equal(await first.next(), true);
      assert.equal(await other.next(), false);
    } finally { for (const stream of streams) stream.abort.abort(); }
  });
});

test("fleet status transitions, independent account freshness, and persisted errors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-state-"));
  let time = Date.parse("2026-10-07T10:00:00Z");
  const store = createFleetStore(directory, () => time);
  const who = { role: "member", member: { id: "worker-1", name: "Worker Eins" } };
  const date = () => new Date(time).toISOString();
  try {
    store.heartbeat("DEMO1234", who, heartbeat(deviceA, { reportedAt: date(), usageUpdatedAt: date() }));
    time += 15 * 60 * 1000;
    assert.equal(store.snapshot("DEMO1234").machines[0].status, "online");
    time += 1;
    assert.equal(store.snapshot("DEMO1234").machines[0].status, "silent");
    assert.equal(store.snapshot("DEMO1234").events.filter((event) => event.type === "machine_silent").length, 1);
    time += 15 * 60 * 1000;
    assert.equal(store.snapshot("DEMO1234").machines[0].status, "offline");
    const error = store.heartbeat("DEMO1234", who, heartbeat(deviceA, { reportedAt: date(), usageUpdatedAt: date(), limits: [], usageError: "Claude API\nnicht erreichbar" }));
    assert.equal(error.status, "online");
    assert.equal(error.limits[0].percent, 43);
    assert.equal(error.usageStatus, "error");
    assert.equal(error.usageError, "Claude API nicht erreichbar");
    assert.equal(error.usageStale, true);
    assert.ok(store.snapshot("DEMO1234").events.some((event) => event.type === "machine_online"));

    const account = { accountId: "account-a", name: "Worker Claude", provider: "claude", usageUpdatedAt: date() };
    store.heartbeat("DEMO1234", who, heartbeat(deviceA, { reportedAt: date(), usageUpdatedAt: date(), accounts: [account], limits: [{ accountId: "account-a", label: "5h", kind: "session", percent: 0 }] }));
    time += 16 * 60 * 1000;
    const updated = store.heartbeat("DEMO1234", who, heartbeat(deviceA, { reportedAt: date(), usageUpdatedAt: date(), usageError: "Abfrage fehlgeschlagen", accounts: [{ ...account, usageError: "Abfrage fehlgeschlagen" }], limits: [] }));
    assert.equal(updated.limits[0].percent, 0);
    assert.equal(updated.limits[0].usageStatus, "error");
    assert.equal(updated.limits[0].usageStale, true);
    assert.equal(createFleetStore(directory, () => time).snapshot("DEMO1234").machines[0].usageStatus, "error");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("observed Hub workers are shared, deduplicated by native workerId and never invent device telemetry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-hub-"));
  let time = Date.parse("2026-10-07T10:00:00Z");
  const store = createFleetStore(directory, () => time);
  try {
    store.updateQueue("DEMO1234", { tasks: [], source: { name: "ClickUp" }, observedWorkers: [{ workerId: "studio-1", name: "Studio", lastSeenAt: new Date(time).toISOString(), workerVersion: "1.2", pendingClickup: 2 }] });
    let machine = store.snapshot("DEMO1234").machines[0];
    assert.equal(machine.telemetrySource, "worker");
    assert.equal(machine.status, "online");
    assert.equal(machine.usageStatus, "unavailable");
    assert.equal(machine.batteryPercent, undefined);
    store.heartbeat("DEMO1234", { role: "super" }, heartbeat(deviceA, { reportedAt: new Date(time).toISOString(), usageUpdatedAt: new Date(time).toISOString() }));
    assert.equal(store.snapshot("DEMO1234").machines.length, 1);
    time += 16 * 60 * 1000;
    store.updateQueue("DEMO1234", { tasks: [], source: { name: "ClickUp" }, observedWorkers: [{ workerId: "studio-1", name: "Studio", lastSeenAt: new Date(time).toISOString() }] });
    machine = store.snapshot("DEMO1234").machines[0];
    assert.equal(machine.telemetrySource, "app");
    assert.equal(machine.status, "silent");
    assert.equal(machine.workerStatus, "online");
    assert.equal(machine.usageStale, true);
    assert.equal(machine.batteryPercent, 78);
    store.updateQueue("DEMO1234", { source: { name: "ClickUp", error: "Hub unavailable" } });
    assert.equal(store.snapshot("DEMO1234").machines[0].workerStatus, "online");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("task company and Figma links persist and malformed optional metadata is rejected atomically", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-task-links-"));
  try {
    const store = createFleetStore(directory);
    const linked = task("linked", { company: "Beispiel Unternehmen", figmaUrl: "https://www.figma.com/design/board/Test?node-id=1-2" });
    store.updateQueue("DEMO1234", { tasks: [linked, task("legacy")], source: { name: "ClickUp" } });
    const restored = createFleetStore(directory).snapshot("DEMO1234").queue.tasks;
    assert.equal(restored.find(row => row.id === "linked").company, linked.company);
    assert.equal(restored.find(row => row.id === "linked").figmaUrl, linked.figmaUrl);
    assert.equal(restored.find(row => row.id === "legacy").figmaUrl, undefined);
    for (const metadata of [{ company: "x".repeat(201) }, ...[
      "javascript:alert(1)", "http://figma.com/design/key", "https://figma.com.evil.example/design/key",
      "https://user:password@figma.com/file/key", "https://figma.com/login",
    ].map(figmaUrl => ({ figmaUrl }))]) {
      assert.throws(() => store.updateQueue("DEMO1234", { tasks: [task("bad", metadata)], source: { name: "ClickUp" } }), error => error.status === 400);
      assert.deepEqual(store.snapshot("DEMO1234").queue.tasks, restored);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Slack worker IDs name native Macs, Hub workers and historical events consistently", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-worker-names-"));
  let time = Date.parse("2026-10-07T10:00:00Z");
  const store = createFleetStore(directory, () => time);
  const date = () => new Date(time).toISOString();
  try {
    const first = store.heartbeat("DEMO1234", { role: "super" }, heartbeat(deviceA, {
      name: "MacBook Air von Till", workerId: "macbook-till-main", reportedAt: date(), usageUpdatedAt: date(),
    }));
    assert.equal(first.name, "macbook-till-main");
    assert.equal(first.deviceName, "MacBook Air von Till");
    store.heartbeat("DEMO1234", { role: "super" }, heartbeat(deviceB, {
      name: "Mac ohne Worker", workerId: null, reportedAt: date(), usageUpdatedAt: date(),
    }));
    for (const workerId of ["macbook-till-main", "macbook-2", null]) {
      store.updateQueue("DEMO1234", {
        tasks: [task("history", { workerId, title: "Gleicher Aufgabentitel wie in Slack", status: "running" })],
        source: { name: "ClickUp" },
        observedWorkers: [{ workerId: "macbook-2", name: "MacBook Zwei", lastSeenAt: date() }],
      });
    }
    store.heartbeat("DEMO1234", { role: "super" }, heartbeat(deviceA, {
      name: "Später umbenannter Mac", workerId: "macbook-till-main", reportedAt: date(), usageUpdatedAt: date(),
    }));
    let snapshot = store.snapshot("DEMO1234");
    assert.equal(snapshot.machines.find(mac => mac.deviceId === deviceA).name, "macbook-till-main");
    assert.equal(snapshot.machines.find(mac => mac.deviceId === deviceA).deviceName, "Später umbenannter Mac");
    assert.equal(snapshot.machines.find(mac => mac.deviceId === deviceB).name, "Mac ohne Worker");
    assert.equal(snapshot.machines.find(mac => mac.workerId === "macbook-2").name, "macbook-2");
    assert.equal(snapshot.queue.tasks[0].workerId, undefined);
    assert.deepEqual(snapshot.events.filter(event => event.taskId === "history").map(event => event.workerId), [null, "macbook-2", "macbook-till-main"]);
    assert.ok(snapshot.events.filter(event => event.taskId === "history").every(event => event.title === "Gleicher Aufgabentitel wie in Slack"));

    // Existing fleet files contain OS names and some pre-context machine events.
    const file = path.join(directory, "DEMO1234", "fleet.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    const original = persisted.events.find(event => event.deviceId === deviceA);
    original.title = "Alter macOS-Name";
    persisted.events.push({ ...original, id: "legacy", workerId: undefined });
    persisted.events.push({ ...original, id: "captured", workerId: "former-worker", title: "Alter Name" });
    persisted.events.push({ ...original, id: "unassigned", workerId: null, title: "Nicht zugeordnet" });
    fs.writeFileSync(file, JSON.stringify(persisted));
    snapshot = createFleetStore(directory, () => time).snapshot("DEMO1234");
    assert.equal(snapshot.events.find(event => event.id === original.id).title, "macbook-till-main");
    assert.equal(snapshot.events.find(event => event.id === "legacy").title, "macbook-till-main");
    assert.equal(snapshot.events.find(event => event.id === "captured").title, "former-worker");
    assert.equal(snapshot.events.find(event => event.id === "unassigned").title, "Nicht zugeordnet");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).machines.find(mac => mac.deviceId === deviceA).name, "Später umbenannter Mac");

    time += 31 * 60 * 1000;
    snapshot = store.snapshot("DEMO1234");
    assert.equal(snapshot.events.find(event => event.type === "machine_offline" && event.deviceId === deviceA).title, "macbook-till-main");
    assert.equal(snapshot.events.find(event => event.type === "worker_offline").title, "macbook-2");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("bounded event log, complete snapshots and corrupt-file protection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-events-"));
  const store = createFleetStore(directory);
  try {
    store.updateQueue("DEMO1234", { tasks: Array.from({ length: 400 }, (_, index) => task(`id-${index}`)), source: { name: "ClickUp" } });
    assert.equal(store.snapshot("DEMO1234").events.length, 300);
    assert.throws(() => store.updateQueue("DEMO1234", { tasks: [task(), task()], source: { name: "ClickUp" } }), (error) => error instanceof FleetError && error.status === 400);
    assert.throws(() => store.updateQueue("DEMO1234", { tasks: [task("bad", { url: "javascript:alert(1)" })], source: { name: "ClickUp" } }), (error) => error.status === 400);
    assert.equal(store.snapshot("DEMO1234").queue.tasks.length, 400);
    assert.ok(fs.readdirSync(path.join(directory, "DEMO1234")).every((name) => !name.endsWith(".tmp")));
    const file = path.join(directory, "DEMO1234", "fleet.json");
    fs.writeFileSync(file, "broken-json");
    assert.throws(() => store.heartbeat("DEMO1234", { role: "super" }, heartbeat()), (error) => error.status === 500);
    assert.equal(fs.readFileSync(file, "utf8"), "broken-json");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('worker failures survive heartbeat, source outages and restart, and clear only on complete warning scan', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-worker-failures-'));
  let clock = Date.now();
  let store = createFleetStore(directory, () => clock);
  const date = () => new Date(clock).toISOString();
  const who = { member: { id: 'worker' } };
  const source = { name: 'ClickUp' };
  const issue = { id: '1', workerId: 'studio-1', stage: 'claude', severity: 'error', message: 'OAuth session expired', reportedAt: date() };
  try {
    store.heartbeat('DEMO1234', who, heartbeat());
    store.updateQueue('DEMO1234', { source, tasks: [task()], observedWorkers: [{ workerId: 'studio-1', name: 'Studio', lastSeenAt: date() }], workerIssues: [issue] });
    let snap = store.snapshot('DEMO1234');
    assert.equal(snap.machines.length, 1);
    assert.equal(snap.machines[0].status, 'online');
    assert.equal(snap.machines[0].workerStatus, 'online');
    assert.equal(snap.machines[0].workerIssues[0].message, 'OAuth session expired');
    store.heartbeat('DEMO1234', who, heartbeat());
    store.updateQueue('DEMO1234', { source: { ...source, error: 'ClickUp unavailable' } });
    store = createFleetStore(directory, () => clock);
    assert.equal(store.snapshot('DEMO1234').machines[0].workerIssues.length, 1);
    assert.equal(store.snapshot('DEMO1234').queue.tasks.length, 1);
    const changed = { ...issue, message: 'Not logged in' };
    store.updateQueue('DEMO1234', { source: { ...source, error: 'ClickUp unavailable' }, workerIssues: [changed] });
    assert.equal(store.snapshot('DEMO1234').machines[0].workerIssues[0].message, 'Not logged in');
    assert.equal(store.snapshot('DEMO1234').queue.tasks.length, 1);
    assert.throws(() => store.updateQueue('DEMO1234', { source, tasks: [], workerIssues: [{ ...issue, severity: 'bad' }] }), /severity/);
    assert.equal(store.snapshot('DEMO1234').machines[0].workerIssues[0].message, 'Not logged in');
    clock += 31 * 60000;
    store.heartbeat('DEMO1234', who, heartbeat());
    snap = store.snapshot('DEMO1234');
    assert.equal(snap.machines[0].status, 'online');
    assert.equal(snap.machines[0].workerStatus, 'offline');
    store.updateQueue('DEMO1234', { source, tasks: [task()], workerIssues: [] });
    assert.equal(store.snapshot('DEMO1234').machines[0].workerIssues, undefined);
    assert.ok(store.snapshot('DEMO1234').events.some(event => event.type === 'worker_recovered'));
    store.updateQueue('DEMO1234', { source, tasks: [], workerIssues: [{ ...issue, workerId: 'only-warning-worker' }] });
    const unknown = store.snapshot('DEMO1234').machines.find(machine => machine.workerId === 'only-warning-worker');
    assert.equal(unknown.status, 'offline'); // A warning is never a device heartbeat.
    assert.equal(unknown.workerIssues.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
