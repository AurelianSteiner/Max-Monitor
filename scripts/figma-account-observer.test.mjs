import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityFromStream, collectFigmaAccount, connectedFigmaAccount } from './figma-account-observer.mjs';

const events = (email, { error = false, tool = 'mcp__figma__whoami', id = 'who' } = {}) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: tool, id }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error,
    content: [{ type: 'text', text: JSON.stringify({ whoami: { email, handle: 'Worker' } }) }] }] } },
].map(JSON.stringify).join('\n') + '\n';

test('only a successful correlated Figma whoami supplies an email', () => {
  assert.equal(identityFromStream(events('worker@example.com')), 'worker@example.com');
  assert.equal(identityFromStream(events('error@example.com', { error: true })), undefined);
  assert.equal(identityFromStream(events('other@example.com', { tool: 'mcp__slack__whoami' })), undefined);
  assert.equal(identityFromStream(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'worker@example.com' }] } })), undefined);
  assert.equal(identityFromStream(events('not an email')), undefined);
});

test('a direct Figma account requires no worker history and rejects stale or failed native results', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'connected-figma-'));
  const probe = path.join(home, '.local/share/max-monitor-figma/FigmaAccountProbe');
  fs.mkdirSync(path.dirname(probe), { recursive: true }); fs.writeFileSync(probe, 'fixture');
  const now = Date.now(); const observedAt = new Date(now).toISOString();
  try {
    assert.deepEqual(connectedFigmaAccount({ home, now, exec: (_file, _args, options) => {
      assert.equal(options.timeout, 27000);
      return JSON.stringify({ email: 'till2@example.com', observedAt, source: 'mcp-whoami', accessToken: 'must-not-escape' });
    } }), { email: 'till2@example.com', observedAt, source: 'mcp-whoami' });
    for (const value of [{ available: false }, { email: 'x@example.com', observedAt: new Date(now - 120000).toISOString(), source: 'mcp-whoami' }])
      assert.equal(connectedFigmaAccount({ home, now, exec: () => JSON.stringify(value) }), undefined);
    assert.equal(connectedFigmaAccount({ home, now, exec: () => { throw Error('Keychain not accessible'); } }), undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('continuation offsets exclude accounts from imported history and evidence keeps its own date', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-observer-'));
  const dbFile = path.join(root, 'state.sqlite');
  const runs = path.join(root, 'runs'); fs.mkdirSync(runs);
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE runs (run_dir TEXT, started_at TEXT, stream_offset INTEGER)');
  const dir = path.join(runs, 'local'); fs.mkdirSync(dir);
  const imported = events('another-mac@example.com');
  fs.writeFileSync(path.join(dir, 'stream.jsonl'), imported + events('this-mac@example.com'));
  const at = '2026-10-20T10:00:00.000Z';
  db.prepare('INSERT INTO runs VALUES (?,?,?)').run(dir, at, Buffer.byteLength(imported));
  const foreignDir = path.join(runs, 'imported', 'other', 'run'); fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, 'stream.jsonl'), events('foreign@example.com'));
  db.prepare('INSERT INTO runs VALUES (?,?,?)').run(foreignDir, '2026-10-20T10:00:10Z', 0); db.close();
  const config = { paths: { state_db: dbFile, runs_dir: runs } };
  try {
    assert.deepEqual(collectFigmaAccount(config, { now: Date.parse(at) + 60000 }),
      { email: 'this-mac@example.com', observedAt: at, source: 'worker-whoami' });
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), imported + '{"type":"system"}\n');
    assert.equal(collectFigmaAccount(config, { now: Date.parse(at) + 60000 }), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
