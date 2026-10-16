import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installationSettings, relayEnvironment, relayService, queueService, injectNginxLocation, prepareInstallation, restoreFiles, ensureRuntimeDirectories, waitForEnrollment, safeFailureReason, parseInstallArguments, workerSourceFiles, slackRateLimitDirectory } from './install-monitor-hub.mjs';

const nginx = `server {\n    listen 80;\n    server_name api.ruegamer-steiner.de;\n    return 301 https://$host$request_uri;\n}\nserver {\n    listen 443 ssl;\n    server_name api.ruegamer-steiner.de;\n    ssl_certificate /etc/ssl/current.pem;\n    # A brace in a comment { is not a block.\n    location /v1/ { proxy_pass http://127.0.0.1:8787; }\n    location / { add_header X-Example "quoted { braces }"; proxy_pass http://127.0.0.1:8787; }\n}\nserver {\n    listen 443 ssl;\n    server_name other.example.org;\n    location / { return 200 "unrelated"; }\n}\n`;
const ownerToken = '1'.repeat(48);
const prior = { serverURL: 'https://api.ruegamer-steiner.de/max-monitor', teamId: 'RSMACS01', ownerToken };

test('install settings reuse private credentials and reject implicit rotations or unsafe service paths', () => {
  const settings = installationSettings({}, prior);
  assert.equal(settings.ownerToken, ownerToken);
  assert.equal(settings.port, 8941);
  assert.equal(settings.prefix, '/max-monitor');
  assert.equal(installationSettings().ownerToken.length, 48);
  for (const values of [{ teamId: 'ANOTHER1' }, { serverURL: 'https://other.example.org/max-monitor' }, { port: 80 }, { port: 1.5 }, { nodeBinary: '/usr/bin/node; bad' }, { serverURL: 'https://api.ruegamer-steiner.de/' }]) {
    assert.throws(() => installationSettings(values, prior));
  }
});

test('relay service uses dedicated user, loopback binding and persistent separate storage', () => {
  const settings = installationSettings({}, prior);
  const environment = relayEnvironment(settings);
  const service = relayService(settings);
  assert.match(environment, /TEAM_TOKENS=RSMACS01:1111/);
  assert.match(environment, /HOST=127\.0\.0\.1/);
  assert.match(environment, /DATA_DIR=\/var\/lib\/max-monitor/);
  assert.match(environment, /MAX_MONITOR_REMOTE_CLIENT_POLICY_FILE=\/etc\/max-monitor-remote-policy\/RSMACS01\.json/);
  assert.match(service, /User=max-monitor/);
  assert.match(service, /StateDirectory=max-monitor/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /EnvironmentFile=\/etc\/max-monitor\/relay.env/);
  assert.ok(!service.includes(ownerToken));
  assert.ok(!environment.includes('/opt/rs-hub'));
});

test('queue service reads credentials only on the Hub, uses the existing local transport and writes only its cache', () => {
  const service = queueService(installationSettings({}, prior));
  assert.match(service, /--local-hub \/opt\/rs-hub/);
  assert.match(service, /--enrollment-config \/etc\/max-monitor\/enrollment.json/);
  assert.match(service, /--worker-root \/opt\/max-monitor\/newsletter-source/);
  assert.match(service, /--cleanup-error-copies/);
  assert.match(service, /StateDirectory=max-monitor-queue/);
  assert.match(service, /ReadOnlyPaths=\/opt\/rs-hub \/etc\/max-monitor/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/max-monitor-queue/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/max-monitor-queue \/opt\/rs-hub\/state\/newsletter-continuations/);
  // The shared Slack budget of the Hub transport (worker slack-rate-limit.js).
  assert.match(service, /^ReadWritePaths=\/opt\/rs-hub\/state\/slack-rate-limits$/m);
  // SQLite sidecars of the worker reservation register the queue reads (status-driven queue).
  assert.match(service, /^ReadWritePaths=-\/opt\/rs-hub\/state\/worker-reservations$/m);
  // The worker Hub transport's discovery read cache (lock files) beside it.
  assert.match(service, /^ReadWritePaths=-\/opt\/rs-hub\/state\/discovery-reads$/m);
  assert.ok(!service.includes(ownerToken));
  assert.ok(!service.includes('MONITOR_BRIDGE_TOKEN'));
  assert.ok(!service.includes('--once'));
});

test('relay maintenance cannot propagate a stop to the independently retrying queue bridge', () => {
  const service = queueService(installationSettings({}, prior));
  const unit = service.split('[Unit]\n')[1].split('\n[Service]')[0];
  const dependencies = Object.fromEntries(unit.split('\n').filter(line => line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).split(/\s+/)]; }));
  assert.ok(dependencies.Wants.includes('max-monitor-relay.service'), 'starting the bridge starts its relay');
  assert.ok(dependencies.After.includes('max-monitor-relay.service'), 'initial publication waits for relay startup');
  for (const name of ['Requires', 'BindsTo', 'PartOf', 'Requisite']) {
    assert.ok(!dependencies[name]?.includes('max-monitor-relay.service'), `${name} must not stop the bridge during relay maintenance`);
  }
});

test('nginx injection edits only the matching TLS server and is idempotent', () => {
  const settings = installationSettings({}, prior);
  const output = injectNginxLocation(nginx, settings);
  assert.equal(output.split('# MAX MONITOR BEGIN').length, 2);
  assert.match(output, /location \^~ \/max-monitor\/ \{/);
  assert.match(output, /proxy_pass http:\/\/127\.0\.0\.1:8941\//);
  assert.ok(output.startsWith(nginx.slice(0, nginx.indexOf('server {', 1))));
  assert.ok(output.endsWith(nginx.slice(nginx.lastIndexOf('server {'))));
  for (const original of ['location /v1/ { proxy_pass http://127.0.0.1:8787; }', 'location / { add_header X-Example "quoted { braces }"; proxy_pass http://127.0.0.1:8787; }']) assert.ok(output.includes(original));
  assert.equal(injectNginxLocation(output, settings), output);
});

test('ambiguous TLS servers, occupied paths and broken managed blocks fail before editing', () => {
  const settings = installationSettings({}, prior);
  for (const content of [nginx.replace('listen 443 ssl;', 'listen 8080;').replace('listen 443 ssl;', 'listen 8080;'),
    nginx + 'server { listen 443 ssl; server_name api.ruegamer-steiner.de; }',
    nginx.replace('ssl_certificate', 'location /max-monitor/ { return 200; }\n    ssl_certificate'),
    nginx.replace('ssl_certificate', '# MAX MONITOR BEGIN\n    ssl_certificate')]) assert.throws(() => injectNginxLocation(content, settings));
});

test('generate-only stages private secrets without changing existing nginx or configuration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-hub-plan-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const nginxConfigPath = path.join(directory, 'nginx.conf');
  const existingConfigPath = path.join(directory, 'enrollment.json');
  const stageDirectory = path.join(directory, 'stage');
  const workerRoot = path.join(directory, 'newsletter-source');
  fs.mkdirSync(path.join(workerRoot, 'src'), { recursive: true });
  for (const name of ['config.js', 'hub-transport.js', 'pre-gen.js']) fs.writeFileSync(path.join(workerRoot, 'src', name), `// Source fixture ${name}`);
  fs.mkdirSync(path.join(workerRoot, 'config'));
  fs.writeFileSync(path.join(workerRoot, 'config/worker.local.json'), '{"private":"MAC_SECRET_NEVER_COPY"}');
  fs.writeFileSync(nginxConfigPath, nginx);
  fs.writeFileSync(existingConfigPath, JSON.stringify(prior), { mode: 0o600 });
  const previousUmask = process.umask(0o077);
  let plan;
  try { plan = prepareInstallation({ stageDirectory, nginxConfigPath, workerRoot, existingConfigPath }); }
  finally { process.umask(previousUmask); }
  assert.equal(fs.readFileSync(nginxConfigPath, 'utf8'), nginx);
  assert.equal(fs.readFileSync(existingConfigPath, 'utf8'), JSON.stringify(prior));
  assert.equal(fs.statSync(stageDirectory).mode & 0o777, 0o700);
  const config = path.join(stageDirectory, 'payload/etc/max-monitor/enrollment.json');
  const env = path.join(stageDirectory, 'payload/etc/max-monitor/relay.env');
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(stageDirectory, 'payload/opt/max-monitor/team-server/server.js')).mode & 0o777, 0o644);
  assert.equal(JSON.parse(fs.readFileSync(config)).ownerToken, ownerToken);
  assert.ok(!fs.readFileSync(path.join(stageDirectory, 'plan.json'), 'utf8').includes(ownerToken));
  assert.equal(plan.settings.ownerToken, ownerToken);
  const rerun = prepareInstallation({ stageDirectory, nginxConfigPath, workerRoot, existingConfigPath });
  assert.equal(rerun.settings.ownerToken, ownerToken);
  assert.ok(plan.files.some((file) => file.target === '/opt/max-monitor/team-server/enrollment.js'));
  assert.ok(plan.files.every((file) => !file.target.startsWith('/var/lib/')));
  const sourceConfig = fs.readFileSync(path.join(stageDirectory, 'payload/opt/max-monitor/newsletter-source/config/worker.local.json'), 'utf8');
  assert.ok(!sourceConfig.includes('MAC_SECRET_NEVER_COPY'));
  assert.equal(JSON.parse(sourceConfig).claude.bin, '/usr/bin/false');
  assert.ok(plan.files.some((file) => file.target === '/opt/max-monitor/newsletter-source/src/pre-gen.js'));
});

test('runtime directory preparation defeats root umask only inside the known runtime subtree', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-runtime-permissions-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const runtimeDirectory = path.join(directory, 'opt/max-monitor');
  const secretDirectory = path.join(directory, 'etc/max-monitor');
  fs.mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  const ownership = [];
  const previousUmask = process.umask(0o077);
  try {
    ensureRuntimeDirectories([{ target: path.join(runtimeDirectory, 'team-server/public/dashboard.js') }, { target: path.join(runtimeDirectory, 'scripts/enroll-monitor-worker.mjs') },
      { target: path.join(secretDirectory, 'enrollment.json') }], { runtimeDirectory, changeOwner: (file, uid, gid) => ownership.push({ file, uid, gid }) });
  } finally { process.umask(previousUmask); }
  for (const relative of ['', 'team-server', 'team-server/public', 'scripts']) assert.equal(fs.statSync(path.join(runtimeDirectory, relative)).mode & 0o777, 0o755);
  assert.equal(fs.statSync(secretDirectory).mode & 0o777, 0o700);
  assert.ok(ownership.length > 0);
  assert.ok(ownership.every(({ file, uid, gid }) => file.startsWith(runtimeDirectory) && uid === 0 && gid === 0));
});

test('rollback restores previous file content and mode while keeping persistent data untouched', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-hub-rollback-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const existing = path.join(directory, 'existing');
  const added = path.join(directory, 'new-file');
  const data = path.join(directory, 'fleet.json');
  const backup = path.join(directory, 'backup');
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'original'), 'original');
  fs.writeFileSync(existing, 'updated');
  fs.writeFileSync(added, 'added');
  fs.writeFileSync(data, 'persistent-fleet');
  restoreFiles(backup, { files: [{ target: existing, existed: true, backup: 'original', mode: 0o600 }, { target: added, existed: false }] });
  assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
  assert.equal(fs.statSync(existing).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(added), false);
  assert.equal(fs.readFileSync(data, 'utf8'), 'persistent-fleet');
});

test('CLI requires an explicit mode and never accepts an owner token argument', () => {
  for (const args of [[], ['--install', '--generate-only', '/tmp/stage'], ['--owner-token', ownerToken], ['--nginx-config']]) assert.throws(() => parseInstallArguments(args));
  assert.equal(parseInstallArguments(['--install', '--nginx-config', '/etc/nginx/sites-available/rs-configs']).nginxConfigPath, '/etc/nginx/sites-available/rs-configs');
});

test('public readiness tolerates a previous nginx worker returning 404 before the new API becomes available', async () => {
  let calls = 0;
  const pauses = [];
  await waitForEnrollment(installationSettings({}, prior), { attempts: 3, interval: 500, pause: async (ms) => pauses.push(ms),
    probe: async () => { calls += 1; if (calls < 3) throw new Error('Monitor-Server unterstützt automatische Registrierung noch nicht. (HTTP 404)'); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [500, 500]);
});

test('failed readiness is bounded and diagnoses HTTP status without exposing response or credentials', async () => {
  let calls = 0;
  await assert.rejects(waitForEnrollment(installationSettings({}, prior), { attempts: 2, pause: async () => {},
    probe: async () => { calls += 1; throw new Error(`upstream body ${ownerToken} (HTTP 401)`); },
  }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes(ownerToken));
    assert.ok(!error.message.includes('upstream body'));
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(safeFailureReason(new Error(`unexpected private body ${ownerToken}`)), 'Funktionsprüfung fehlgeschlagen');
});

function workerFixture(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-worker-source-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const workerRoot = path.join(directory, 'newsletter-source');
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workerRoot, relative)), { recursive: true });
    fs.writeFileSync(path.join(workerRoot, relative), content);
  }
  fs.writeFileSync(path.join(directory, 'nginx.conf'), nginx);
  fs.writeFileSync(path.join(directory, 'enrollment.json'), JSON.stringify(prior), { mode: 0o600 });
  return { directory, workerRoot, nginxConfigPath: path.join(directory, 'nginx.conf'), existingConfigPath: path.join(directory, 'enrollment.json') };
}

// Shape of worker main (15.10.): hub-transport.js loads the shared limiters.
const currentWorker = {
  'src/config.js': "const fs = require('fs');\nexports.loadConfig = () => ({});\n",
  'src/pre-gen.js': 'exports.PRE_GEN_FILE = "abc";\n',
  'src/hub-transport.js': "const { ReadCoalescer } = require('./read-coalescer');\nconst { rateLimit } = require('./filestage-rate-limit');\n" +
    "const { slackRateLimit } = require(\"./slack-rate-limit\");\nconst klaviyoLink = require('./klaviyo-link');\nconst { X } = require('./pre-gen');\n",
  'src/read-coalescer.js': 'module.exports = {};\n',
  'src/filestage-rate-limit.js': "function responseError() { const { FreigabenError } = require('./freigaben'); }\nmodule.exports = {};\n",
  'src/slack-rate-limit.js': "const { rateLimit } = require('./filestage-rate-limit');\nconst p = require('node:path');\n",
  'src/klaviyo-link.js': "require('./config.js'); require('./lib/helper'); require('./hub-transport');\n",
  'src/lib/helper/index.js': "require('../../netz');\n",
  'src/netz.js': '',
  'src/freigaben.js': "require('./jobs');\n",
  'src/jobs.js': '',
  'src/unrelated.js': 'never copied',
};

test('the worker source copy is the complete transitive relative require closure of the three entry points', (t) => {
  const fixture = workerFixture(t, currentWorker);
  const relatives = workerSourceFiles(fixture.workerRoot).map(file => file.relative).sort();
  assert.deepEqual(relatives, ['src/config.js', 'src/filestage-rate-limit.js', 'src/freigaben.js', 'src/hub-transport.js', 'src/jobs.js',
    'src/klaviyo-link.js', 'src/lib/helper/index.js', 'src/netz.js', 'src/pre-gen.js', 'src/read-coalescer.js', 'src/slack-rate-limit.js']);
  const hubRoot = path.join(fixture.directory, 'hub');
  const plan = prepareInstallation({ ...fixture, hubRoot });
  const targets = plan.files.map(file => file.target);
  for (const name of ['slack-rate-limit.js', 'filestage-rate-limit.js', 'read-coalescer.js', 'hub-transport.js', 'config.js', 'pre-gen.js'])
    assert.ok(targets.includes(`/opt/max-monitor/newsletter-source/src/${name}`), name);
  assert.ok(!targets.some(target => target.endsWith('/unrelated.js')));
  const copied = plan.files.find(file => file.target === '/opt/max-monitor/newsletter-source/src/slack-rate-limit.js');
  assert.equal(copied.mode, 0o644);
  assert.equal(String(copied.content), currentWorker['src/slack-rate-limit.js']);
  const unit = plan.files.find(file => file.target === '/etc/systemd/system/max-monitor-queue.service');
  assert.ok(String(unit.content).split('\n').includes(`ReadWritePaths=${hubRoot}/state/slack-rate-limits`));
  assert.equal(plan.settings.slackRateLimits, `${hubRoot}/state/slack-rate-limits`);
});

test('the admission rules of the worker are copied when the source has them, with their own requires', (t) => {
  const rules = { ...currentWorker,
    'src/upload-policy.js': "const { customers } = require('../config/manual-uploads.json');\nconst { MANUAL_UPLOAD_TAG } = require('./pre-gen');\n",
    'config/manual-uploads.json': '{"customers":[]}',
    'src/test-workspace.js': "const registry = require('../config/test-workspace.json');\nfunction destination() { require('./jobs'); }\n",
    'config/test-workspace.json': '{}',
    'src/slack-kanaele.js': "const { jobKind } = require('./jobs');\nconst { auswahlText } = require('./clickup-fields');\nmodule.exports = { KANAELE: {}, FEHLER_KANAL: { id: 'C0000000000' } };\n",
    'src/clickup-fields.js': '',
    'config/workflow-cutover.json': '{"schema":1,"jobs":[]}',
  };
  const relatives = workerSourceFiles(workerFixture(t, rules).workerRoot).map(file => file.relative);
  for (const name of ['src/upload-policy.js', 'config/manual-uploads.json', 'src/test-workspace.js', 'config/test-workspace.json',
    'src/slack-kanaele.js', 'src/clickup-fields.js', 'config/workflow-cutover.json']) assert.ok(relatives.includes(name), name);
  // An older worker source without them still installs; the bridge then parks by tag only.
  assert.ok(!workerSourceFiles(workerFixture(t, currentWorker).workerRoot).some(file => /upload-policy|cutover/.test(file.relative)));
  // A present rule file must still bring its complete closure.
  const broken = { ...rules };
  delete broken['config/manual-uploads.json'];
  assert.throws(() => workerSourceFiles(workerFixture(t, broken).workerRoot), /manual-uploads\.json.*fehlt/);
});

test('a missing or escaping worker module fails the install before anything is staged', (t) => {
  for (const [files, pattern] of [
    [{ ...currentWorker, 'src/slack-rate-limit.js': undefined }, /slack-rate-limit\.js.*fehlt/],
    [{ ...currentWorker, 'src/jobs.js': undefined }, /jobs\.js.*fehlt/],
    [{ ...currentWorker, 'src/netz.js': "require('../../outside');\n" }, /außerhalb/],
  ]) {
    const fixture = workerFixture(t, Object.fromEntries(Object.entries(files).filter(([, content]) => content !== undefined)));
    const stageDirectory = path.join(fixture.directory, 'stage');
    assert.throws(() => prepareInstallation({ ...fixture, stageDirectory, hubRoot: path.join(fixture.directory, 'no-hub') }), pattern);
    assert.equal(fs.existsSync(stageDirectory), false);
  }
});

test('the writable Slack budget follows the Hub transport runtime directory', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-monitor-hub-env-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  assert.equal(slackRateLimitDirectory(path.join(directory, 'missing')), path.join(directory, 'missing', 'state', 'slack-rate-limits'));
  fs.writeFileSync(path.join(directory, '.env'), 'SLACK_TOKEN=xoxb-secret-never-used\nHUB_RUNTIME_DIR=\n');
  assert.equal(slackRateLimitDirectory(directory), path.join(directory, 'state', 'slack-rate-limits'));
  fs.writeFileSync(path.join(directory, '.env'), 'HUB_RUNTIME_DIR="/var/lib/rs-hub"\n');
  assert.equal(slackRateLimitDirectory(directory), '/var/lib/rs-hub/state/slack-rate-limits');
  const unit = queueService({ ...installationSettings({}, prior), slackRateLimits: '/var/lib/rs-hub/state/slack-rate-limits' });
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/rs-hub\/state\/slack-rate-limits$/m);
  assert.match(unit, /^ReadWritePaths=-\/var\/lib\/rs-hub\/state\/worker-reservations$/m);
  assert.match(unit, /^ReadWritePaths=-\/var\/lib\/rs-hub\/state\/discovery-reads$/m);
  assert.match(unit, /ReadOnlyPaths=\/opt\/rs-hub \/etc\/max-monitor/);
  for (const value of ['relative/path', '/opt/rs hub', '/opt/../etc']) {
    fs.writeFileSync(path.join(directory, '.env'), `HUB_RUNTIME_DIR=${value}\n`);
    assert.throws(() => slackRateLimitDirectory(directory), /HUB_RUNTIME_DIR/);
  }
});
