import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { workerCatalog, main, POLICY } from './native-vault-worker-catalog.mjs';

const devices = Array.from({ length: 9 }, (_, n) => `11111111-1111-4111-a111-${String(n + 1).padStart(12, '0')}`);
const wire = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const hostKey = 'ssh-ed25519 ' + Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), wire]).toString('base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'), directory = path.join(dataDir, 'CATALOG1');
  fs.mkdirSync(directory, { recursive: true });
  const options = { registryFile: path.join(root, 'registry.json'), policyFile: path.join(root, 'policy.json'),
    relayFile: path.join(root, 'relay.env'), settings: { teamId: 'CATALOG1', ownerToken: 'private-owner-never-print' }, now: () => 1700000000000 };
  const members = [], fleet = { schema: 1, machines: [], events: [], queue: { tasks: [] } }, registry = { schema: 1, workers: [] };
  const policy = { schema: 1, teamId: 'CATALOG1', hubHost: 'hub.example.test', excludedWorkerIds: [] };
  const write = (file, value) => { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  const save = () => {
    write(options.registryFile, registry); write(options.policyFile, policy);
    write(options.relayFile, `DATA_DIR=${dataDir}\nTEAM_TOKENS=private-owner-never-print\n`);
    write(path.join(directory, 'members.json'), members); write(path.join(directory, 'fleet.json'), fleet);
    write(path.join(directory, 'remote-ca.pub'), hostKey);
  };
  const remote = (workerId, deviceId) => registry.workers.push({ workerId, username: 'worker', port: 23000 + registry.workers.length, hostKey, ...(deviceId ? { deviceId } : {}) });
  const enroll = (workerId, deviceId, macWorker = true) => {
    const member = { id: 'member-' + members.length, role: 'member', macWorker, token: 'private-member-never-print', enrollment: { workerId, deviceId } };
    members.push(member); return member;
  };
  save(); return { root, directory, options, members, fleet, registry, policy, write, save, remote, enroll, catalog: () => workerCatalog(options) };
}

test('future registered workers appear without record ACLs and purpose comes only from the central profile', t => {
  const f = fixture(t); assert.deepEqual(f.catalog().workers, []);
  f.remote('future-worker', devices[0]); f.enroll('future-worker', devices[0]);
  f.registry.workers[0].workerKind = 'codex-repair'; f.save();
  const first = f.catalog(); assert.equal(first.policy, POLICY); assert.equal(first.sampledAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(first.workers[0], { workerId: 'future-worker', deviceId: devices[0], workerKind: 'newsletter', provider: 'claude',
    allowedWorkflows: ['newsletter', 'upload', 'translation', 'correction', 'sales'] });
  const codex = 'hausdraches-macbook-air-f1e2b4ad'; f.remote(codex, devices[1]); f.enroll(codex, devices[1]); f.save();
  assert.equal(f.catalog().workers.length, 2, 'fresh file reads pick up later registration without a static list');
  assert.deepEqual(f.catalog().workers.find(w => w.workerId === codex).allowedWorkflows, ['technical-repair', 'customer-onboarding']);
  assert.ok(!JSON.stringify(f.catalog()).includes('private-'));
});

test('registered legacy Blau and Grün resolve native devices while personal exclusions and observer links do not grant access', t => {
  const f = fixture(t), nativeMember = { id: 'native-member', role: 'member', macWorker: true };
  f.members.push(nativeMember);
  f.remote('macbook-2', devices[0]); f.fleet.machines.push({ deviceId: devices[0], ownerId: nativeMember.id });
  f.remote('mac-f121ae17'); f.fleet.machines.push({ workerId: 'mac-f121ae17', deviceId: devices[1], ownerId: nativeMember.id });
  f.remote('personal-source', devices[2]); f.enroll('personal-source', devices[2]); f.policy.excludedWorkerIds.push('personal-source');
  f.remote('observed-only'); f.fleet.observedWorkers = [{ workerId: 'observed-only', deviceId: devices[3] }];
  f.fleet.workerLinks = [{ workerId: 'observed-only', deviceId: devices[0] }]; f.save();
  assert.deepEqual(f.catalog().workers.map(w => w.workerId), ['mac-f121ae17', 'macbook-2']);
});

test('disabled member and native-owner switches are re-read and immediately remove a registered worker', t => {
  const f = fixture(t); f.remote('future-worker', devices[0]); const member = f.enroll('future-worker', devices[0]); f.save();
  assert.equal(f.catalog().workers.length, 1);
  member.macWorker = false; f.save(); assert.deepEqual(f.catalog().workers, []);
  member.macWorker = true; f.fleet.machines.push({ workerId: 'future-worker', deviceId: devices[0], ownerId: '__team_owner__' });
  f.save(); f.write(path.join(f.directory, 'owner.json'), { macWorker: true }); assert.equal(f.catalog().workers.length, 1);
  member.macWorker = false; f.save(); assert.deepEqual(f.catalog().workers, [], 'own disabled enrollment still wins over enabled native owner');
  member.macWorker = true; f.save(); f.write(path.join(f.directory, 'owner.json'), { macWorker: false }); assert.deepEqual(f.catalog().workers, []);
});

test('a stale explicit registry UUID is never replaced with another native UUID', t => {
  const f = fixture(t); f.remote('future-worker', devices[0]); const member = f.enroll('future-worker', devices[0]);
  f.fleet.machines.push({ workerId: 'future-worker', deviceId: devices[1], ownerId: member.id }); f.save();
  assert.deepEqual(f.catalog().workers, []);
});

test('worker-reported identity provenance cannot become a native binding', t => {
  const f = fixture(t); f.members.push({ id: 'native-member', role: 'member', macWorker: true });
  f.remote('reported-alias');
  f.fleet.machines.push({ workerId: 'reported-alias', workerIdSource: 'worker', deviceId: devices[0], ownerId: 'native-member' }); f.save();
  assert.deepEqual(f.catalog().workers, [], 'display-only worker ID cannot resolve the canonical device');
  f.registry.workers[0].deviceId = devices[0]; f.fleet.machines[0].telemetrySource = 'worker'; f.save();
  assert.deepEqual(f.catalog().workers, [], 'observer telemetry is never an app identity, even with an advertised UUID');
});

test('ambiguous enrollment and duplicate native identities fail closed; two legacy aliases cannot share one device', t => {
  const f = fixture(t); f.remote('future-worker', devices[0]); f.enroll('future-worker', devices[0]); f.enroll('different-worker', devices[0]); f.save();
  assert.throws(f.catalog, /Ambiguous central enrollment/);
  f.members.pop(); f.fleet.machines = [{ deviceId: devices[1], ownerId: f.members[0].id }, { deviceId: devices[1], ownerId: f.members[0].id }]; f.save();
  assert.throws(f.catalog, /Ambiguous native device/);
  f.fleet.machines = [{ deviceId: devices[0], ownerId: f.members[0].id }]; f.remote('other-alias'); f.enroll('other-alias', devices[1]);
  f.registry.workers[1].deviceId = devices[0]; f.registry.workers[0].deviceId = undefined; f.save();
  assert.deepEqual(f.catalog().workers, [], 'one alias resolves enrollment and the other the same native UUID');
});

test('central deletion tombstones remain effective even before every stale source record has disappeared', t => {
  const f = fixture(t); f.remote('future-worker', devices[0]); f.enroll('future-worker', devices[0]); f.save();
  f.fleet.deletedWorkers = ['future-worker']; f.save(); assert.deepEqual(f.catalog().workers, []);
  f.fleet.deletedWorkers = []; f.fleet.deletedDevices = [devices[0]]; f.save(); assert.deepEqual(f.catalog().workers, []);
});

test('missing, malformed, unsafe or nonprivate sources are failures rather than a fallback fleet', t => {
  for (const source of ['registry', 'members', 'fleet', 'policy', 'relay']) {
    const f = fixture(t), file = { registry: f.options.registryFile, members: path.join(f.directory, 'members.json'),
      fleet: path.join(f.directory, 'fleet.json'), policy: f.options.policyFile, relay: f.options.relayFile }[source];
    fs.unlinkSync(file); assert.throws(f.catalog, undefined, source + ' missing'); f.save();
    fs.chmodSync(file, 0o644); assert.throws(f.catalog, undefined, source + ' public');
  }
  const f = fixture(t); f.write(f.options.relayFile, 'DATA_DIR=/data/../other\n'); assert.throws(f.catalog);
  f.save(); f.write(path.join(f.directory, 'fleet.json'), { schema: 1, machines: [] }); assert.throws(f.catalog);
  f.save(); f.write(path.join(f.directory, 'owner.json'), { macWorker: 'yes' }); assert.throws(f.catalog);
  f.save(); fs.unlinkSync(f.options.registryFile); fs.symlinkSync(path.join(f.directory, 'members.json'), f.options.registryFile); assert.throws(f.catalog);
});

test('fixed stdin protocol publishes only canonical metadata and never modifies central files', async t => {
  const f = fixture(t); f.remote('future-worker', devices[0]); f.enroll('future-worker', devices[0]); f.save();
  const files = [f.options.registryFile, path.join(f.directory, 'members.json'), path.join(f.directory, 'fleet.json')];
  const before = files.map(file => fs.readFileSync(file)); let output = '';
  await main(['--stdin'], { input: Readable.from(['{"schema":1,"op":"list"}']), output: { write: text => { output += text; } }, catalog: f.catalog });
  assert.equal(JSON.parse(output).workers.length, 1); assert.ok(!output.includes('private-'));
  files.forEach((file, n) => assert.deepEqual(fs.readFileSync(file), before[n]));
  for (const request of [{ schema: 1, op: 'list', registryFile: '/elsewhere' }, { schema: 2, op: 'list' }, { schema: 1, op: 'use' }, []])
    await assert.rejects(main(['--stdin'], { input: Readable.from([JSON.stringify(request)]), catalog: () => assert.fail('no caller override') }));
  await assert.rejects(main(['--stdin'], { input: Readable.from(['x'.repeat(1025)]), catalog: () => assert.fail('oversized input') }));
  const cli = spawnSync(process.execPath, [new URL('./native-vault-worker-catalog.mjs', import.meta.url).pathname, '--config', 'private-marker'], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.equal(cli.stdout, ''); assert.equal(cli.stderr, 'Native worker catalog unavailable.\n');
  const release = JSON.parse(fs.readFileSync(new URL('../Config/runtime-release-files.json', import.meta.url), 'utf8'));
  assert.ok(release.files.includes('scripts/native-vault-worker-catalog.mjs'));
});
