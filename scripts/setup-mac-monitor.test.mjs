import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, optionsFrom, validateEnrollment, appStatus, run, nativeCodeUnchanged, nativeSourceKey, readWorker, workerArtifactBundle, workerArtifactManifest, main, buildCause, storedMonitorPreferences } from './setup-mac-monitor.mjs';
import { createHash } from 'node:crypto';

const DEVICE_ID = '610be10e-8a00-4e00-b000-000000000051';
const MEMBER_TOKEN = 'test_member_token_'.repeat(3);
const REVISION = 'c'.repeat(40);
const BUNDLE_ID = 'xyz.fi5h.Usage4Claude';

async function appBundle(directory, name) {
  await fs.mkdir(path.join(directory, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(directory, 'Contents', 'marker'), name);
  await fs.writeFile(path.join(directory, 'Contents', 'MacOS', 'Usage4Claude'), 'fake executable, never launched');
}

function fDefault(value) {
  if (value == null) throw Object.assign(new Error('missing preference'), {preferenceMissing:true});
  return value + '\n';
}

async function fixture(t, { previous = false, configured = false } = {}) {
  // NSRunningApplication reports macOS canonical paths (/private/tmp, etc.).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'max monitor setup ')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'build', 'Max Monitor.app');
  const destination = path.join(directory, 'Applications', 'Max Monitor.app');
  const receiptPath = path.join(directory, 'private', 'installation.json');
  const workerRoot = path.join(directory, 'AI Newsletter Creation');
  const identityFile = path.join(directory, 'ssh', 'worker_key');
  const knownHostsFile = path.join(workerRoot, 'config', 'hub_known_hosts');
  await appBundle(source, 'new app');
  if (previous) await appBundle(destination, 'previous app');
  await fs.mkdir(path.dirname(identityFile), { recursive: true });
  await fs.mkdir(path.dirname(knownHostsFile), { recursive: true });
  await fs.writeFile(identityFile, 'fake test key');
  await fs.writeFile(knownHostsFile, 'fake pinned test host');
  const worker = { workerId: 'mac-5', hubHost: 'root@hub.example.test', identityFile, knownHostsFile };
  const enrollment = { schema: 1, serverURL: 'https://monitor.example.test/max-monitor', teamId: 'RSMACS01',
    token: MEMBER_TOKEN, memberId: 'worker-mac-5', workerId: worker.workerId, deviceId: DEVICE_ID };
  const state = { revision: REVISION, preflight: { schema: 1, ok: true }, enrollment,
    status: { schema: 1, bundleId: 'xyz.fi5h.Usage4Claude', deviceId: DEVICE_ID, configured,
      ...(configured ? { serverURL: enrollment.serverURL, teamId: enrollment.teamId, workerId: worker.workerId,
        memberId: enrollment.memberId, role: 'member', verified: true, fleetAvailable: true, launchAtLoginStatus: 'enabled' } : {}) },
    nativeFailure: false, signatureFailure: false, appFailure: false, fleetFailure: false,
    runningApps: [], nextPid: 9000, terminationRefused: false, openAbsent: false, openWrongPath: false };
  const calls = [], logs = [];
  const appReader = async appPath => {
    try { await fs.access(path.join(appPath, 'Contents', 'marker')); }
    catch { return null; }
    if (state.appFailure && appPath === destination) return null;
    return { executable: path.join(appPath, 'Contents', 'MacOS', 'Usage4Claude'), version:'2.14.1' };
  };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], input: options.input, inherit: options.inherit, timeout: options.timeout });
    if (command === 'git') return `${state.revision}\n`;
    if (command === 'ssh') {
      if (args.at(-1).endsWith('--check')) return JSON.stringify(state.preflight);
      return JSON.stringify(state.enrollment);
    }
    if (command === '/usr/bin/defaults') {
      const field = {fleetDeviceId:'deviceId',fleetWorkerId:'workerId',teamServerURL:'serverURL',teamServerTeamId:'teamId',teamServerMemberId:'memberId',teamServerRole:'role'}[args.at(-1)];
      return fDefault(state.status[field]);
    }
    if (command === '/bin/ps') return '';
    if (command === '/usr/bin/python3' && args[1]?.startsWith('# monitor-keychain-state:'))
      return JSON.stringify(state.keychainStatus || {available:true,unlocked:true});
    if (command === '/usr/bin/osascript') {
      assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
      const mode = args.at(-2), bundleId = args.at(-1);
      assert.equal(bundleId, BUNDLE_ID);
      if (mode === 'terminate' || mode === 'forceTerminate') {
        if (mode === 'forceTerminate' || !state.terminationRefused) state.runningApps = state.runningApps.filter(app => app.bundleId !== bundleId);
      } else assert.equal(mode, 'inventory');
      return JSON.stringify(state.runningApps);
    }
    if (command === '/usr/bin/ditto') { await fs.cp(args[0], args[1], { recursive: true }); return ''; }
    if (command === '/usr/bin/codesign') {
      if (state.signatureFailure) throw new Error('App-Signatur prüfen fehlgeschlagen.');
      if (args.includes('-r-')) return '# designated => identifier "xyz.fi5h.Usage4Claude" and cdhash H"aabb"\n';
      return '';
    }
    if (command === '/usr/bin/open') {
      if (state.openAbsent) return '';
      const bundlePath = state.openWrongPath ? path.join(directory, 'Wrong Monitor.app') : args.at(-1);
      state.runningApps.push({ pid: state.nextPid++, bundleId: BUNDLE_ID, bundlePath,
        executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Usage4Claude') });
      return '';
    }
    if (command.endsWith('/Contents/MacOS/Usage4Claude')) {
      if (args[0] === '--enrollment-status') {
        const value = { ...state.status };
        if (state.fleetFailure && args.includes('--verify')) value.fleetAvailable = false;
        return JSON.stringify(value);
      }
      if (args[0] === '--enroll') {
        if (state.nativeFailure) throw new Error('Monitor-Verbindung speichern fehlgeschlagen.');
        const input = JSON.parse(options.input);
        state.status = { ...state.status, configured: true, serverURL: input.serverURL, teamId: input.teamId,
          workerId: input.workerId, memberId: input.memberId, verified: true, fleetAvailable: true,
          role: 'member', launchAtLoginStatus: state.loginStatus || (input.launchAtLogin ? 'enabled' : 'notRegistered') };
        if (state.loginTimeout) {
          throw Object.assign(new Error('Autostart Zeitüberschreitung'), { timedOut:true, stage:'login' });
        }
        return JSON.stringify({ schema: 1, launchAtLoginStatus: state.status.launchAtLoginStatus });
      }
    }
    assert.fail(`Unexpected runner command: ${command} ${args.join(' ')}`);
  };
  const options = optionsFrom(['--worker-root', workerRoot, '--app-path', destination, '--app-bundle', source]);
  const dependencies = { runner, appReader, workerReader: async () => worker,
    artifactReader: async () => source,
    manifestReader: async () => ({schema:1,version:'2.14.1',sourceRevision:REVISION}),
    platform: 'darwin', receiptPath, pause: async () => {}, log: value => logs.push(value) };
  return { directory, source, destination, receiptPath, options, dependencies, state, calls, logs, worker,
    async marker() { return fs.readFile(path.join(destination, 'Contents', 'marker'), 'utf8'); },
    async writeReceipt(sourceRevision = REVISION) {
      await fs.mkdir(path.dirname(receiptPath), { recursive: true });
      await fs.writeFile(receiptPath, JSON.stringify({ schema: 1, sourceRevision, workerId: worker.workerId }), { mode: 0o600 });
    },
    runningApp(bundlePath = destination, bundleId = BUNDLE_ID) {
      const app = { pid: state.nextPid++, bundleId, bundlePath,
        executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Usage4Claude') };
      state.runningApps.push(app);
      return app;
    },
  };
}

test('background monitor reads the exact registered worker profile instead of assuming worker.local.json', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-profile-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const root = path.join(directory,'worker'), profile = path.join(directory,'profiles','machine.json');
  await fs.mkdir(path.join(root,'src'),{recursive:true}); await fs.mkdir(path.dirname(profile),{recursive:true});
  await fs.writeFile(path.join(root,'src/config.js'),"exports.loadConfig=file=>JSON.parse(require('fs').readFileSync(file,'utf8'));");
  const database = path.join(directory, 'separate state', 'worker.sqlite');
  await fs.writeFile(profile,JSON.stringify({worker_id:'mac-real',paths:{state_db:database},hub:{ssh_host:'root@hub.example.test',identity_file:'~/.ssh/worker',known_hosts_file:'/safe/known_hosts'}}));
  const previous = process.env.MAX_MONITOR_WORKER_CONFIG;
  try {
    process.env.MAX_MONITOR_WORKER_CONFIG=profile;
    const result=await readWorker({workerRoot:root,updateOnly:true});
    assert.equal(result.workerId,'mac-real'); assert.equal(result.hubHost,'root@hub.example.test');
    assert.equal(result.monitorDeviceIdFile,path.join(path.dirname(database),'monitor-device-id'));
  } finally {
    if(previous === undefined) delete process.env.MAX_MONITOR_WORKER_CONFIG; else process.env.MAX_MONITOR_WORKER_CONFIG=previous;
  }
});

test('background upgrades and minute checks preserve preferences without any Keychain CLI', async t => {
  const f = await fixture(t, {previous:true, configured:true});
  f.state.status.role = 'super'; f.state.status.memberId = 'team-owner';
  const read = f.dependencies.appReader;
  f.dependencies.appReader = async (appPath, ...args) => {
    const app = await read(appPath, ...args);
    return app && appPath === f.options.appPath && await f.marker() === 'previous app' ? {...app,legacy:true} : app;
  };
  const initial = {...f.state.status};
  const result = await setup({...f.options,updateOnly:true}, f.dependencies);
  assert.equal(result.role, 'super'); assert.deepEqual(f.state.status,initial);
  const copy = f.calls.findIndex(c => c.command === '/usr/bin/ditto');
  const status = f.calls.findIndex(c => c.args[0] === '--enrollment-status');
  const preferences = f.calls.findIndex(c => c.command === '/usr/bin/defaults');
  assert.ok(preferences >= 0 && preferences < copy);
  assert.equal(status,-1);
  assert.equal(result.verified,undefined);
  const copies = f.calls.filter(c => c.command === '/usr/bin/ditto').length;
  const repeated = await setup({...f.options,appBundle:null,updateOnly:true},f.dependencies);
  assert.equal(repeated.mode,'existing');
  assert.equal(f.calls.filter(c => c.command === '/usr/bin/ditto').length,copies);
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll' || c.args[0] === '--enrollment-status'));
});

test('background code upgrades preserve a separate native worker binding without enrollment', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const read = f.dependencies.appReader;
  f.dependencies.appReader = async (appPath,...args) => {
    const app = await read(appPath,...args); return app && appPath === f.options.appPath ? {...app,legacy:true} : app;
  };
  f.state.status.workerId = 'another-mac';
  const initial = {...f.state.status};
  const other = await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(other.workerId,'another-mac');
  assert.deepEqual(f.state.status,initial);
  assert.equal(await f.marker(),'new app');
  f.state.status.workerId = null;
  const result = await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(result.verified,undefined);
  assert.equal(f.state.status.workerId,null);
  assert.equal(await f.marker(),'new app');
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll'));
});

test('a newer packaged version replaces an older app even when its recorded source is current', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  await f.writeReceipt();
  const read = f.dependencies.appReader;
  f.dependencies.appReader = async (appPath,...args) => {
    const app = await read(appPath,...args);
    return app && appPath === f.options.appPath && await f.marker() === 'previous app'
      ? {...app,version:'2.14'} : app;
  };
  const runner = f.dependencies.runner;
  f.dependencies.runner = (command,args,options) => command === 'git' && args.includes('diff')
    ? Promise.resolve('') : runner(command,args,options);
  const initial = {...f.state.status};
  const result = await setup({...f.options,appBundle:null,updateOnly:true},f.dependencies);
  assert.equal(result.mode,'installed');
  assert.equal(await f.marker(),'new app');
  assert.deepEqual(f.state.status,initial);
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll'));
});

test('worker artifact download verifies content, preserves tampered caches, and never reuses a different native body', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-artifact-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const content = Buffer.from('authenticated-release-zip');
  const manifest = {schema:1,version:'2.14.1',sourceRevision:'a'.repeat(40),sha256:createHash('sha256').update(content).digest('hex'),
    tag:'worker-native-'+'a'.repeat(12),asset:'Max-Monitor-worker.zip'};
  const manifestPath = path.join(dir,'manifest.json'), cacheRoot = path.join(dir,'cache');
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  const calls = [];
  let nativeChanged = false, corruptDownload = true;
  const runner = async (command,args) => {
    calls.push([command,args]);
    if (command === 'git') return args.includes('diff') && nativeChanged ? 'Usage4Claude/Helpers/FleetReporter.swift' : '';
    if (command === 'gh') {
      await fs.writeFile(path.join(args[args.indexOf('--dir')+1],manifest.asset),corruptDownload ? 'tampered' : content);
      return '';
    }
    if (command === '/usr/bin/ditto') {
      await appBundle(path.join(args.at(-1),'Max Monitor.app'),'artifact'); return '';
    }
    if (command === '/usr/bin/codesign' || command === '/usr/bin/security') return '';
    assert.fail(command);
  };
  await assert.rejects(workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot}),/Prüfsumme/);
  assert.ok(!calls.some(([cmd])=>cmd === '/usr/bin/ditto'));
  corruptDownload = false;
  const bundle = await workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot});
  assert.equal(await fs.readFile(path.join(bundle,'Contents','marker'),'utf8'),'artifact');
  const count = calls.filter(([cmd])=>cmd === 'gh').length;
  assert.equal(await workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot}),bundle);
  assert.equal(calls.filter(([cmd])=>cmd === 'gh').length,count);
  await fs.writeFile(path.join(path.dirname(bundle),manifest.asset),'tampered-cache');
  await assert.rejects(workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot}),/Prüfsumme/);
  nativeChanged = true;
  assert.equal(await workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot}),null);
  assert.equal(calls.filter(([cmd])=>cmd === 'gh').length,count);
});

test('artifact re-signing uses only the installed certificate and preserves ad-hoc installations', async t => {
  for (const kind of ['certificate','adhoc','missing-private-key']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-existing-signer-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const content=Buffer.from('pinned archive'), leaf='A'.repeat(40);
    const manifest={schema:1,version:'2.15.2',sourceRevision:'a'.repeat(40),sha256:createHash('sha256').update(content).digest('hex'),
      tag:'worker-native-'+'a'.repeat(12),asset:'Max-Monitor-worker.zip'};
    const manifestPath=path.join(dir,'manifest.json'),installedAppPath=path.join(dir,'Installed.app');
    await appBundle(installedAppPath,'original app');
    await fs.writeFile(manifestPath,JSON.stringify(manifest));
    const calls=[];let signed=false;
    const requirement=kind==='adhoc' ? 'identifier "xyz.fi5h.Usage4Claude" and cdhash H"abcd"'
      : `identifier "xyz.fi5h.Usage4Claude" and certificate leaf = H"${leaf}"`;
    const runner=async(command,args)=>{
      calls.push({command,args});
      if(command==='git')return '';
      if(command==='gh'){await fs.writeFile(path.join(args[args.indexOf('--dir')+1],manifest.asset),content);return '';}
      if(command==='/usr/bin/ditto'){await appBundle(path.join(args.at(-1),'Max Monitor.app'),'candidate');return '';}
      if(command==='/usr/bin/security')assert.fail('valid-only or label lookup must not select a different identity');
      if(command==='/usr/bin/codesign'){
        if(args.includes('-r-'))return `designated => ${args.at(-1)===installedAppPath || signed ? requirement : 'identifier "xyz.fi5h.Usage4Claude"'}\n`;
        if(args.includes('--sign')){
          assert.equal(args[args.indexOf('--sign')+1],leaf);
          assert.notEqual(args.at(-1),installedAppPath);
          if(kind==='missing-private-key')throw new Error('identity unavailable');
          signed=true;
        }
        if(args.includes('-R')){assert.equal(signed,true);assert.equal(args[args.indexOf('-R')+1],'='+requirement);}
        return '';
      }
      assert.fail(command);
    };
    const action=workerArtifactBundle(REVISION,runner,{manifestPath,cacheRoot:path.join(dir,'cache'),installedAppPath});
    if(kind==='missing-private-key')await assert.rejects(action,{code:'MONITOR_SIGNING_IDENTITY_UNAVAILABLE'});
    else assert.ok(await action);
    assert.equal(signed,kind==='certificate');
    assert.equal(await fs.readFile(path.join(installedAppPath,'Contents','marker'),'utf8'),'original app');
    assert.ok(!calls.some(c=>c.command==='/usr/bin/osascript'||c.command==='/usr/bin/open'));
  }
});

test('automatic artifact preparation receives the actual installed bundle path', async t => {
  const f=await fixture(t,{previous:true,configured:true});
  let selected;
  f.dependencies.artifactReader=async(revision,runner,options)=>{selected=options.installedAppPath;return f.source;};
  const result=await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
  assert.equal(result.mode,'installed');
  assert.equal(selected,f.options.appPath);
});

test('an already matching signed artifact needs no local private key but a foreign signer is still rejected', async t => {
  for (const matching of [true,false]) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-presigned-artifact-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const content=Buffer.from('pinned centrally signed archive'),leaf='A'.repeat(40);
    const installedAppPath=path.join(dir,'Installed.app'),manifestPath=path.join(dir,'manifest.json');
    const requirement=`identifier "xyz.fi5h.Usage4Claude" and certificate leaf = H"${leaf}"`;
    await appBundle(installedAppPath,'original app');
    await fs.writeFile(manifestPath,JSON.stringify({schema:1,version:'2.15.3',sourceRevision:'a'.repeat(40),
      sha256:createHash('sha256').update(content).digest('hex'),tag:'worker-native-'+'a'.repeat(12),asset:'Max-Monitor-worker.zip'}));
    let signingAttempts=0,verifiedRequirement=false;
    const runner=async(command,args)=>{
      if(command==='git')return '';
      if(command==='gh'){await fs.writeFile(path.join(args[args.indexOf('--dir')+1],'Max-Monitor-worker.zip'),content);return '';}
      if(command==='/usr/bin/ditto'){await appBundle(path.join(args.at(-1),'Max Monitor.app'),'published artifact');return '';}
      if(command==='/usr/bin/security')assert.fail('a matching artifact requires no identity enumeration');
      if(command==='/usr/bin/codesign'){
        if(args.includes('-r-'))return `designated => ${args.at(-1)===installedAppPath||matching?requirement:'identifier "xyz.fi5h.Usage4Claude" and certificate leaf = H"'+'B'.repeat(40)+'"'}\n`;
        if(args.includes('-R')){
          assert.equal(args[args.indexOf('-R')+1],'='+requirement);
          if(!matching)throw new Error('foreign signer');
          verifiedRequirement=true;
        }
        if(args.includes('--sign')){
          signingAttempts++;
          assert.equal(args[args.indexOf('--sign')+1],leaf);
          assert.notEqual(args.at(-1),installedAppPath);
          throw new Error('private key not available on this Mac');
        }
        return '';
      }
      assert.fail(command);
    };
    const action=workerArtifactBundle(REVISION,runner,{manifestPath,installedAppPath,cacheRoot:path.join(dir,'cache')});
    if(matching){assert.ok(await action);assert.equal(verifiedRequirement,true);assert.equal(signingAttempts,0);}
    else {await assert.rejects(action,{code:'MONITOR_SIGNING_IDENTITY_UNAVAILABLE'});assert.equal(signingAttempts,1);}
    assert.equal(await fs.readFile(path.join(installedAppPath,'Contents','marker'),'utf8'),'original app');
  }
});

test('helper, relay, Node tests and documentation changes can reuse a verified native app', async () => {
  const before = 'a'.repeat(40), after = 'b'.repeat(40);
  const diff = files => async () => files.join('\n');
  assert.equal(await nativeCodeUnchanged(before,after,diff(['scripts/setup-mac-monitor.mjs','team-server/fleet.js'])),true);
  assert.equal(await nativeCodeUnchanged(before,after,diff(['scripts/install-worker-observer.mjs',
    'scripts/install-worker-observer.test.mjs','scripts/install-monitor-hub.mjs'])),true);
  assert.equal(await nativeCodeUnchanged(before,after,diff(['scripts/blocked-error-inventory.test.mjs',
    'scripts/newsletter-monitor-sales.test.mjs','scripts/new-regression.spec.cjs'])),true);
  // Only build inputs count as native; any other helper script reuses the app.
  assert.equal(await nativeCodeUnchanged(before,after,diff(['scripts/new-runtime.mjs'])),true);
  for (const file of ['Usage4Claude/Helpers/FleetReporter.swift','Config/Info.plist','Config/Usage4Claude.entitlements',
    'Usage4Claude.xcodeproj/project.pbxproj','scripts/build_without_xcode.sh','Package.swift','Package.resolved'])
    assert.equal(await nativeCodeUnchanged(before,after,diff(['scripts/new-runtime.mjs',file])),false,file);
  assert.equal(await nativeCodeUnchanged(undefined,after,diff([])),false);
  assert.equal(await nativeCodeUnchanged(before,after,async()=>{throw Error('missing revision');}),false);
});

test('the 14.10. helper release (3e87220 to 1d0d4ab) reuses the published native app', async () => {
  // Exact `git diff --name-only 3e87220 1d0d4ab`: 49 files, none of them a build input.
  const changed = ['docs/completion-counts-live-2026-10-14.json','docs/fleet-monitoring.md','docs/team-remote-access.md',
    'docs/worker-remote-access-handoff-2026-10-12.md','docs/worker-remote-access.md','releases/worker-native.json',
    'scripts/blocked-error-inventory.test.mjs','scripts/completion-evidence.test.mjs','scripts/error-copy-cleanup.mjs',
    'scripts/error-copy-cleanup.test.mjs','scripts/install-monitor-hub.mjs','scripts/install-monitor-hub.sh',
    'scripts/install-monitor-hub.test.mjs','scripts/install-worker-admin.sh','scripts/install-worker-observer.mjs',
    'scripts/install-worker-observer.test.mjs','scripts/member-remote.py','scripts/newsletter-monitor-bridge.mjs',
    'scripts/newsletter-monitor-bridge.test.mjs','scripts/newsletter-monitor-sales.test.mjs','scripts/pm-question-status.mjs',
    'scripts/pm-question-status.test.mjs','scripts/setup-mac-monitor.mjs','scripts/setup-mac-monitor.test.mjs',
    'scripts/setup-worker-remote.sh','scripts/test_member_remote.py','scripts/worker-admin-hub.mjs','scripts/worker-admin.mjs',
    'scripts/worker-admin.test.mjs','scripts/worker-diagnose.py','scripts/worker-remote-hub.mjs','scripts/worker-remote.mjs',
    'scripts/worker-remote.test.mjs','team-server/fleet.js','team-server/public/dashboard.css','team-server/public/dashboard.html',
    'team-server/public/dashboard.js','team-server/remote-access.js','team-server/server.js','team-server/skill-versions.js',
    'team-server/test/clarification.test.js','team-server/test/completion-evidence.test.js','team-server/test/current-queue.test.js',
    'team-server/test/dashboard-pipeline-period.test.js','team-server/test/remote-access.test.js','team-server/test/skill-versions.test.js',
    'team-server/test/worker-control.test.js','team-server/test/worker-reports.test.js','team-server/worker-reports.js'];
  assert.equal(changed.length,49);
  const from = '3e87220a629dc9e4a6e67a6a2179d77e7d4b075c', to = '1d0d4ab14f75b73ab11c7b6667cd20dbc69d0f09';
  assert.equal(await nativeCodeUnchanged(from,to,async (command,args) => {
    assert.deepEqual([command,...args.slice(2)],['git','diff','--name-only',from,to,'--']);
    return changed.join('\n')+'\n';
  }),true);
});

test('server runtime manifests never change native compatibility or the native retry key in a real Git repository', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-native-inputs-'));
  t.after(()=>fs.rm(repo,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  const commit = () => {git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture');return git('rev-parse','HEAD');};
  git('init','--quiet');
  await fs.mkdir(path.join(repo,'Config'));
  await fs.writeFile(path.join(repo,'Config','Info.plist'),'<plist><dict/></plist>');
  await fs.writeFile(path.join(repo,'Config','Usage4Claude.entitlements'),'<plist><dict/></plist>');
  await fs.writeFile(path.join(repo,'Config','runtime-release-files.json'),'[]');
  const first = commit();
  const runner = async (command,args) => {assert.equal(command,'git');return git(...args.slice(2));};
  const initialKey = await nativeSourceKey(first,runner);
  await fs.writeFile(path.join(repo,'Config','runtime-release-files.json'),'["team-server/server.js"]');
  const runtime = commit();
  assert.equal(await nativeCodeUnchanged(first,runtime,runner),true);
  assert.equal(await nativeSourceKey(runtime,runner),initialKey);
  for (const file of ['Info.plist','Usage4Claude.entitlements']) {
    const previous = git('rev-parse','HEAD'), previousKey = await nativeSourceKey(previous,runner);
    await fs.appendFile(path.join(repo,'Config',file),'\n<!-- native input change -->');
    const changed = commit();
    assert.equal(await nativeCodeUnchanged(previous,changed,runner),false,file);
    assert.notEqual(await nativeSourceKey(changed,runner),previousKey,file);
  }
});

// A14-02 (Fehleraudit 17.10.2026): the back-off is a deliberate deferral, not a
// failure. It ended every minute with exit 1, so RS-Skills logged an ERROR every
// minute for six hours (sync.log 14./15.10.: 1477 errors on four Macs).
test('a failed source build is not repeated for the same native code and toolchain within 6 hours', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  await f.writeReceipt('a'.repeat(40));
  let clock = Date.parse('2026-10-15T08:00:00Z');
  const native = {tree:'040000 tree '+'1'.repeat(40)+'\tUsage4Claude\n', swiftc:'Apple Swift version 6.1 (swiftlang-6.1)\nTarget: arm64-apple-macosx15.0\n'};
  let builds = 0, artifact = null;
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === 'git' && args.includes('diff')) return 'Usage4Claude/Helpers/FleetReporter.swift\nscripts/new-runtime.mjs\n';
    if (command === 'git' && args.includes('ls-tree')) return native.tree;
    if (command === 'swiftc') { assert.deepEqual(args,['--version']); return native.swiftc; }
    if (command === '/bin/bash') {
      builds++;
      throw Object.assign(new Error('Max Monitor bauen fehlgeschlagen (Exit 1).'), {exitCode:1,
        outputTail:'\u001b[0;34mℹ️  Kompiliere Swift-Quellen…\u001b[0m\n/Users/w/src/Usage4Claude/Helpers/FleetReporter.swift:12:5: error: cannot find \'reportLoad\' in scope\n        reportLoad()\n        ^~~~~~~~~~\n'});
    }
    return runner(command,args,...rest);
  };
  f.dependencies.artifactReader = async () => artifact;
  f.dependencies.now = () => clock;
  const update = () => setup({...f.options,appBundle:null,updateOnly:true,open:false},f.dependencies);
  // The first failure names its cause: the step and the compiler's error line.
  await assert.rejects(update(),error => {
    assert.match(error.message,/^Max Monitor bauen fehlgeschlagen \(Exit 1\): .*FleetReporter\.swift:12:5: error: cannot find 'reportLoad' in scope$/);
    assert.ok(error.message.length <= 300);
    assert.ok(!error.message.includes('\u001b'));
    return true;
  });
  assert.equal(builds,1);
  let receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.match(receipt.buildFailure.nativeKey,/^[a-f0-9]{64}$/);
  assert.equal(receipt.buildFailure.swiftcVersion,'Apple Swift version 6.1 (swiftlang-6.1)');
  assert.equal(receipt.buildFailure.at,new Date(clock).toISOString());
  assert.match(receipt.buildFailure.cause,/error: cannot find 'reportLoad' in scope$/);
  // The failed revision is never recorded as installed.
  assert.equal(receipt.sourceRevision,'a'.repeat(40));
  clock += 60000;
  const deferred = await update();
  assert.deepEqual({...deferred,cause:undefined},{schema:1,mode:'deferred',deferred:true,reason:'build_failed',
    failedAt:'2026-10-15T08:00:00.000Z',retryAt:'2026-10-15T14:00:00.000Z',cause:undefined});
  assert.match(deferred.cause,/error: cannot find 'reportLoad' in scope$/);
  assert.match(f.logs.at(-1),/^Max Monitor bauen zurückgestellt/);
  for (const marker of ['EPERM','EACCES','Operation not permitted','Permission denied','App-Version','Laufende Monitor-App'])
    assert.ok(!f.logs.at(-1).includes(marker),marker);
  assert.equal(builds,1,'the second update-only run does not build again');
  assert.equal(await f.marker(),'previous app');
  // A new toolchain, new native code or the end of the 6-hour window builds again.
  native.swiftc = 'Apple Swift version 6.2\n';
  await assert.rejects(update(),/Max Monitor bauen fehlgeschlagen/); assert.equal(builds,2);
  assert.equal((await update()).mode,'deferred'); assert.equal(builds,2);
  native.tree = '040000 tree '+'2'.repeat(40)+'\tUsage4Claude\n';
  await assert.rejects(update(),/Max Monitor bauen fehlgeschlagen/); assert.equal(builds,3);
  clock += 6*3600000;
  await assert.rejects(update(),/Max Monitor bauen fehlgeschlagen/); assert.equal(builds,4);
  // A verified release artifact still installs and clears the recorded failure.
  artifact = f.source;
  const result = await update();
  assert.equal(result.mode,'installed'); assert.equal(builds,4);
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.equal(receipt.buildFailure,undefined);
});

// A14-02: sporadic update failures (Mac 5, 17.10. 01:59–03:19 CEST) left no cause:
// the next success rewrote the receipt and RS-Skills' status file every minute.
test('the last update failure stays in the receipt with its cause after a later success', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  await f.writeReceipt();
  let clock = Date.parse('2026-10-17T00:00:00Z');
  f.dependencies.now = () => clock;
  const runner = f.dependencies.runner;
  let failOpen = true;
  f.dependencies.runner = async (command,args,options = {}) => {
    if (command === '/usr/bin/open' && failOpen) throw new Error('Max Monitor öffnen fehlgeschlagen (Exit 1).');
    return runner(command,args,options);
  };
  const update = () => setup({...f.options,appBundle:null,updateOnly:true},f.dependencies);
  const message = 'Max Monitor öffnen fehlgeschlagen (Exit 1).';
  await assert.rejects(update(),/Max Monitor öffnen fehlgeschlagen/);
  let receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.deepEqual(receipt.lastFailure,{at:'2026-10-17T00:00:00.000Z',message,since:'2026-10-17T00:00:00.000Z',count:1});
  assert.equal(receipt.sourceRevision,REVISION,'a failure changes nothing else in the receipt');
  // The same failure in a row is one episode.
  clock += 60000;
  await assert.rejects(update(),/Max Monitor öffnen fehlgeschlagen/);
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.deepEqual(receipt.lastFailure,{at:'2026-10-17T00:01:00.000Z',message,since:'2026-10-17T00:00:00.000Z',count:2});
  failOpen = false; clock += 60000;
  assert.equal((await update()).mode,'existing');
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.deepEqual(receipt.lastFailure,{at:'2026-10-17T00:01:00.000Z',message,since:'2026-10-17T00:00:00.000Z',count:2,
    recoveredAt:'2026-10-17T00:02:00.000Z'});
  clock += 60000;
  await update();
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.equal(receipt.lastFailure.recoveredAt,'2026-10-17T00:02:00.000Z','the first recovery time stays');
  // A failure after the recovery starts a new episode (the app quit meanwhile).
  failOpen = true; clock += 60000; f.state.runningApps = [];
  await assert.rejects(update(),/Max Monitor öffnen fehlgeschlagen/);
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.deepEqual(receipt.lastFailure,{at:'2026-10-17T00:04:00.000Z',message,since:'2026-10-17T00:04:00.000Z',count:1});
});

// Review A14-02: the sporadic Mac 5 failures had no build failure, so they can
// come from any step of the background update, also before the app check.
test('a background update that fails before the app check also keeps its cause', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  await f.writeReceipt();
  f.dependencies.now = () => Date.parse('2026-10-17T01:59:00Z');
  f.dependencies.manifestReader = async () => { throw new Error('Worker-Release nicht lesbar: ENOENT releases/worker-native.json'); };
  await assert.rejects(setup({...f.options,appBundle:null,updateOnly:true},f.dependencies),/ENOENT/);
  let receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.deepEqual(receipt.lastFailure,{at:'2026-10-17T01:59:00.000Z',message:'Worker-Release nicht lesbar: ENOENT releases/worker-native.json',
    since:'2026-10-17T01:59:00.000Z',count:1});
  assert.equal(receipt.sourceRevision,REVISION,'nothing else in the receipt changes');
  f.dependencies.workerReader = async () => { throw new Error('Worker-Konfiguration fehlt.'); };
  await assert.rejects(setup({...f.options,appBundle:null,updateOnly:true},f.dependencies),/Worker-Konfiguration fehlt/);
  receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.equal(receipt.lastFailure.message,'Worker-Konfiguration fehlt.');
  // An interactive enrollment never writes a failure into the receipt.
  await assert.rejects(setup({...f.options},f.dependencies),/Worker-Konfiguration fehlt/);
  assert.equal(JSON.parse(await fs.readFile(f.receiptPath,'utf8')).lastFailure.count,1);
});

// Review A14-02: swiftc prints the source line after its diagnostic. A source
// line such as `let error: ErrorDetail` or a German "fehlgeschlagen" string must
// not replace the diagnostic, nor may the driver's closing summary line.
test('the build cause is the compiler diagnostic, not the quoted source line or the driver summary', () => {
  assert.equal(buildCause("/x/Usage4Claude/Models/A.swift:279:9: error: cannot find type 'ErrorDetail' in scope\n    let error: ErrorDetail\n               ^~~~~~~~~~~\n"),
    "Usage4Claude/Models/A.swift:279:9: error: cannot find type 'ErrorDetail' in scope");
  assert.equal(buildCause('Usage4Claude/B.swift:3:1: error: missing return\n    log("Laden fehlgeschlagen")\n    ^\n'),
    'Usage4Claude/B.swift:3:1: error: missing return');
  assert.equal(buildCause('Usage4Claude/C.swift:1:1: error: boom\nerror: emit-module command failed with exit code 1 (use -v to see invocation)\n'),
    'Usage4Claude/C.swift:1:1: error: boom');
  assert.equal(buildCause(`curl: (6) Could not resolve host\n${os.homedir()}/Library/Caches/sparkle: error: download failed\n`),
    '~/Library/Caches/sparkle: error: download failed');
});

test('a deferred build ends the background run without an error exit and prints its state as JSON', async () => {
  const previous = process.exitCode;
  const out = [], err = [];
  try {
    process.exitCode = undefined;
    const deferred = {schema:1,mode:'deferred',deferred:true,reason:'build_failed',failedAt:'2026-10-15T08:00:00.000Z',retryAt:'2026-10-15T14:00:00.000Z',cause:'x'};
    let observed = 0;
    await main(['--update-only','--worker-root','/tmp/worker'],{setupImpl:async options => { assert.equal(options.updateOnly,true); return deferred; },
      observerImpl:async () => { observed++; return {installed:false}; }, out:value => out.push(value), err:value => err.push(value)});
    assert.equal(process.exitCode,undefined);
    assert.deepEqual(err,[]);
    assert.deepEqual(JSON.parse(out.at(-1)),deferred);
    assert.equal(observed,1,'the worker observer is still ensured');
    await main(['--update-only','--worker-root','/tmp/worker'],{setupImpl:async () => { throw new Error('Max Monitor bauen fehlgeschlagen (Exit 1): error: x'); },
      observerImpl:async () => ({installed:false}), out:value => out.push(value), err:value => err.push(value)});
    assert.equal(process.exitCode,1);
    assert.deepEqual(err,['Max Monitor: Max Monitor bauen fehlgeschlagen (Exit 1): error: x']);
  } finally { process.exitCode = previous; }
});

test('a build keeps its output visible and returns the tail of it on failure', async () => {
  const forwarded = {stdout:'',stderr:''};
  const sink = name => ({write:chunk => { forwarded[name] += chunk; return true; }});
  await assert.rejects(run(process.execPath,['-e',
    'console.log("\\u001b[0;34mKompiliere\\u001b[0m"); console.error("A.swift:1:1: error: boom"); process.exit(1)'],
    {tee:{stdout:sink('stdout'),stderr:sink('stderr')},label:'Max Monitor bauen',timeout:5000}),error => {
    assert.equal(error.message,'Max Monitor bauen fehlgeschlagen (Exit 1).');
    assert.match(error.outputTail,/Kompiliere/); assert.match(error.outputTail,/A\.swift:1:1: error: boom/);
    return true;
  });
  assert.match(forwarded.stdout,/Kompiliere/); assert.match(forwarded.stderr,/error: boom/);
  assert.equal(buildCause('noise\n/opt/src/Usage4Claude/A.swift:3:1: error: first\nmore\n❌ Build abgebrochen\n'),'❌ Build abgebrochen');
  assert.equal(buildCause('only\nlast line\n'),'last line');
  assert.equal(buildCause('token xoxb-123-secret error: x'),'token [ENTFERNT] error: x');
  assert.equal(buildCause(''),null);
  assert.ok(buildCause('error: '+'x'.repeat(500)).length <= 200);
});

test('observer-only updates preserve a current native app with local build metadata', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  await f.writeReceipt('a'.repeat(40));
  const read = f.dependencies.appReader;
  f.dependencies.appReader = async (...args) => ({...await read(...args),version:'2.14.1+dashboard'});
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => command === 'git' && args.includes('diff')
    ? 'scripts/install-worker-observer.mjs\nteam-server/public/dashboard.js' : runner(command,args,...rest);
  const result = await setup({...f.options,appBundle:null,updateOnly:true,open:false},f.dependencies);
  assert.equal(result.mode,'existing');
  assert.equal(await f.marker(),'previous app');
  assert.ok(!f.calls.some(c => c.command === '/bin/bash' || c.command === '/usr/bin/ditto'));
});

test('a helper update keeps the verified app running and records the checked source without rebuilding', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const before = 'a'.repeat(40); await f.writeReceipt(before);
  const old = f.runningApp();
  const unrelated = f.runningApp(path.join(f.directory,'Private Preview.app'),'de.rs.private-preview');
  f.state.terminationRefused = true;
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => command === 'git' && args.includes('diff')
    ? 'scripts/setup-mac-monitor.mjs\n' : runner(command,args,...rest);
  const result = await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
  assert.equal(result.mode,'existing');
  assert.equal(await f.marker(),'previous app');
  const receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.equal(receipt.sourceRevision,REVISION); assert.equal(receipt.binarySourceRevision,before);
  assert.equal(receipt.maintenanceVersion,1);
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid),unrelated);
  assert.ok(f.calls.some(c => c.args.at(-2) === 'forceTerminate'));
  const active = f.state.runningApps.find(app => app.bundleId === BUNDLE_ID);
  assert.notEqual(active.pid,old.pid);
  const resident = active.pid;
  await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
  assert.equal(f.state.runningApps.find(app => app.bundleId === BUNDLE_ID).pid,resident);
  assert.ok(!f.calls.some(c => c.command === '/bin/bash' || c.command === '/usr/bin/ditto' || c.args[0] === '--enrollment-status'));
});

test('update-only never invokes an old failing status CLI and preserves its settings', async t => {
  const f = await fixture(t, {previous:true,configured:true});
  f.state.status.workerId = null;
  f.state.status.memberId = null;
  f.state.status.role = 'super';
  const before = {...f.state.status};
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    if (args[0] === '--enrollment-status' && command.startsWith(f.options.appPath) && await f.marker() === 'previous app')
      throw new Error('old status command failed');
    return runner(command,args,...rest);
  };
  const result = await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(result.verified,undefined);
  assert.deepEqual(f.state.status,before);
  assert.ok(!f.calls.some(c => c.args[0] === '--enrollment-status'));
  assert.equal(await f.marker(),'new app');
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll'));
});

test('update-only preserves an owner identity without enrollment', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  f.state.status.role = 'super';
  f.state.status.memberId = 'team-owner';
  const before = { ...f.state.status };
  const result = await setup({ ...f.options, updateOnly: true }, f.dependencies);
  assert.equal(result.role, 'super');
  assert.deepEqual(f.state.status, before);
  assert.ok(!f.calls.some(call => call.command === 'ssh' || call.args[0] === '--enroll'));
  assert.equal(await f.marker(), 'new app');
  assert.equal(f.state.runningApps.length, 1);
});

test('update-only refuses an unconfigured monitor and rolls back changed preferences', async t => {
  const empty = await fixture(t);
  await assert.rejects(setup({ ...empty.options, updateOnly: true }, empty.dependencies), /Kein eingerichteter Monitor/);
  assert.ok(!empty.calls.some(call => call.command === '/usr/bin/ditto'));
  const f = await fixture(t, { previous: true, configured: true });
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === '/usr/bin/defaults' && args.at(-1) === 'teamServerMemberId' && await f.marker() === 'new app')
      return 'different-member\n';
    return runner(command,args,...rest);
  };
  await assert.rejects(setup({ ...f.options, updateOnly: true }, f.dependencies), /nicht vollständig bestätigt/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.args[0] === '--enroll'));
});

test('an existing app with missing cached preferences still updates without creating an account', async t => {
  const f = await fixture(t,{previous:true});
  const before = {...f.state.status};
  const result = await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(result.mode,'installed');
  assert.equal(result.configured,false);
  assert.equal(result.verified,undefined);
  assert.deepEqual(f.state.status,before);
  assert.equal(await f.marker(),'new app');
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll' || c.args[0] === '--enrollment-status'));
});

test('preference timeouts and read failures abort before closing or copying the installed app', async t => {
  for (const failure of [Object.assign(new Error('private stderr'),{timedOut:true}),new Error('permission denied')]) {
    const f = await fixture(t,{previous:true,configured:true});
    const old = f.runningApp(), initial = {...f.state.status}, runner = f.dependencies.runner;
    f.dependencies.runner = async (command,args,...rest) => {
      if (command === '/usr/bin/defaults') throw failure;
      return runner(command,args,...rest);
    };
    await assert.rejects(setup({...f.options,updateOnly:true},f.dependencies),error => {
      assert.equal(error.code,'MONITOR_PREFERENCES_UNAVAILABLE');
      assert.match(error.message,/Bindung nicht bestätigt/);
      assert.ok(!error.message.includes(failure.message));
      return true;
    });
    assert.equal(await f.marker(),'previous app');
    assert.deepEqual(f.state.runningApps,[old]);
    assert.deepEqual(f.state.status,initial);
    assert.ok(!f.calls.some(c => c.command === '/usr/bin/ditto' || c.command === '/usr/bin/osascript'));
    const receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
    assert.ok(receipt.lastFailure);
    assert.equal(receipt.sourceRevision,undefined);
    assert.equal(receipt.bindingVerification,undefined);
  }
});

test('only explicitly missing keys become null and safe preference reads have a five second budget', async () => {
  const calls = [];
  const result = await storedMonitorPreferences(BUNDLE_ID,async (command,args,options) => {
    calls.push({command,args,options});
    throw Object.assign(new Error('missing'),{preferenceMissing:true});
  });
  assert.equal(result.configured,false);
  assert.equal(result.deviceId,null);
  assert.equal(calls.length,6);
  assert.ok(calls.every(call => call.command === '/usr/bin/defaults' && call.args[0] === 'read' && call.options.timeout === 5000));
});

test('a preference read failure after replacement restores the old bundle and running app', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  f.runningApp();
  const initial = {...f.state.status}, runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === '/usr/bin/defaults' && await f.marker() === 'new app') throw new Error('read failed');
    return runner(command,args,...rest);
  };
  await assert.rejects(setup({...f.options,updateOnly:true},f.dependencies),{code:'MONITOR_PREFERENCES_UNAVAILABLE'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.status,initial);
  assert.equal(f.state.runningApps.length,1);
  assert.equal(f.state.runningApps[0].bundlePath,f.destination);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)),['Max Monitor.app']);
});

test('explicit code-only maintenance swaps only the app and leaves binding acceptance required', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  f.runningApp();
  await f.writeReceipt('a'.repeat(40));
  const initial = {...f.state.status}, runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    assert.ok(!['/usr/bin/defaults','ssh'].includes(command));
    assert.ok(!args.includes('--enroll') && !args.includes('--enrollment-status'));
    return runner(command,args,...rest);
  };
  const result = await setup({...f.options,updateOnly:true,codeOnly:true},f.dependencies);
  assert.deepEqual(result,{schema:1,mode:'installed',bindingVerification:'required'});
  assert.deepEqual(f.state.status,initial);
  assert.equal(await f.marker(),'new app');
  assert.equal(f.state.runningApps.length,1);
  assert.ok(f.calls.some(c => c.command === '/usr/bin/codesign'));
  const receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
  assert.equal(receipt.bindingVerification,'required');
  assert.equal(receipt.sourceRevision,REVISION);
  assert.equal(receipt.workerId,f.worker.workerId); // historical receipt, not a new identity read
  assert.equal(receipt.deviceId,undefined);
  assert.ok(f.logs.some(line => line.includes('Bindung noch nicht bestätigt')));
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)),['Max Monitor.app']);
});

test('explicit code-only maintenance retains rollback and restores the old process on failed signing', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  f.runningApp(); f.state.signatureFailure = true;
  await assert.rejects(setup({...f.options,updateOnly:true,codeOnly:true},f.dependencies),/App-Signatur/);
  assert.equal(await f.marker(),'previous app');
  assert.equal(f.state.runningApps.length,1);
  assert.equal(f.state.runningApps[0].bundlePath,f.destination);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)),['Max Monitor.app']);
  assert.equal(JSON.parse(await fs.readFile(f.receiptPath,'utf8')).bindingVerification,undefined);
});

test('an update retains the installed certificate requirement before stopping its app', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  f.runningApp();
  const runner = f.dependencies.runner, requirement = 'identifier "xyz.fi5h.Usage4Claude" and certificate leaf = H"'+'a'.repeat(40)+'"';
  let verified = false;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === '/usr/bin/codesign' && args.includes('-r-')) return 'designated => '+requirement+'\n';
    if (command === '/usr/bin/codesign' && args.includes('-R')) {
      assert.equal(args[args.indexOf('-R')+1],'='+requirement);
      assert.equal(args.at(-1),f.source);
      assert.equal(await f.marker(),'previous app');
      assert.equal(f.state.runningApps.length,1);
      verified = true;
      return '';
    }
    return runner(command,args,...rest);
  };
  await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(verified,true);
  assert.equal(await f.marker(),'new app');
});

test('missing or different artifact signing identity preserves the installed app and process', async t => {
  for (const codeOnly of [false,true]) {
    const f = await fixture(t,{previous:true,configured:true});
    const old = f.runningApp(), runner = f.dependencies.runner;
    f.dependencies.runner = async (command,args,...rest) => {
      if (command === '/usr/bin/codesign' && args.includes('-r-')) return 'designated => identifier "xyz.fi5h.Usage4Claude" and certificate leaf = H"'
        +(args.at(-1) === f.destination ? 'a' : 'b').repeat(40)+'"\n';
      if (command === '/usr/bin/codesign' && args.includes('-R')) throw new Error('candidate does not satisfy installed certificate requirement');
      return runner(command,args,...rest);
    };
    await assert.rejects(setup({...f.options,updateOnly:true,codeOnly},f.dependencies),/Vorhandene Signieridentität.*nicht bestätigt/);
    assert.equal(await f.marker(),'previous app');
    assert.deepEqual(f.state.runningApps,[old]);
    assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript'].includes(c.command)));
  }
});

test('unreadable signing requirements and an unexpected certificate on an ad-hoc app stop before replacement', async t => {
  for (const unreadable of [true,false]) {
    const f = await fixture(t,{previous:true,configured:true});
    const old = f.runningApp(), runner = f.dependencies.runner;
    f.dependencies.runner = async (command,args,...rest) => {
      if (command === '/usr/bin/codesign' && args.includes('-r-')) {
        if (unreadable) return '';
        return 'designated => identifier "xyz.fi5h.Usage4Claude" and '+(args.at(-1) === f.destination
          ? 'cdhash H"aabb"' : 'certificate leaf = H"'+'b'.repeat(40)+'"')+'\n';
      }
      return runner(command,args,...rest);
    };
    await assert.rejects(setup({...f.options,updateOnly:true,codeOnly:true},f.dependencies),/Signieridentität/);
    assert.equal(await f.marker(),'previous app');
    assert.deepEqual(f.state.runningApps,[old]);
    assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript'].includes(c.command)));
  }
});

test('locked, unavailable and unknown login keychains never stop or replace an existing app', async t => {
  for (const keychainStatus of [{available:true,unlocked:false},{available:false,unlocked:null},
    {available:true,unlocked:null},{available:true},{}, {available:'true',unlocked:true}]) {
    for (const codeOnly of [false,true]) {
      const f = await fixture(t,{previous:true,configured:true});
      const old = f.runningApp(); f.state.keychainStatus = keychainStatus;
      await assert.rejects(setup({...f.options,updateOnly:true,codeOnly},f.dependencies),
        {code:keychainStatus.available === true && keychainStatus.unlocked === false
          ? 'MONITOR_KEYCHAIN_LOCKED' : 'MONITOR_KEYCHAIN_UNAVAILABLE'});
      assert.equal(await f.marker(),'previous app');
      assert.deepEqual(f.state.runningApps,[old]);
      assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript'].includes(c.command)));
      assert.ok(!f.logs.some(line => line.includes('aktualisiert')));
      assert.equal(JSON.parse(await fs.readFile(f.receiptPath,'utf8')).bindingVerification,undefined);
    }
  }
});

test('failed keychain metadata reads preserve the old app without trying any unlock or credential command', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const old = f.runningApp(), runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === '/usr/bin/python3' && args[1]?.startsWith('# monitor-keychain-state:'))
      throw Object.assign(new Error('metadata timeout'),{timedOut:true});
    return runner(command,args,...rest);
  };
  await assert.rejects(setup({...f.options,updateOnly:true,codeOnly:true},f.dependencies),{code:'MONITOR_KEYCHAIN_UNAVAILABLE'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript','/usr/bin/security'].includes(c.command)));
});

test('a locked login keychain stops before artifact download or a costly native build', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const old = f.runningApp();f.state.keychainStatus = {available:true,unlocked:false};
  f.dependencies.artifactReader = async () => assert.fail('locked keychain must stop before artifact work');
  await assert.rejects(setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies),{code:'MONITOR_KEYCHAIN_LOCKED'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(!f.calls.some(c => ['/bin/bash','swiftc','/usr/bin/ditto'].includes(c.command)));
});

test('a keychain locked during candidate preparation is rechecked before stopping the existing app', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const old = f.runningApp(),runner=f.dependencies.runner;let checks=0;
  f.dependencies.runner = async (command,args,...rest) => {
    if (command === '/usr/bin/python3' && args[1]?.startsWith('# monitor-keychain-state:'))
      return JSON.stringify({available:true,unlocked:++checks === 1});
    return runner(command,args,...rest);
  };
  await assert.rejects(setup({...f.options,updateOnly:true},f.dependencies),{code:'MONITOR_KEYCHAIN_LOCKED'});
  assert.equal(checks,2);
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript'].includes(c.command)));
});

test('the existing-code migration restart also waits for an unlocked login keychain', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const old = f.runningApp(); f.state.keychainStatus = {available:true,unlocked:false};
  await f.writeReceipt();
  await assert.rejects(setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies),{code:'MONITOR_KEYCHAIN_LOCKED'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/osascript'].includes(c.command)));
});

test('the current-code fast path preserves another active copy while locked and reuses the exact active app without a keychain probe', async t => {
  for (const otherCopy of [true,false]) {
    const f = await fixture(t,{previous:true,configured:true});
    const old = f.runningApp(otherCopy ? path.join(f.directory,'Other Monitor.app') : f.destination);
    f.state.keychainStatus = {available:true,unlocked:false};
    await f.writeReceipt();
    const receipt = JSON.parse(await fs.readFile(f.receiptPath,'utf8'));
    await fs.writeFile(f.receiptPath,JSON.stringify({...receipt,maintenanceVersion:1}));
    const action = setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
    if (otherCopy) await assert.rejects(action,{code:'MONITOR_KEYCHAIN_LOCKED'});
    else assert.equal((await action).mode,'existing');
    assert.equal(await f.marker(),'previous app');
    assert.deepEqual(f.state.runningApps,[old]);
    assert.ok(!f.calls.some(c => ['/usr/bin/ditto','/usr/bin/open'].includes(c.command)));
    assert.ok(!f.calls.some(c => c.command === '/usr/bin/osascript' && ['terminate','forceTerminate'].includes(c.args.at(-2))));
    assert.equal(f.calls.some(c => c.command === '/usr/bin/python3'),otherCopy);
  }
});

test('code-only is explicitly update-only and never installs the worker observer', async () => {
  for (const args of [['--code-only'],['--code-only','--update-only','--check'],['--code-only','--update-only','--dry-run']])
    assert.throws(()=>optionsFrom(args),/benötigt --update-only/);
  const output = [];
  await main(['--update-only','--code-only'],{
    setupImpl:async options => {assert.equal(options.codeOnly,true); return {schema:1,mode:'installed',bindingVerification:'required'};},
    observerImpl:async()=>assert.fail('code-only must not install a worker observer'),
    out:value=>output.push(value),err:value=>assert.fail(value),
  });
  assert.deepEqual(output,[JSON.stringify({schema:1,mode:'installed',bindingVerification:'required'})]);
});

test('background installation preserves settings flushed by the old GUI at shutdown', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  f.runningApp();
  const runner = f.dependencies.runner;
  f.dependencies.runner = async (command,args,...rest) => {
    const output = await runner(command,args,...rest);
    if (command === '/usr/bin/osascript' && args.at(-2) === 'terminate')
      f.state.status.workerId = 'native-binding';
    return output;
  };
  const result = await setup({...f.options,updateOnly:true},f.dependencies);
  assert.equal(result.workerId,'native-binding');
  assert.equal(f.state.status.workerId,'native-binding');
  assert.equal(await f.marker(),'new app');
  assert.ok(!f.calls.some(c => c.command === 'ssh' || c.args[0] === '--enroll' || c.args[0] === '--enrollment-status'));
});

test('first installation passes one member token only through native stdin and writes a private safe receipt', async t => {
  const f = await fixture(t);
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.mode, 'installed');
  assert.equal(result.workerId, f.worker.workerId);
  assert.equal(await f.marker(), 'new app');
  const enrollment = f.calls.find(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin'));
  assert.deepEqual(JSON.parse(enrollment.input), { workerId: f.worker.workerId, deviceId: DEVICE_ID, name: os.hostname() });
  const native = f.calls.find(call => call.args[0] === '--enroll');
  assert.equal(JSON.parse(native.input).token, MEMBER_TOKEN);
  assert.equal(JSON.parse(native.input).launchAtLogin, true);
  assert.ok(f.calls.every(call => !JSON.stringify(call.args).includes(MEMBER_TOKEN)));
  assert.ok(!f.logs.join('\n').includes(MEMBER_TOKEN));
  const receiptText = await fs.readFile(f.receiptPath, 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.sourceRevision, REVISION);
  assert.equal(receipt.deviceId, DEVICE_ID);
  assert.equal(receipt.teamId, 'RSMACS01');
  assert.ok(!receiptText.includes(MEMBER_TOKEN));
  assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
  assert.equal((await fs.stat(f.receiptPath)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
});

test('a repeated healthy setup keeps the existing app and member without another enrollment or copy', async t => {
  const f = await fixture(t);
  await setup(f.options, f.dependencies);
  const before = f.calls.length;
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  const repeated = f.calls.slice(before);
  assert.ok(!repeated.some(call => ['ssh', '/usr/bin/ditto', '/bin/bash'].includes(call.command)));
  assert.ok(!repeated.some(call => call.args[0] === '--enroll'));
  assert.ok(!repeated.some(call => call.command === '/usr/bin/open'), 'the intended app is already running');
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.equal(await f.marker(), 'new app');
});

test('a running copy with the old product name stops and the intended installation becomes live', async t => {
  const f = await fixture(t);
  const oldPath = path.join(f.directory, 'Applications', 'Usage4Claude 2.0.app');
  await appBundle(oldPath, 'old named app');
  const old = f.runningApp(oldPath);
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.mode, 'installed');
  assert.ok(!f.state.runningApps.some(app => app.pid === old.pid));
  assert.equal(await fs.readFile(path.join(oldPath, 'Contents', 'marker'), 'utf8'), 'old named app');
  const running = f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID);
  assert.equal(running.length, 1);
  assert.equal(running[0].bundlePath, f.destination);
  const opened = f.calls.find(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.args, ['-g', '-n', f.destination]);
  assert.ok(f.calls.some(call => call.command === '/usr/bin/osascript' && call.args.at(-2) === 'terminate'));
  assert.ok(!f.calls.some(call => call.command === '/bin/ps'));
});

test('other bundle IDs are preserved while matching monitor copies are replaced', async t => {
  const f = await fixture(t);
  f.runningApp(path.join(f.directory, 'Old Monitor.app'));
  const unrelated = f.runningApp(path.join(f.directory, 'Private Preview.app'), 'de.rs.private-preview');
  await setup(f.options, f.dependencies);
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.ok(f.calls.filter(call => call.command === '/usr/bin/osascript').every(call => call.args.at(-1) === BUNDLE_ID));
});

test('refusing graceful termination blocks app replacement and member enrollment', async t => {
  const f = await fixture(t, { previous: true });
  const running = f.runningApp();
  f.state.terminationRefused = true;
  await assert.rejects(setup(f.options, f.dependencies));
  assert.deepEqual(f.state.runningApps, [running]);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
});

test('missing or wrong process after opening prevents receipt creation and restores the previous bundle', async t => {
  for (const failure of ['openAbsent', 'openWrongPath']) {
    const f = await fixture(t, { previous: true });
    f.state[failure] = true;
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
    assert.ok(f.calls.some(call => call.command === '/usr/bin/open'));
    assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 0,
      'rollback stops any failed newly opened monitor process before removing its bundle');
  }
});

test('a receipt write failure stops the new process and restores only captured original monitor paths', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Renamed Existing Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  const unrelated = f.runningApp(path.join(f.directory, 'Other Tool.app'), 'de.rs.other-tool');
  // A directory at the receipt path reliably makes writeFile fail on every platform.
  await fs.mkdir(f.receiptPath, { recursive: true });
  await assert.rejects(setup(f.options, f.dependencies), { code: 'EISDIR' });
  assert.equal(await f.marker(), 'previous app');
  assert.equal((await fs.stat(f.receiptPath)).isDirectory(), true);
  assert.deepEqual(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).map(app => app.bundlePath), [oldPath]);
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
  const opened = f.calls.filter(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.map(call => call.args), [['-g', '-n', f.destination], ['-g', '-n', oldPath]]);
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
  assert.equal(await fs.readFile(path.join(oldPath, 'Contents', 'marker'), 'utf8'), 'old named app');
});

test('a healthy repeated setup with a different running path opens only the intended installation', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  const old = f.runningApp(path.join(f.directory, 'Usage4Claude.app'));
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  assert.ok(!f.state.runningApps.some(app => app.pid === old.pid));
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID && app.bundlePath === f.destination).length, 1);
  assert.equal(f.calls.filter(call => call.command === '/usr/bin/open').length, 1);
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
});

test('rollback reopens only the stopped original monitor paths and preserves unrelated apps', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Old Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  const unrelated = f.runningApp(path.join(f.directory, 'Other Tool.app'), 'de.rs.other-tool');
  f.state.nativeFailure = true;
  await assert.rejects(setup(f.options, f.dependencies));
  assert.equal(await f.marker(), 'previous app');
  const opened = f.calls.filter(call => call.command === '/usr/bin/open');
  assert.deepEqual(opened.map(call => call.args), [['-g', '-n', oldPath]]);
  assert.ok(f.state.runningApps.some(app => app.bundleId === BUNDLE_ID && app.bundlePath === oldPath));
  assert.deepEqual(f.state.runningApps.find(app => app.pid === unrelated.pid), unrelated);
});

test('signature failure also restores a stopped original process before member enrollment', async t => {
  const f = await fixture(t, { previous: true });
  const oldPath = path.join(f.directory, 'Renamed Monitor.app');
  await appBundle(oldPath, 'old named app');
  f.runningApp(oldPath);
  f.state.signatureFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /App-Signatur/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(f.state.runningApps.some(app => app.bundleId === BUNDLE_ID && app.bundlePath === oldPath));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
});

test('check succeeds read-only for the installed source and rejects a stale receipt without enrollment', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  const receipt = await fs.readFile(f.receiptPath, 'utf8');
  const options = { ...f.options, appBundle: undefined, check: true };
  assert.equal((await setup(options, f.dependencies)).mode, 'check');
  f.state.revision = 'd'.repeat(40);
  await assert.rejects(setup(options, f.dependencies), /aktuelle Repo-Version/);
  assert.equal(await f.marker(), 'previous app');
  assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
  assert.ok(f.calls.every(call => call.command === 'git' || call.args[0] === '--enrollment-status'));
});

test('dry-run performs no commands, app copy, receipt write or member enrollment, including on non-macOS', async t => {
  const f = await fixture(t, { previous: true });
  const result = await setup({ ...f.options, dryRun: true }, { ...f.dependencies, platform: 'linux' });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.workerId, f.worker.workerId);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
  assert.equal(await f.marker(), 'previous app');
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
});

test('unavailable central capabilities fail before copying the app or enrolling a member', async t => {
  const f = await fixture(t, { previous: true });
  f.state.preflight = { ok: true, schema: 0 };
  await assert.rejects(setup(f.options, f.dependencies), /noch nicht bereitgestellt/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
});

test('invalid worker/device mappings and public HTTP are rejected before native token storage', async t => {
  const variants = [{ workerId: 'mac-other' }, { deviceId: '610be10e-8a00-4e00-b000-000000000052' },
    { serverURL: 'http://monitor.example.test' }, { serverURL: 'https://user:password@monitor.example.test' },
    { serverURL: 'https://monitor.example.test?token=secret' }];
  for (const variant of variants) {
    const f = await fixture(t, { previous: true });
    f.state.enrollment = { ...f.state.enrollment, ...variant };
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    assert.ok(!f.calls.some(call => call.args[0] === '--enroll'));
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  }
});

test('native enrollment or installed-app failures restore the previous bundle and existing receipt', async t => {
  for (const failure of ['nativeFailure', 'appFailure']) {
    const f = await fixture(t, { previous: true });
    await f.writeReceipt('b'.repeat(40));
    const receipt = await fs.readFile(f.receiptPath, 'utf8');
    // This injected app reader failure starts after the old bundle is inspected.
    if (failure === 'appFailure') {
      const runner = f.dependencies.runner;
      f.dependencies.runner = async (...args) => {
        const result = await runner(...args);
        if (args[0] === '/usr/bin/codesign') f.state.appFailure = true;
        return result;
      };
    } else f.state.nativeFailure = true;
    await assert.rejects(setup(f.options, f.dependencies));
    assert.equal(await f.marker(), 'previous app');
    assert.equal(await fs.readFile(f.receiptPath, 'utf8'), receipt);
    assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
  }
});

test('a bad signature leaves the previous bundle in place and never sends enrollment stdin', async t => {
  const f = await fixture(t, { previous: true });
  f.state.signatureFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /App-Signatur/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
  assert.deepEqual(await fs.readdir(path.dirname(f.destination)), ['Max Monitor.app']);
});

test('verified fleet access is required before writing an installation receipt', async t => {
  const f = await fixture(t, { previous: true });
  f.state.fleetFailure = true;
  await assert.rejects(setup(f.options, f.dependencies), /noch nicht erreichbar/);
  assert.equal(await f.marker(), 'previous app');
  await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
});

test('an existing personal/other worker connection is never taken over', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  f.state.status.workerId = 'another-worker';
  await assert.rejects(setup(f.options, f.dependencies), /anderen Einrichtung/);
  assert.equal(await f.marker(), 'previous app');
  assert.ok(!f.calls.some(call => call.command === 'ssh' || call.command === '/usr/bin/ditto'));
});

test('native status is whitelisted so unexpected secrets cannot escape through setup output', async () => {
  const value = await appStatus({ executable: '/fake/app' }, true,
    async () => JSON.stringify({ schema: 1, deviceId: DEVICE_ID, verified: true, fleetAvailable: true,
      token: MEMBER_TOKEN, authorization: `Bearer ${MEMBER_TOKEN}`, vault: { token: MEMBER_TOKEN } }));
  assert.deepEqual(value, { schema: 1, deviceId: DEVICE_ID, verified: true, fleetAvailable: true });
});

test('an existing owner or admin is preserved even with the same worker and no member ID', async t => {
  for (const role of ['super', 'admin']) {
    const f = await fixture(t, { previous: true, configured: true });
    f.state.status.role = role;
    delete f.state.status.memberId;
    await assert.rejects(setup(f.options, f.dependencies), /Inhaber- oder Admin-Zugang/);
    assert.equal(await f.marker(), 'previous app');
    assert.ok(!f.calls.some(call => call.command === 'ssh' || call.command === '/usr/bin/ditto' || call.args[0] === '--enroll'));
  }
});

test('upgrading an old app detects preserved personal connections before member creation and restores the old bundle', async t => {
  for (const variant of [{ role: 'super', memberId: undefined }, { role: 'member', workerId: 'another-worker' }]) {
    const f = await fixture(t, { previous: true, configured: true });
    Object.assign(f.state.status, variant);
    // The unsupported old target exposes no enrollment CLI; the newly copied app can read its preferences.
    const supportedReader = f.dependencies.appReader;
    let destinationReads = 0;
    f.dependencies.appReader = async (...args) => {
      if (args[0] === f.destination && destinationReads++ === 0) return null;
      return supportedReader(...args);
    };
    await assert.rejects(setup(f.options, f.dependencies), /Inhaber- oder Admin-Zugang|anderen Einrichtung/);
    assert.equal(await f.marker(), 'previous app');
    assert.ok(f.calls.some(call => call.command === '/usr/bin/ditto'));
    assert.ok(!f.calls.some(call => call.command === 'ssh' && call.args.at(-1).endsWith('--stdin')));
    assert.ok(!f.calls.some(call => call.args[0] === '--enroll'));
    await assert.rejects(fs.access(f.receiptPath), { code: 'ENOENT' });
  }
});

test('check reports pending login approval while preserving verified monitoring and remaining read-only', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  f.state.status.launchAtLoginStatus = 'requiresApproval';
  const result = await setup({ ...f.options, check: true }, f.dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.fleetAvailable, true);
  assert.equal(result.loginReady, false);
  assert.equal(result.loginActionRequired, true);
  assert.equal(result.loginApprovalRequired, true);
  assert.match(result.loginHint, /Systemeinstellungen.*Anmeldeobjekte/);
  assert.equal(f.logs.length, 0); // --check reserves stdout for its safe JSON result.
  assert.ok(f.calls.every(call => call.command === 'git' || call.args[0] === '--enrollment-status'));
});

test('repeated setup explains pending login approval without enrolling another member', async t => {
  const f = await fixture(t, { previous: true, configured: true });
  await f.writeReceipt();
  f.state.status.launchAtLoginStatus = 'requiresApproval';
  const result = await setup({ ...f.options, appBundle: undefined }, f.dependencies);
  assert.equal(result.mode, 'existing');
  assert.equal(result.loginApprovalRequired, true);
  assert.ok(f.logs.some(line => line.includes('Anmeldeobjekte')));
  assert.ok(!f.calls.some(call => call.command === 'ssh' || call.args[0] === '--enroll'));
});

test('failed autostart registration is reported separately from successful fleet enrollment', async t => {
  for (const state of ['notRegistered', 'notFound']) {
    const f = await fixture(t);
    f.state.loginStatus = state;
    const result = await setup(f.options, f.dependencies);
    assert.equal(result.mode, 'installed');
    assert.equal(result.verified, true);
    assert.equal(result.launchAtLoginStatus, state);
    assert.equal(result.loginReady, false);
    assert.equal(result.loginActionRequired, true);
    assert.equal(result.loginApprovalRequired, false);
    assert.ok(f.logs.some(line => line.includes('Autostart ist noch nicht aktiv')));
    assert.ok(!JSON.stringify(result).includes(MEMBER_TOKEN));
  }
});

test('explicitly disabled autostart does not produce an approval request or misleading ready flag', async t => {
  const f = await fixture(t);
  const result = await setup({ ...f.options, launchAtLogin: false }, f.dependencies);
  assert.equal(result.launchAtLoginRequested, false);
  assert.equal(result.loginReady, false);
  assert.equal(result.loginActionRequired, false);
  assert.equal(result.loginApprovalRequired, false);
  assert.ok(!f.logs.some(line => line.includes('Autostart') || line.includes('Anmeldeobjekte')));
});

test('autostart timeout retains only a separately verified exact enrolled connection', async t => {
  const f = await fixture(t, { previous:true });
  f.state.loginTimeout = true;
  f.state.loginStatus = 'notRegistered';
  const result = await setup(f.options, f.dependencies);
  assert.equal(result.verified, true);
  assert.equal(result.loginActionRequired, true);
  assert.equal(await f.marker(), 'new app');
  assert.ok(f.logs.some(line => line.includes('separat bestätigt')));
  assert.ok(f.logs.some(line => line.includes('Autostart ist noch nicht aktiv')));
  assert.equal(f.state.runningApps.filter(app => app.bundleId === BUNDLE_ID).length, 1);
  assert.equal(JSON.parse(await fs.readFile(f.receiptPath, 'utf8')).sourceRevision, REVISION);
});

test('autostart timeout never treats unavailable or different member identity as success', async t => {
  for (const variant of ['unavailable', 'other-member']) {
    const f = await fixture(t, { previous:true });
    f.state.loginTimeout = true;
    f.state.fleetFailure = variant === 'unavailable';
    const runner = f.dependencies.runner;
    f.dependencies.runner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (args[0] === '--enrollment-status' && args.includes('--verify') && variant === 'other-member')
        return JSON.stringify({...JSON.parse(result), memberId:'different-member'});
      return result;
    };
    await assert.rejects(setup(f.options, f.dependencies), /Server ist noch nicht erreichbar/);
    assert.equal(await f.marker(), 'previous app');
    await assert.rejects(fs.access(f.receiptPath), {code:'ENOENT'});
  }
});

test('phase tracking ignores arbitrary stderr, split markers and repeated or backwards phases cannot extend a timeout', {timeout:3000}, async () => {
  const phases = [];
  await assert.rejects(run(process.execPath, ['-e', `
    process.stderr.write(${JSON.stringify(MEMBER_TOKEN)} + '\\n');
    process.stderr.write('MAX_MONITOR_ENROLLMENT_');
    setTimeout(() => {
      process.stderr.write('STAGE:credentials\\nMAX_MONITOR_ENROLLMENT_STAGE:unknown\\n');
      setInterval(() => process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:credentials\\nMAX_MONITOR_ENROLLMENT_STAGE:relay\\n'), 5);
    }, 10);
  `], {timeout:3000, onProgress:stage => phases.push(stage), progressTimeouts:{credentials:60}}), error => {
    assert.equal(error.timedOut, true);
    assert.equal(error.stage, 'credentials');
    assert.match(error.message, /Schlüsselbund/);
    assert.ok(!error.message.includes(MEMBER_TOKEN));
    assert.deepEqual(phases, ['credentials']);
    return true;
  });
});

test('the credential phase receives its own budget after the initial timeout window', {timeout:5000}, async () => {
  const phases = [];
  const result = await run(process.execPath, ['-e', `
    process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:credentials\\n');
    setTimeout(() => { process.stderr.write('MAX_MONITOR_ENROLLMENT_STAGE:complete\\n'); process.stdout.write('done'); }, 1200);
  `], {timeout:1000, onProgress:stage => phases.push(stage), progressTimeouts:{credentials:3000}});
  assert.equal(result, 'done');
  assert.deepEqual(phases, ['credentials','complete']);
});

test('failed child stdout and stderr never leak their token into the runner error', async () => {
  await assert.rejects(run(process.execPath, ['-e',
    'process.stdin.resume(); process.stdin.on("data", data => { process.stdout.write(data); process.stderr.write(data); }); process.stdin.on("end", () => process.exit(7));'],
    { input: MEMBER_TOKEN, label: 'Hub-Anmeldung', timeout: 3000 }), error => {
    assert.match(error.message, /Hub-Anmeldung fehlgeschlagen \(Exit 7\)/);
    assert.ok(!error.message.includes(MEMBER_TOKEN));
    return true;
  });
});

test('a paused automatic release preserves the running app before source fallback, preferences or artifact work', async t => {
  const f = await fixture(t,{previous:true,configured:true});
  const old = f.runningApp();
  f.dependencies.manifestReader = async () => ({schema:1,version:'2.15.1',sourceRevision:'a'.repeat(40),paused:true});
  f.dependencies.artifactReader = async () => assert.fail('paused release must not download or build');
  f.dependencies.appReader = async () => assert.fail('paused release must not inspect or replace the app');
  const result = await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
  assert.deepEqual(result,{schema:1,mode:'deferred',deferred:true,reason:'release_paused'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.equal(f.calls.length,1); // source revision only; no source diff/fallback or native action
  assert.equal(f.calls[0].command,'git');
});

test('a directly requested paused artifact cannot fall back to a native build', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-artifact-hold-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const manifestPath=path.join(dir,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify({schema:1,version:'2.15.1',sourceRevision:'a'.repeat(40),
    sha256:'b'.repeat(64),tag:'worker-native-'+'a'.repeat(12),asset:'Max-Monitor-worker.zip',paused:true}));
  await assert.rejects(workerArtifactBundle(REVISION,async()=>assert.fail('no artifact action while paused'),{manifestPath}),
    {code:'MONITOR_RELEASE_PAUSED'});
});

test('a paused canary admits only the registered worker and preserves the existing binding', async t => {
  for (const selected of [false,true]) {
    const f=await fixture(t,{previous:true,configured:true});
    const old=f.runningApp(), binding={...f.state.status};
    f.dependencies.manifestReader=async()=>({schema:1,version:'2.14.1',sourceRevision:REVISION,
      paused:true,canaryWorkerIds:['mac-5']});
    if (!selected) f.worker.workerId='mac-50';
    let artifactOptions;
    f.dependencies.artifactReader=async(revision,runner,options)=>{artifactOptions=options;return f.source;};
    const result=await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
    if (selected) {
      assert.equal(result.mode,'installed');
      assert.equal(await f.marker(),'new app');
      assert.deepEqual(artifactOptions,{installedAppPath:f.options.appPath,workerId:'mac-5'});
      assert.deepEqual(f.state.status,binding);
      assert.ok(!f.calls.some(c=>c.command==='ssh'||c.args[0]==='--enroll'));
    } else {
      assert.equal(result.reason,'release_paused');
      assert.equal(artifactOptions,undefined);
      assert.equal(await f.marker(),'previous app');
      assert.deepEqual(f.state.runningApps,[old]);
      assert.equal(f.calls.length,1);
    }
  }
});

test('a paused canary cannot inspect the app or build after a native source mismatch', async t => {
  const f=await fixture(t,{previous:true,configured:true}),old=f.runningApp();
  f.dependencies.manifestReader=async()=>({schema:1,version:'2.14.1',sourceRevision:'a'.repeat(40),
    paused:true,canaryWorkerIds:[f.worker.workerId]});
  const runner=f.dependencies.runner;
  f.dependencies.runner=(command,args,options)=>command==='git'&&args.includes('diff')
    ? Promise.resolve('Usage4Claude/Services/CredentialVault.swift\n') : runner(command,args,options);
  f.dependencies.appReader=async()=>assert.fail('native mismatch must preserve the running app before inspection');
  f.dependencies.artifactReader=async()=>assert.fail('native mismatch cannot download or build');
  const result=await setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies);
  assert.equal(result.reason,'release_canary_source_mismatch');
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(f.calls.every(c=>c.command==='git'));
});

test('a vanished canary artifact cannot fall through to a source build or stop the installed app', async t => {
  const f=await fixture(t,{previous:true,configured:true}),old=f.runningApp();
  f.dependencies.manifestReader=async()=>({schema:1,version:'2.14.1',sourceRevision:REVISION,
    paused:true,canaryWorkerIds:[f.worker.workerId]});
  f.dependencies.artifactReader=async()=>null;
  await assert.rejects(setup({...f.options,appBundle:undefined,updateOnly:true},f.dependencies),{code:'MONITOR_RELEASE_PAUSED'});
  assert.equal(await f.marker(),'previous app');
  assert.deepEqual(f.state.runningApps,[old]);
  assert.ok(!f.calls.some(c=>c.args.includes('terminate')||c.command==='/bin/bash'||c.command==='/usr/bin/open'));
});

test('paused artifact admission requires the exact canary identity, pinned content and matching native source', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-canary-artifact-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const content=Buffer.from('pinned canary archive'),manifestPath=path.join(dir,'manifest.json');
  const manifest={schema:1,version:'2.15.2',sourceRevision:'a'.repeat(40),
    sha256:createHash('sha256').update(content).digest('hex'),tag:'worker-native-'+'a'.repeat(12),
    asset:'Max-Monitor-worker.zip',paused:true,canaryWorkerIds:['mac-5']};
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  for (const workerId of [undefined,'mac-50','MAC-5']) {
    await assert.rejects(workerArtifactBundle(REVISION,async()=>assert.fail('unlisted worker cannot perform artifact actions'),
      {manifestPath,workerId}),{code:'MONITOR_RELEASE_PAUSED'});
  }
  let changed=false,downloads=0;
  const runner=async(command,args)=>{
    if(command==='git')return changed&&args.includes('diff')?'Usage4Claude/Services/CredentialVault.swift\n':'';
    if(command==='gh'){downloads++;await fs.writeFile(path.join(args[args.indexOf('--dir')+1],manifest.asset),content);return '';}
    if(command==='/usr/bin/ditto'){await appBundle(path.join(args.at(-1),'Max Monitor.app'),'verified canary');return '';}
    if(command==='/usr/bin/codesign'||command==='/usr/bin/security')return '';
    assert.fail(command);
  };
  const options={manifestPath,workerId:'mac-5',cacheRoot:path.join(dir,'cache')};
  const bundle=await workerArtifactBundle(REVISION,runner,options);
  assert.equal(await fs.readFile(path.join(bundle,'Contents','marker'),'utf8'),'verified canary');
  changed=true;
  await assert.rejects(workerArtifactBundle(REVISION,runner,options),{code:'MONITOR_RELEASE_PAUSED'});
  assert.equal(downloads,1);
  for (const canaryWorkerIds of ['mac-5',['mac-5','mac-6'],['mac-5;open'],[5]]) {
    await fs.writeFile(manifestPath,JSON.stringify({...manifest,canaryWorkerIds}));
    await assert.rejects(workerArtifactManifest(manifestPath),/ungültig/);
  }
});

test('argument parsing and enrollment validation reject unsafe options; loopback requires explicit opt-in', () => {
  for (const args of [['--token', MEMBER_TOKEN], ['--check', '--dry-run'], ['--worker-root'],
    ['--hub-helper', '/opt/helper; echo secret']]) assert.throws(() => optionsFrom(args));
  const local = { serverURL: 'http://localhost:8940', teamId: 'RSMACS01', token: MEMBER_TOKEN,
    memberId: 'worker-mac-5', workerId: 'mac-5', deviceId: DEVICE_ID };
  assert.throws(() => validateEnrollment(local, 'mac-5', DEVICE_ID));
  assert.equal(validateEnrollment(local, 'mac-5', DEVICE_ID, true).serverURL, local.serverURL);
});
