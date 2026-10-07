import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installationSettings, relayEnvironment, relayService, queueService, injectNginxLocation, prepareInstallation, restoreFiles, ensureRuntimeDirectories, waitForEnrollment, safeFailureReason, parseInstallArguments } from './install-monitor-hub.mjs';

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
  assert.match(service, /StateDirectory=max-monitor-queue/);
  assert.match(service, /ReadOnlyPaths=\/opt\/rs-hub \/etc\/max-monitor/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/max-monitor-queue/);
  assert.ok(!service.includes(ownerToken));
  assert.ok(!service.includes('MONITOR_BRIDGE_TOKEN'));
  assert.ok(!service.includes('--once'));
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
