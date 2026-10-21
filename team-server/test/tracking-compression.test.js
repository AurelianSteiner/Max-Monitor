const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { gzipSync, gunzipSync } = require('node:zlib');

test('tracking accepts bounded gzip bodies and records observed transport, preserving legacy clients', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-compression-'));
  process.env.DATA_DIR = dir;
  process.env.TEAM_TOKEN = 'compression-test-owner';
  delete process.env.TEAM_TOKENS;
  const { server } = require('../server');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, data, token = 'compression-test-owner', encoding) => {
    const response = await fetch(base + route, { method: 'POST', headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      ...(encoding ? { 'Content-Encoding': encoding } : {})
    }, body: Buffer.isBuffer(data) ? data : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
    return { status: response.status, data: await response.json() };
  };
  const member = (await request('/v1/teams/TEST1234/members', { name: 'Worker', role: 'member' })).data.member;
  const beat = { deviceId: '610be10e-8a00-4e00-b000-000000000001', name: 'ÄÖÜ Geräteprüfung',
    workerId: 'worker-1', reportedAt: new Date().toISOString(), limits: [], accounts: [],
    trackingTransport: { encoding: 'spoofed', wireBytes: 1 } };
  const raw = Buffer.from(JSON.stringify(beat));
  const route = '/v1/teams/TEST1234/heartbeat';
  const plain = await request(route, raw, member.token);
  assert.equal(plain.status, 200);
  assert.equal(plain.data.machine.trackingTransport.encoding, 'identity');
  const packed = gzipSync(raw);
  const compressed = await request(route, packed, member.token, 'gzip');
  assert.equal(compressed.status, 200);
  assert.equal(compressed.data.machine.deviceName, beat.name);
  assert.equal(compressed.data.machine.trackingTransport.encoding, 'gzip');
  assert.equal(compressed.data.machine.trackingTransport.wireBytes, packed.length);
  assert.equal(compressed.data.machine.trackingTransport.decodedBytes, raw.length);
  assert.equal((await request(route, gzipSync(Buffer.alloc(65537)), member.token, 'gzip')).status, 413);
  assert.equal((await request(route, packed.subarray(0, -3), member.token, 'gzip')).status, 413);
  assert.equal((await request(route, packed, member.token, 'br')).status, 413);
  assert.equal((await request(route, packed, 'invalid', 'gzip')).status, 401);
  const report = gzipSync(Buffer.from(JSON.stringify({ teamId: 'TEST1234', person: 'ignored', limits: [{ label: '5h', percent: 12 }] })));
  assert.equal((await request('/v1/reports', report, member.token, 'gzip')).status, 200);
  await t.test('native Swift encoder interoperates with the real HTTP receiver', { skip: process.platform !== 'darwin' }, async () => {
    const source = path.resolve(__dirname, '../../Usage4Claude/Helpers/TrackingHTTPCompression.swift');
    const main = path.join(dir, 'main.swift'), executable = path.join(dir, 'gzip-native');
    fs.writeFileSync(main, `import Foundation\nlet raw = Data(base64Encoded: "${raw.toString('base64')}")!\nFileHandle.standardOutput.write(TrackingHTTPCompression.gzip(raw)!)\n`);
    execFileSync('xcrun', ['swiftc', source, main, '-o', executable], { stdio: 'pipe', timeout: 60000 });
    const nativeBody = execFileSync(executable);
    assert.deepEqual(gunzipSync(nativeBody), raw);
    const answer = await request(route, nativeBody, member.token, 'gzip');
    assert.equal(answer.status, 200);
    assert.equal(answer.data.machine.trackingTransport.wireBytes, nativeBody.length);
    assert.equal(answer.data.machine.trackingTransport.decodedBytes, raw.length);
  });
});
