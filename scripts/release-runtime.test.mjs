// Prinz 12451cu4101 (29.10.2026): the queue bridge's copied worker rules stayed at
// 17.10. A runtime release now carries them from one clean, published worker main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { newsletterSourcePayload } from './release-runtime.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function publishedWorker(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-newsletter-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin.git'), worker = path.join(directory, 'worker');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', worker]);
  const files = {
    'src/config.js': "module.exports = require('./netz');", 'src/netz.js': 'module.exports = {};',
    'src/hub-transport.js': '', 'src/pre-gen.js': '',
    'src/upload-policy.js': "const rules = require('../config/manual-uploads.json'); module.exports = { rules };",
    'config/manual-uploads.json': '{"customers": []}',
    'src/slack-kanaele.js': "module.exports = { KANAELE: { upload_nl: { id: 'C0C8HH8HYNQ' } }, FEHLER_KANAL: { id: 'C0C8HK2NDFE' } };",
    'src/unrelated.js': 'not loaded by the bridge',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(worker, relative)), { recursive: true });
    fs.writeFileSync(path.join(worker, relative), content);
  }
  fs.writeFileSync(path.join(worker, '.gitignore'), 'config/worker.local.json\n');
  fs.writeFileSync(path.join(worker, 'config/worker.local.json'), '{"private":"MAC_SECRET_NEVER_COPY"}');
  git(worker, 'add', '.');
  git(worker, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'worker');
  git(worker, 'remote', 'add', 'origin', origin);
  git(worker, 'push', '-q', 'origin', 'main');
  return worker;
}

test('a release carries the require closure of the published worker rules and no credentials', t => {
  const worker = publishedWorker(t);
  const payload = newsletterSourcePayload(worker);
  assert.equal(payload.revision, git(worker, 'rev-parse', 'HEAD'));
  assert.deepEqual(Object.keys(payload.files).sort(), ['newsletter-source/config/manual-uploads.json',
    'newsletter-source/config/monitor-channels.json', 'newsletter-source/src/config.js', 'newsletter-source/src/hub-transport.js',
    'newsletter-source/src/netz.js', 'newsletter-source/src/pre-gen.js', 'newsletter-source/src/slack-kanaele.js',
    'newsletter-source/src/upload-policy.js']);
  const channels = JSON.parse(Buffer.from(payload.files['newsletter-source/config/monitor-channels.json'].base64, 'base64'));
  assert.deepEqual(channels, { claims: ['C0C8HH8HYNQ'], errors: 'C0C8HK2NDFE' });
  for (const value of Object.values(payload.files))
    assert.ok(!Buffer.from(value.base64, 'base64').toString('utf8').includes('MAC_SECRET_NEVER_COPY'));
});

test('an unpublished or dirty worker checkout cannot renew the rules', t => {
  const worker = publishedWorker(t);
  fs.writeFileSync(path.join(worker, 'config/manual-uploads.json'), '{"customers": [{"folderId": "1"}]}');
  assert.throws(() => newsletterSourcePayload(worker), /clean worker checkout/);
  git(worker, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-am', 'local only');
  assert.throws(() => newsletterSourcePayload(worker), /published worker main/);
});

test('a required file outside the published worker commit stops the release', t => {
  const worker = publishedWorker(t);
  fs.writeFileSync(path.join(worker, 'src/upload-policy.js'), "module.exports = require('../config/worker.local.json');");
  git(worker, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-am', 'reads the Mac config');
  git(worker, 'push', '-q', 'origin', 'main');
  assert.throws(() => newsletterSourcePayload(worker), /config\/worker\.local\.json is not part of the published worker main/);
});
