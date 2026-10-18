// Matches deployed policy: unanswered PM work waits centrally; its reason stays visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events');
const { createFleetStore } = require('../fleet');
const team = 'DEMO1234';
const now = Date.parse('2026-10-13T20:00:00Z');
const task = (overrides = {}) => ({ id: 'clickup:newsletter:abc', title: 'Mail', workflow: 'newsletter',
  status: 'blocked', phase: 'Blockiert', updatedAt: new Date(now - 10000).toISOString(), ...overrides });
const queue = tasks => ({ tasks, source: { name: 'ClickUp', lastSuccessAt: new Date(now).toISOString() } });
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-clarification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createFleetStore(directory, () => now) };
}

test('PM questions and missing access are clarification; false classification and technical failures stay blocked', t => {
  const { store } = setup(t);
  const cases = [
    { id: 'pm', workflow: 'correction', phase: 'PM-Rückfrage offen' },
    { id: 'access', blockedReason: 'Valentin muss das Figma-Konto als Editor einladen.' },
    { id: 'design', blockedReason: 'Die Black-Week-Gestaltung ist nicht freigegeben.' },
    { id: 'prinz', blockedReason: '„keine Black-Week-Gestaltung“ wird als Black-Week-Auftrag gewertet.' },
    { id: 'technical-pm', workflow: 'correction', phase: 'PM-Rückfrage offen', blockedReason: 'HTTP 429 beim Upload' },
    { id: 'unknown' },
    { id: 'upload', workflow: 'upload', blockedReason: 'PM muss antworten' },
    { id: 'upload-pm', workflow: 'upload', phase: 'PM-Rückfrage offen' },
    { id: 'translation-pm', workflow: 'translation', phase: 'PM-Rückfrage offen' },
  ];
  store.updateQueue(team, queue(cases.map(value => task(value))));
  const rows = store.snapshot(team).queue.tasks;
  assert.deepEqual(rows.map(row => row.status), ['queued', 'queued', 'queued', 'blocked', 'blocked', 'blocked', 'blocked', 'queued', 'queued']);
  assert.equal(rows.length, cases.length);
  assert.ok(rows.every(row => !row.completion));
});

test('journal clarification is superseded only by a fresh technical failure of the same attempt', t => {
  const { store }=setup(t);
  const current=task({id:'clickup:upload:abc',workflow:'upload',status:'clarification',phase:'Klärung nötig',
    url:'https://app.clickup.com/t/abc',attemptId:'current',blockedReason:'Q3: Gutscheincode?'});
  const error={...current,id:'slack-error:CERROR:1791921600.123456',status:'blocked',phase:'Blockiert',
    blockedReason:'HTTP 429 beim Upload',errorUrl:'https://app.slack.com/archives/CERROR/p1791921600123456'};
  for(const older of [{...error,updatedAt:new Date(now-20000).toISOString()},{...error,attemptId:'old'}]){
    store.updateQueue(team,{...queue([current]),blockedErrors:[older]});assert.equal(store.snapshot(team).queue.tasks[0].status,'queued');
  }
  store.updateQueue(team,{...queue([current]),blockedErrors:[{...error,updatedAt:new Date(now).toISOString()}]});
  assert.equal(store.snapshot(team).queue.tasks[0].status,'blocked');
});

test('reviewed clarification survives sync and restart, keeps source tags, and expires on a new attempt', t => {
  const { store, directory } = setup(t);
  const original = task({ attemptId: 'old', tags: ['pre gen · blockiert'] });
  store.updateQueue(team, queue([original]));
  const current = store.snapshot(team).queue.tasks[0];
  const body = { taskId: current.id, taskVersion: current.taskVersion, reason: 'Angebot und Produktlink beim PM offen' };
  let notifications = 0;
  store.subscribe(team, () => notifications++);
  assert.equal(store.clarifyTask(team, { member: { id: 'admin' } }, body).status, 'queued');
  assert.equal(notifications, 1);
  store.updateQueue(team, queue([original]));
  assert.equal(createFleetStore(directory, () => now).snapshot(team).queue.tasks[0].status, 'queued');
  const saved = JSON.parse(fs.readFileSync(path.join(directory, team, 'fleet.json')));
  assert.equal(saved.queue.tasks[0].status, 'blocked');
  assert.deepEqual(saved.queue.tasks[0].tags, ['pre gen · blockiert']);
  assert.equal(saved.queue.clarifications[0].clarifiedBy, 'admin');
  store.updateQueue(team, { source: { name: 'ClickUp', error: 'Unavailable' } });
  assert.equal(store.snapshot(team).queue.tasks[0].status, 'queued');
  store.updateQueue(team, queue([task({ attemptId: 'new' })]));
  assert.equal(store.snapshot(team).queue.tasks[0].status, 'blocked');
  assert.throws(() => store.clarifyTask(team, {}, body), error => error.status === 409);
});

test('new technical diagnosis overrides an earlier clarification of the same source state', t => {
  const { store } = setup(t);
  const original = task({ url: 'https://app.clickup.com/t/abc', attemptId: 'old' });
  store.updateQueue(team, { ...queue([original]), blockedErrors: [] });
  const current = store.snapshot(team).queue.tasks[0];
  store.clarifyTask(team, {}, { taskId: current.id, taskVersion: current.taskVersion, reason: 'Produktlink fehlt' });
  store.updateQueue(team, { ...queue([original]), blockedErrors: [{ ...original, id: 'slack-error:CERROR:1791921600.123456',
    blockedReason: 'TypeError im Slicer', errorUrl: 'https://app.slack.com/archives/CERROR/p1791921600123456' }] });
  assert.equal(store.snapshot(team).queue.tasks[0].status, 'blocked');
  assert.equal(store.snapshot(team).queue.errors.length, 1);
  assert.throws(() => store.clarifyTask(team, {}, { taskId: current.id, taskVersion: current.taskVersion, reason: 'Produktlink fehlt' }), error => error.status === 409);
});

test('a fresh live continuation remains running and completed work never becomes clarification', t => {
  const { store } = setup(t);
  store.updateQueue(team, queue([task({ phase: 'PM-Rückfrage offen', workerId: 'mac-1' }), task({ id: 'done', status: 'completed', phase: 'PM-Rückfrage offen' })]));
  store.workerReport(team, { schema: 1, workerId: 'mac-1', sampledAt: new Date(now).toISOString(),
    service: { running: true, lastPollAt: new Date(now).toISOString() },
    activity: { state: 'busy', acceptingTasks: true, runs: [{ id: task().id, title: 'Mail', workflow: 'newsletter', status: 'running', runId: 'new' }] } });
  assert.deepEqual(store.snapshot(team).queue.tasks.map(row => row.status), ['running', 'completed']);
});

test('removing the Slack diagnostic copy does not reopen a recorded human clarification', t => {
  const { store } = setup(t);
  const original = task({ url: 'https://app.clickup.com/t/abc', attemptId: 'old' });
  const error = { ...original, id: 'slack-error:CERROR:1791921600.123456',
    blockedReason: 'Black-Week-Gestaltung nicht freigegeben',
    errorUrl: 'https://app.slack.com/archives/CERROR/p1791921600123456' };
  store.updateQueue(team, { ...queue([original]), blockedErrors: [error] });
  const current = store.snapshot(team).queue.tasks[0];
  store.clarifyTask(team, {}, { taskId: current.id, taskVersion: current.taskVersion, reason: 'Gestaltungsfreigabe offen' });
  store.updateQueue(team, { ...queue([original]), blockedErrors: [] });
  assert.equal(store.snapshot(team).queue.tasks[0].status, 'queued');
  assert.equal(store.snapshot(team).queue.tasks[0].blockedReason, 'Gestaltungsfreigabe offen');
  assert.equal(store.snapshot(team).queue.errors.length, 0);
});

test('clarification HTTP endpoint is authenticated and restricted to admins', async t => {
  const { directory } = setup(t);
  process.env.DATA_DIR = directory;
  process.env.TEAM_TOKEN = 'clarification-owner';
  delete process.env.TEAM_TOKENS;
  const { server } = require('../server');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (route, method = 'GET', body, token = 'clarification-owner') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/teams/${team}${route}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const viewer = (await request('/members', 'POST', { name: 'Viewer' })).body.member;
  await request('/queue', 'POST', queue([task()]));
  const current = (await request('/fleet')).body.queue.tasks[0];
  const body = { taskId: current.id, taskVersion: current.taskVersion, reason: 'Angebot fehlt' };
  assert.equal((await request('/fleet/tasks/clarification', 'POST', body, null)).status, 401);
  assert.equal((await request('/fleet/tasks/clarification', 'POST', body, viewer.token)).status, 403);
  assert.equal((await request('/fleet/tasks/clarification', 'POST', { ...body, taskVersion: 'stale' })).status, 409);
  assert.equal((await request('/fleet/tasks/clarification', 'POST', body)).body.task.status, 'queued');
  assert.equal((await request('/fleet')).body.queue.tasks[0].status, 'queued');
});


test('a typed saved blocker never becomes an invented PM question; explicit decisions still work',t=>{
 const {store,directory}=setup(t);const original=task({attemptId:'saved',blockerSource:'checkpoint',reasonCode:'customer_setup_incomplete',
  blockedReason:'Design-Library ist nicht freigegeben. PM und Design schließen das Onboarding ab.'});
 store.updateQueue(team,queue([original]));const current=store.snapshot(team).queue.tasks[0];assert.equal(current.status,'blocked');
 store.clarifyTask(team,{}, {taskId:current.id,taskVersion:current.taskVersion,reason:'PM klärt die Freigabe'});
 assert.equal(createFleetStore(directory,()=>now).snapshot(team).queue.tasks[0].status,'queued');
});


test('current PM display changes preserve a reviewed saved blocker; a new original outcome expires it', t=>{
 const {store,directory}=setup(t);const original=task({attemptId:'saved',blockerSource:'checkpoint',reasonCode:'product_feed_missing',
  blockerSourceRunId:'saved',blockerSourceHash:'a'.repeat(64),blockerReason:'Produktfeed fehlt.',pmOwner:'Ben',blockedReason:'Produktfeed fehlt · PM: Ben'});
 store.updateQueue(team,queue([original]));const current=store.snapshot(team).queue.tasks[0];
 store.clarifyTask(team,{}, {taskId:current.id,taskVersion:current.taskVersion,reason:'PM klärt die fachlichen Vorgaben'});
 store.updateQueue(team,queue([{...original,pmOwner:'Hannes',blockedReason:'Produktfeed fehlt · PM: Hannes'}]));
 const reread=createFleetStore(directory,()=>now).snapshot(team).queue.tasks[0];assert.equal(reread.status,'queued');assert.equal(reread.pmOwner,'Hannes');
 store.updateQueue(team,queue([{...original,blockerSourceHash:'b'.repeat(64)}]));assert.equal(store.snapshot(team).queue.tasks[0].status,'blocked');
});
