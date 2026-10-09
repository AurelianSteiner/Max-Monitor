const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { createFleetStore } = require("../fleet");

const team = "DEMO1234";
const jpeg = (label) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label), Buffer.from([0xff, 0xd9])]);
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const preview = (buffer, overrides = {}) => ({ id: sha(buffer), title: "Newsletter – Mail 01", subject: "Betreff", renderedAt: "2026-10-09T14:41:24.117Z", render: 2, width: 600, height: 4800, ...overrides });
const task = (overrides = {}) => ({ id: "clickup:newsletter:abc", title: "Newsletter", workflow: "newsletter", status: "running", phase: "In Bearbeitung", workerId: "mac-1", ...overrides });
const queue = (tasks) => ({ tasks, source: { name: "ClickUp" } });

test("a live step and progress update without log events or a new task version", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-step-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createFleetStore(directory);
  store.updateQueue(team, queue([task()]));
  const before = store.snapshot(team);
  store.updateQueue(team, queue([task({ progress: 50, step: "Bau der Mail: erster Render" })]));
  const after = store.snapshot(team);
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.queue.tasks[0].taskVersion, before.queue.tasks[0].taskVersion);
  assert.deepEqual([after.queue.tasks[0].progress, after.queue.tasks[0].step], [50, "Bau der Mail: erster Render"]);
  assert.throws(() => store.updateQueue(team, queue([task({ step: "x".repeat(161) })])), (error) => error.status === 400);
});

test("previews are content addressed, only published once stored, and pruned when no task uses them", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-preview-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-09T15:00:00Z");
  const store = createFleetStore(directory, () => clock);
  const first = jpeg("first");
  const second = jpeg("second");

  assert.throws(() => store.savePreview(team, sha(first), jpeg("other")), (error) => error.status === 400);
  assert.throws(() => store.savePreview(team, sha(Buffer.from("png")), Buffer.from("png")), (error) => error.status === 415);
  assert.throws(() => store.savePreview(team, "../fleet", first), (error) => error.status === 400);
  assert.deepEqual(store.savePreview(team, sha(first), first), { id: sha(first), bytes: first.length });
  assert.deepEqual(store.savePreview(team, sha(first), first), { id: sha(first), bytes: first.length });
  assert.equal(fs.readFileSync(store.previewFile(team, sha(first))).equals(first), true);

  // A reference to an image that never arrived is dropped instead of showing a broken picture.
  store.updateQueue(team, queue([task({ previews: [preview(first), preview(second, { title: "Mail 02" })] })]));
  assert.deepEqual(store.snapshot(team).queue.tasks[0].previews.map((entry) => entry.id), [sha(first)]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, team, "fleet.json"), "utf8")).queue.tasks[0].previews.length, 1);

  // An upload waits for the snapshot that references it; old orphans disappear.
  store.savePreview(team, sha(second), second);
  store.updateQueue(team, queue([task()]));
  assert.ok(store.previewFile(team, sha(first)));
  assert.equal(store.snapshot(team).queue.tasks[0].previews, undefined);
  clock += 2 * 60 * 60 * 1000;
  store.updateQueue(team, queue([task({ previews: [preview(second)] })]));
  assert.equal(store.previewFile(team, sha(first)), null);
  assert.ok(store.previewFile(team, sha(second)));

  // A source error keeps the last complete queue including its pictures.
  store.updateQueue(team, { source: { name: "ClickUp", error: "Unavailable" } });
  assert.equal(store.snapshot(team).queue.tasks[0].previews[0].id, sha(second));

  for (const previews of [[{ ...preview(first), id: "x" }], [{ ...preview(first), width: 0 }], [{ ...preview(first), renderedAt: "gestern" }], Array(25).fill(preview(first))]) {
    assert.throws(() => store.updateQueue(team, queue([task({ previews })])), (error) => error.status === 400);
  }
});

test("HTTP previews: the queue bridge uploads, every viewer reads, nobody else", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-monitor-preview-http-"));
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = "preview-owner";
  delete process.env.TEAM_TOKENS;
  delete require.cache[require.resolve("../server")];
  const { server } = require("../server");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const json = async (route, method = "GET", body, token = "preview-owner") => {
    const res = await fetch(`${base}/v1/teams/${team}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const image = jpeg("render");
  const id = sha(image);
  const put = (token, body = image, type = "image/jpeg") => fetch(`${base}/v1/teams/${team}/fleet/previews/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body });
  const get = (token, previewId = id) => fetch(`${base}/v1/teams/${team}/fleet/previews/${previewId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  const member = (await json("/members", "POST", { name: "Mac" })).body.member;
  const guest = (await json("/members", "POST", { name: "Gast", role: "guest" })).body.member;
  assert.equal((await put(member.token)).status, 403);
  assert.equal((await put(guest.token)).status, 403);
  assert.equal((await put("preview-owner", image, "image/png")).status, 415);
  assert.equal((await put("preview-owner", Buffer.alloc(3 * 1024 * 1024, 1))).status, 413);
  const stored = await put("preview-owner");
  assert.equal(stored.status, 200);
  assert.deepEqual(await stored.json(), { ok: true, id, bytes: image.length });

  assert.equal((await json("/queue", "POST", queue([task({ progress: 50, step: "Bau der Mail", previews: [preview(image)] })]))).status, 200);
  const published = (await json("/fleet", "GET", undefined, guest.token)).body.queue.tasks[0];
  assert.deepEqual([published.step, published.progress, published.previews[0].id], ["Bau der Mail", 50, id]);

  for (const token of [member.token, guest.token, "preview-owner"]) {
    const res = await get(token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("cache-control"), /^private, max-age=\d+, immutable$/);
    assert.equal(Buffer.from(await res.arrayBuffer()).equals(image), true);
  }
  assert.equal((await get(null)).status, 401);
  assert.equal((await get("wrong")).status, 401);
  assert.equal((await get(member.token, "0".repeat(64))).status, 404);
  assert.equal((await get(member.token, "not-a-hash")).status, 404);

  // The dashboard turns the authenticated download into a local blob image.
  const shell = await fetch(`${base}/fleet`);
  assert.match(shell.headers.get("content-security-policy"), /img-src 'self' data: blob:;/);
});
