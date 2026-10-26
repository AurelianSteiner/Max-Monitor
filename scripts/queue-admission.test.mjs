// The queue shows only the orders the worker admits (AI Newsletter Creation
// src/clickup-source.js admit()): manual holds incl. the Prinz upload marker,
// pop-ups in revision or upload status, the test workspace and cutover jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WORKFLOWS, buildQueue, parseClaim, parseRegisterClaim, collectSnapshot, workerAdmission, loadWorkerAdmission } from './newsletter-monitor-bridge.mjs';

const now = Date.parse('2026-10-16T09:00:00Z');
const since = '1792130000000';
const response = data => ({ ok: true, status: 200, json: async () => data });
const task = (id, status, tags = [], extra = {}) => ({ id, name: `Aufgabe ${id}`, tags: tags.map(name => ({ name })),
  status: { status }, date_updated: String(now - 60000), ...extra });
const slackClaim = (event, jobId, overrides = {}, message = {}) => parseClaim({ ts: '1792130100.000100', ...message, metadata: { event_type: event,
  event_payload: { task_id: jobId, run_id: `run-${jobId}`, worker: 'macbook-1', state: 'running', heartbeat: now / 1000 - 30, ...overrides } } });
const config = { clickup: { workspace_id: '24553341' }, slack: { channel_id: 'C0C6NMMGGJV' }, hub: {} };
const PRINZ = { id: '901515044588', name: 'Prinz' };
const TEST_FOLDER = { id: '1200840000002510', name: 'Test' };

// Worker modules in the shape of the worker repository (fakes, no worker checkout needed).
function workerRoot(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'config/manual-uploads.json': JSON.stringify({ customers: [{ customerId: 'prinz', folderId: PRINZ.id }] }),
    'src/upload-policy.js': `const { customers } = require('../config/manual-uploads.json');
const tagName = tag => String(typeof tag === 'string' ? tag : tag?.name ?? '').normalize('NFKC').trim().toLowerCase();
function uploadPolicy(task) {
  const folder = task?.folderId ?? (task?.folder?.hidden ? null : task?.folder?.id);
  const customer = customers.find(entry => String(entry.folderId) === String(folder));
  const tagged = (task?.tags || []).some(tag => tagName(tag) === 'manuell');
  return { manual: Boolean(tagged || customer), tagged, customerId: customer?.customerId ?? null };
}
function manualHold(task, kind) { const policy = uploadPolicy(task); return kind === 'klaviyo' ? policy.manual : policy.tagged && !policy.customerId; }
module.exports = { uploadPolicy, manualHold };`,
    'config/test-workspace.json': JSON.stringify({ folderId: TEST_FOLDER.id, listId: '1200840000003026', enabled: true }),
    'src/test-workspace.js': `const policy = require('../config/test-workspace.json');
const MESSAGE = 'Testauftrag: Kundenboard, Filestage, Klaviyo und Versand sind gesperrt.';
function admission(task, kind) {
  if (String(task?.folder?.id || '') !== policy.folderId && String(task?.list?.id || '') !== policy.listId) return null;
  if (kind !== 'newsletter') return MESSAGE;
  return /^Kunde:/m.test(task.description || '') ? null : 'Testbriefing braucht einen eindeutigen Eintrag Kunde: …';
}
module.exports = { MESSAGE, admission };`,
    'src/slack-kanaele.js': `function aufgabenArt(task) {
  const category = (task?.custom_fields || []).find(field => /work category/i.test(field.name || ''))?.value;
  if (/pop[- ]?ups?/i.test(String(task?.name ?? '')) || /pop[- ]?ups?/i.test(String(task?.list?.name ?? '')) || /^pop[- ]?ups?$/i.test(category || '')) return 'popup';
  return 'newsletter';
}
module.exports = { aufgabenArt };`,
    'config/workflow-cutover.json': JSON.stringify({ schema: 1, jobs: ['86c9ar4dv@1783604799470-klaviyo'] }),
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    if (content === undefined) continue;
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

// Prinz upload marker (docs/ablauf.md, Till 16.10.2026): 'manuell' on a folder
// from config/manual-uploads.json binds only the upload.
test("the worker's own Prinz upload marker does not hide later corrections and Pre-Gen orders", t => {
  const { admission, missing } = loadWorkerAdmission(workerRoot(t));
  assert.deepEqual(missing, []);
  const prinz = (id, status, tags = ['manuell']) => task(id, status, tags, { statusSince: since, folder: PRINZ });
  const rows = buildQueue([prinz('P1', 'revision intern'), prinz('P2', 'revision extern'), prinz('P3', 'pre-gen'),
    prinz('P4', 'pre-gen', ['manuell', 'pre gen · wartet']), prinz('U1', 'klaviyo upload', []), prinz('U2', 'klaviyo upload')],
  [], DEFAULT_WORKFLOWS, { now, admission });
  assert.deepEqual(rows.map(row => [row.id, row.status]), [
    ['clickup:newsletter:P3', 'queued'], ['clickup:newsletter:P4', 'queued'],
    [`correction:korrektur-cu-P1@${since}-intern`, 'queued'], [`correction:korrektur-cu-P2@${since}-extern`, 'queued']]);
  // A 'manuell' set by the PM on any other customer still parks every kind.
  const other = (id, status) => task(id, status, ['manuell'], { statusSince: since, folder: { id: '999', name: 'Kunde' } });
  assert.deepEqual(buildQueue([other('M1', 'revision intern'), other('M2', 'pre-gen'), other('M3', 'klaviyo upload')],
    [], DEFAULT_WORKFLOWS, { now, admission }), []);
  // Without the worker modules (older source installation) the tag alone parks, as before.
  assert.deepEqual(buildQueue([prinz('P1', 'revision intern')], [], DEFAULT_WORKFLOWS, { now }), []);
});

test('pop-ups in revision or upload status, test-workspace tasks and cutover jobs are no waiting orders', t => {
  const { admission } = loadWorkerAdmission(workerRoot(t));
  const dated = (id, status, extra = {}, tags = []) => task(id, status, tags, { statusSince: since, ...extra });
  const rows = buildQueue([
    dated('PU1', 'revision extern', { name: 'Pop-up Herbst' }), dated('PU2', 'klaviyo upload', { name: 'Popup Winter' }),
    dated('PU3', 'revision intern', { list: { id: '1', name: 'Pop-ups' } }),
    dated('PU4', 'klaviyo upload', { custom_fields: [{ name: '⭐ Work Category', value: 'Pop-ups' }] }),
    dated('PU5', 'pre-gen', { name: 'Pop-up Frühling' }),
    dated('TW1', 'klaviyo upload', { folder: TEST_FOLDER }), dated('TW2', 'revision intern', { folder: TEST_FOLDER }),
    dated('TW3', 'pre-gen', { folder: TEST_FOLDER, description: 'Ohne Zuordnung' }),
    dated('TW4', 'pre-gen', { folder: TEST_FOLDER, description: 'Kunde: Beispiel\nTyp: Newsletter' }),
    task('86c9ar4dv', 'klaviyo upload', [], { statusSince: '1783604799470' }),
    task('86cnew', 'klaviyo upload', [], { statusSince: '1783604799470' }),
  ], [], DEFAULT_WORKFLOWS, { now, admission });
  assert.deepEqual(rows.map(row => [row.id, row.status]), [
    ['clickup:newsletter:PU5', 'queued'], ['clickup:newsletter:TW4', 'queued'], ['clickup:upload:86cnew', 'queued']]);
  // The PM re-entered the status: a new epoch is a new order.
  const cutoverAgain = buildQueue([task('86c9ar4dv', 'klaviyo upload', [], { statusSince: since })], [], DEFAULT_WORKFLOWS, { now, admission });
  assert.deepEqual(cutoverAgain.map(row => row.id), ['clickup:upload:86c9ar4dv']);
  // History and reservations stay: a blocked pop-up upload, a running pop-up correction reserved before the rule.
  const history = buildQueue([
    dated('PU2', 'klaviyo upload', { name: 'Popup Winter' }, ['klaviyo upload · blockiert']),
    dated('PU1', 'revision extern', { name: 'Pop-up Herbst' }),
  ], [slackClaim('ai_korrektur_claim', `korrektur-cu-PU1@${since}-extern`)], DEFAULT_WORKFLOWS, { now, admission });
  assert.deepEqual(history.map(row => [row.id, row.status]), [
    ['clickup:upload:PU2', 'blocked'], [`correction:korrektur-cu-PU1@${since}-extern`, 'running']]);
});

test('a source installation without the worker modules keeps the tag-only rule and names what is missing', t => {
  const root = workerRoot(t, { 'src/test-workspace.js': undefined, 'config/workflow-cutover.json': undefined, 'src/slack-kanaele.js': 'module.exports = {};' });
  const { admission, missing } = loadWorkerAdmission(root);
  assert.deepEqual(missing.sort(), ['config/workflow-cutover.json', 'src/slack-kanaele.js', 'src/test-workspace.js']);
  const rows = buildQueue([task('PU1', 'revision extern', [], { name: 'Pop-up Herbst', statusSince: since }),
    task('P1', 'revision intern', ['manuell'], { statusSince: since, folder: PRINZ })], [], DEFAULT_WORKFLOWS, { now, admission });
  assert.deepEqual(rows.map(row => row.id), [`correction:korrektur-cu-P1@${since}-intern`, `correction:korrektur-cu-PU1@${since}-extern`]);
  assert.deepEqual(loadWorkerAdmission(path.join(root, 'missing')).missing.length, 4);
  assert.equal(workerAdmission().parked(task('x', 'pre-gen', ['Manuell']), 'newsletter'), 'manuell');
});

test('the snapshot does not date parked orders, still dates cutover candidates, and counts what it parks', async t => {
  const { admission } = loadWorkerAdmission(workerRoot(t));
  const dated = [];
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.hostname === 'slack.com') return response({ ok: true, messages: [], has_more: false });
    if (url.pathname.endsWith('/space')) return response({ spaces: [] });
    if (url.pathname.endsWith('/task')) return response({ tasks: [task('PU1', 'revision extern', [], { name: 'Pop-up Herbst' }),
      task('M1', 'pre-gen', ['manuell']), task('TW1', 'klaviyo upload', [], { folder: TEST_FOLDER }),
      task('86c9ar4dv', 'klaviyo upload'), task('n', 'pre-gen')], last_page: true });
    if (url.pathname.endsWith('/bulk_time_in_status/task_ids')) {
      dated.push(...url.searchParams.getAll('task_ids'));
      return response({ '86c9ar4dv': { current_status: { status: 'klaviyo upload', since: '1783604799470' } },
        n: { current_status: { status: 'pre-gen', since } } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const snapshot = await collectSnapshot({ now, config, hubFetch, admission, fleetReader: async () => [] });
  assert.equal(snapshot.source.error, undefined);
  assert.deepEqual(dated, ['86c9ar4dv', 'n']);
  assert.deepEqual(snapshot.tasks.map(row => row.id), ['clickup:newsletter:n']);
  assert.match(snapshot.source.detail, /4 geparkt \(1 Testumgebung, 1 manuell, 1 Pop-up, 1 Altbestand\)/);
});

// Fehleraudit 26.10.2026 (Till): the worker's own controller list
// (config/test-workspace.json controllerOnlyTaskIds, exported as registry).
test('the snapshot shows controller test runs from the worker registry and no unattempted backlog blockade', async t => {
  const registry = { folderId: TEST_FOLDER.id, listId: '1200840000003026', enabled: true,
    controllerOnlyTaskIds: ['C1', '', 'bad id', 42] };
  const root = workerRoot(t, { 'config/test-workspace.json': JSON.stringify(registry), 'src/test-workspace.js': `const registry = require('../config/test-workspace.json');
function admission(task, kind) {
  if (String(task?.folder?.id || '') !== registry.folderId) return null;
  return kind === 'newsletter' && /^Kunde:/m.test(task.description || '') ? null : 'Testauftrag';
}
module.exports = { registry, admission };` });
  const { admission, missing } = loadWorkerAdmission(root);
  assert.deepEqual(missing, []);
  assert.deepEqual(['C1', 'C2', 'bad id', '42'].map(admission.controllerTask), [true, false, false, false]);
  // An older worker registry without the list never treats a task as a controller test.
  assert.equal(loadWorkerAdmission(workerRoot(t)).admission.controllerTask('C1'), false);
  assert.equal(workerAdmission().controllerTask('C1'), false);
  const hubFetch = async target => {
    const url = new URL(target);
    if (url.hostname === 'slack.com') return response({ ok: true, messages: [], has_more: false });
    if (url.pathname.endsWith('/space')) return response({ spaces: [] });
    if (url.pathname.endsWith('/task')) return response({ tasks: [
      task('C1', 'pre-gen', ['pre gen · blockiert'], { folder: TEST_FOLDER, description: 'Kunde: Beispiel\nTyp: Newsletter' }),
      task('B1', 'backlog', ['pre gen · blockiert'])], last_page: true });
    if (url.pathname.endsWith('/time_in_status')) return response({ current_status: { status: 'pre-gen', since } });
    if (url.pathname.endsWith('/bulk_time_in_status/task_ids')) return response({ C1: { current_status: { status: 'pre-gen', since } } });
    throw new Error(`unexpected ${url}`);
  };
  const reservationReader = () => [parseRegisterClaim({ runId: '20261016T085000Z-c1', taskId: `C1@${since}`, worker: 'macbook-1',
    state: 'final', channel: 'C0C6NMMGGJV', text: '*Pre-Gen*\n<https://app.clickup.com/t/C1|Test>', ts: '1792130200.000007', heartbeat: now / 1000 - 600 })];
  const snapshot = await collectSnapshot({ now, config, hubFetch, admission, reservationReader, fleetReader: async () => [] });
  assert.equal(snapshot.source.error, undefined);
  assert.deepEqual(snapshot.tasks.map(row => [row.id, row.status, row.phase, row.reasonCode]),
    [['clickup:newsletter:C1', 'blocked', 'Testlauf (Controller)', 'controller_test_run']]);
  // The monitor's own test text is never read back as a worker diagnosis of the same attempt.
  const later = await collectSnapshot({ now: now + 10 * 60000, config, hubFetch, admission, reservationReader, fleetReader: async () => [],
    previousTasks: snapshot.tasks });
  assert.deepEqual(later.tasks.map(row => [row.id, row.status, row.phase, row.reasonCode, row.responsibleRole, row.blockerKind]),
    [['clickup:newsletter:C1', 'blocked', 'Testlauf (Controller)', 'controller_test_run', 'Controller-Test', 'withdrawn']]);
  assert.equal(later.tasks[0].blockedReason, snapshot.tasks[0].blockedReason);
});
