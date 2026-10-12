import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { handle, registryAt, publicKey, validateEntry } from './worker-remote-hub.mjs';
import { install, uninstall, tunnelArgs, launchAgent, connectionArgs, authorizedLine, updateAuthorized, writePrivate, hubRequest, localHostKey } from './worker-remote.mjs';

function key() {
  const { publicKey: k } = generateKeyPairSync('ed25519');
  const bytes = k.export({ type: 'spki', format: 'der' }).subarray(-32);
  const wire = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from('ssh-ed25519'), Buffer.from([0,0,0,32]), bytes]);
  return 'ssh-ed25519 ' + wire.toString('base64');
}
const hostKey = key(), operatorKey = key();
const entry = { workerId: 'macbook-1', username: 'tuck2', port: 23000, hostKey };
const worker = { workerId: entry.workerId, hubHost: 'root@hub.example.test', identityFile: '/path with space/key', knownHostsFile: '/path with space/hosts' };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-remote-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'registry.json'), operatorFile = path.join(home, 'operator.pub');
  await fs.writeFile(operatorFile, operatorKey);
  const knownHostsFile = path.join(home, 'Documents/AI Newsletter Creation/config/hub_known_hosts');
  await fs.mkdir(path.dirname(knownHostsFile), { recursive: true });
  await fs.writeFile(knownHostsFile, `hub.example.test ${hostKey}\n`);
  return { home, file, operatorFile, worker: { ...worker, knownHostsFile }, settings: {}, permission: async () => ({ reason: 'enabled' }) };
}

test('key parsing rejects options, malformed wire data and multiple keys', () => {
  assert.equal(publicKey(hostKey + ' comment'), hostKey);
  for (const value of ['command="id" ' + hostKey, hostKey + '\n' + operatorKey, 'ssh-ed25519 AAAA', 'ssh-rsa AAAA', null]) assert.throws(() => publicKey(value));
});

test('registry validates ports, duplicate bindings and private regular files', async t => {
  const f = await fixture(t);
  for (const port of [22, 22999, 24000, '23000']) assert.throws(() => validateEntry({ ...entry, port }));
  await fs.writeFile(f.file, JSON.stringify({ schema: 1, workers: [entry, entry] }), { mode: 0o600 });
  assert.throws(() => registryAt(f.file), /Doppelte/);
  await fs.chmod(f.file, 0o644);
  assert.throws(() => registryAt(f.file), /private/);
  const link = path.join(f.home, 'link'); await fs.symlink(f.file, link);
  assert.throws(() => registryAt(link), /private/);
});

test('enrollment is stable and gives different Macs separate ports', async t => {
  const f = await fixture(t), body = { ...entry, operation: 'enroll' };
  const a = await handle(body, f), b = await handle(body, f);
  assert.deepEqual(a, b); assert.equal(a.operatorKey, operatorKey);
  const other = await handle({ ...body, workerId: 'macbook-2', hostKey: key() }, f);
  assert.equal(other.port, 23001);
  assert.equal((await fs.stat(f.file)).mode & 0o077, 0);
  const lookup = await handle({ operation: 'lookup', workerId: entry.workerId }, f);
  assert.equal(lookup.hostKey, hostKey); assert.ok(!('operatorKey' in lookup));
});

test('unknown and ambiguous workers cannot enroll; disabled workers remain repairable', async t => {
  const f = await fixture(t), body = { ...entry, operation: 'enroll' };
  for (const reason of ['ambiguous', 'unregistered']) await assert.rejects(handle(body, { ...f, permission: async () => ({ reason }) }));
  await assert.rejects(fs.access(f.file));
  assert.equal((await handle(body, { ...f, permission: async () => ({ reason: 'disabled' }) })).workerId, entry.workerId);
});

test('changed host key/user fails closed without modifying registry', async t => {
  const f = await fixture(t), body = { ...entry, operation: 'enroll' };
  await handle(body, f); const saved = await fs.readFile(f.file, 'utf8');
  for (const patch of [{ hostKey: key() }, { username: 'other' }]) await assert.rejects(handle({ ...body, ...patch }, f), /Identität/);
  assert.equal(await fs.readFile(f.file, 'utf8'), saved);
});

test('concurrent enrollment fails without deleting another process lock', async t => {
  const f = await fixture(t); await fs.mkdir(f.file + '.lock');
  await assert.rejects(handle({ ...entry, operation: 'enroll' }, f), { code: 'EEXIST' });
  await fs.access(f.file + '.lock'); await assert.rejects(fs.access(f.file));
});

test('independent launchd tunnel uses loopback, pinned Hub and automatic reconnection', () => {
  const args = tunnelArgs(worker, entry);
  assert.ok(args.includes('127.0.0.1:23000:127.0.0.1:22'));
  for (const value of ['ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3', 'StrictHostKeyChecking=yes', 'ControlPath=none', '-N', '-T']) assert.ok(args.includes(value));
  const plist = launchAgent(worker, entry, '/tmp/space & log');
  assert.ok(!plist.includes('cli.js')); assert.ok(plist.includes('<key>KeepAlive</key><true/>'));
  const result = execFileSync('python3', ['-c', 'import plistlib,sys,json; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps(p["ProgramArguments"]))'], { input: plist, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), ['/usr/bin/ssh', ...args]);
});

test('operator key accepts only tunnel-local connections and preserves unrelated keys', () => {
  const line = authorizedLine(operatorKey, entry.workerId);
  assert.ok(line.startsWith('from="127.0.0.1,::1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding '));
  assert.equal(updateAuthorized('existing-key\n' + line + '\n', line, line), 'existing-key\n' + line + '\n');
  assert.equal(updateAuthorized('existing-key\n' + line + '\n', null, line), 'existing-key\n');
});

test('proxy safely quotes paths and pins the target host key', () => {
  const args = connectionArgs({ ...worker, identityFile: "/tmp/o'connor key" }, entry, { identityFile: '/safe/key', knownHostsFile: '/safe/hosts', check: true });
  assert.ok(args.includes('HostKeyAlias=max-monitor-macbook-1'));
  assert.ok(args.includes('BatchMode=yes'));
  const proxy = args.find(a => a.startsWith('ProxyCommand='));
  const parsed = execFileSync('python3', ['-c', 'import shlex,sys,json; print(json.dumps(shlex.split(sys.argv[1])))', proxy.slice('ProxyCommand='.length)], { encoding: 'utf8' });
  assert.ok(JSON.parse(parsed).includes("/tmp/o'connor key"));
  assert.equal(args.at(-1), '/usr/bin/id -un');
});

test('Hub response cannot redirect to a different Mac', async () => {
  await assert.rejects(hubRequest(worker, { operation: 'lookup', workerId: entry.workerId }, async () => JSON.stringify({ schema: 1, ...entry, workerId: 'macbook-2' })), /passt nicht/);
});

test('private writes refuse symlinks', async t => {
  const f = await fixture(t), target = path.join(f.home, 'target'), link = path.join(f.home, 'link');
  await fs.writeFile(target, 'untouched'); await fs.symlink(target, link);
  await assert.rejects(writePrivate(link, 'changed'));
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('missing macOS permission causes no Hub enrollment or local mutation', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(install(worker, { home: f.home, uid: 501, platform: 'darwin', preflight: async () => { throw Error('permission'); }, execute: async () => { calls++; } }), /permission/);
  assert.equal(calls, 0); await assert.rejects(fs.access(path.join(f.home, '.ssh/authorized_keys')));
});

test('lazy macOS host-key creation is resolved with a local handshake; empty or ambiguous keys fail', async t => {
  const f = await fixture(t), file = path.join(f.home, 'not-created-yet.pub');
  assert.equal(await localHostKey(file, async (binary, args) => {
    assert.equal(binary, '/usr/bin/ssh-keyscan'); assert.deepEqual(args, ['-T', '5', '-t', 'ed25519', '127.0.0.1']);
    return '# localhost\n127.0.0.1 ' + hostKey + '\n';
  }), hostKey);
  await assert.rejects(localHostKey(file, async () => ''), /eindeutig/);
  await assert.rejects(localHostKey(file, async () => `127.0.0.1 ${hostKey}\n127.0.0.1 ${key()}\n`), /eindeutig/);
});

test('install and uninstall preserve unrelated keys and never touch newsletter service', async t => {
  const f = await fixture(t), hostKeyFile = path.join(f.home, 'host.pub');
  await fs.writeFile(hostKeyFile, hostKey); await fs.mkdir(path.join(f.home, '.ssh'));
  await fs.writeFile(path.join(f.home, '.ssh/authorized_keys'), 'existing-key\n');
  const calls = [], execute = async (binary, args) => { calls.push([binary, args]); return binary.endsWith('/ssh') ? JSON.stringify({ schema: 1, ...entry, operatorKey }) : ''; };
  const result = await install(f.worker, { home: f.home, uid: 501, platform: 'darwin', username: entry.username, hostKeyFile, preflight: async () => {}, execute });
  assert.equal(result.installed, true); assert.equal(result.verified, false);
  assert.ok((await fs.readFile(path.join(f.home, '.ssh/authorized_keys'), 'utf8')).startsWith('existing-key\n'));
  const plist = await fs.readFile(path.join(f.home, 'Library/LaunchAgents/de.rs.max-monitor.remote.plist'), 'utf8');
  assert.ok(!plist.includes('/Documents/'));
  const copied = path.join(f.home, '.local/share/max-monitor-remote/hub_known_hosts');
  assert.equal(await fs.readFile(copied, 'utf8'), await fs.readFile(f.worker.knownHostsFile, 'utf8'));
  assert.equal((await fs.stat(copied)).mode & 0o077, 0);
  await uninstall({ home: f.home, uid: 501, execute });
  assert.equal(await fs.readFile(path.join(f.home, '.ssh/authorized_keys'), 'utf8'), 'existing-key\n');
  await assert.rejects(fs.access(copied));
  assert.ok(!JSON.stringify(calls).includes('de.ruegamer-steiner.ai-newsletter'));
});

test('failed launchd install restores original authorized_keys and removes new artifacts', async t => {
  const f = await fixture(t), hostKeyFile = path.join(f.home, 'host.pub');
  await fs.writeFile(hostKeyFile, hostKey); await fs.mkdir(path.join(f.home, '.ssh'));
  const authorized = path.join(f.home, '.ssh/authorized_keys'); await fs.writeFile(authorized, 'existing-key\n');
  const execute = async (binary, args) => {
    if (binary.endsWith('/ssh')) return JSON.stringify({ schema: 1, ...entry, operatorKey });
    if (args[0] === 'bootstrap') throw Error('bootstrap failed'); return '';
  };
  await assert.rejects(install(f.worker, { home: f.home, uid: 501, platform: 'darwin', username: entry.username, hostKeyFile, preflight: async () => {}, execute }), /bootstrap failed/);
  assert.equal(await fs.readFile(authorized, 'utf8'), 'existing-key\n');
  await assert.rejects(fs.access(path.join(f.home, '.local/share/max-monitor-remote/profile.json')));
  await assert.rejects(fs.access(path.join(f.home, 'Library/LaunchAgents/de.rs.max-monitor.remote.plist')));
  await assert.rejects(fs.access(path.join(f.home, '.local/share/max-monitor-remote/hub_known_hosts')));
});

test('empty trusted Hub pins fail before authorizing a key or loading launchd', async t => {
  const f = await fixture(t), hostKeyFile = path.join(f.home, 'host.pub');
  await fs.writeFile(hostKeyFile, hostKey); await fs.writeFile(f.worker.knownHostsFile, '');
  const execute = async (binary, args) => {
    assert.equal(binary, '/usr/bin/ssh');
    return JSON.stringify({ schema: 1, ...entry, operatorKey });
  };
  await assert.rejects(install(f.worker, { home: f.home, uid: 501, platform: 'darwin', username: entry.username, hostKeyFile, preflight: async () => {}, execute }), /Hostschlüsseldatei/);
  await assert.rejects(fs.access(path.join(f.home, '.ssh/authorized_keys')));
});
