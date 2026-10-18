#!/usr/bin/env node
// Reuses the existing Hub SSH configuration; never opens a new Worker access path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readWorker, run } from './setup-mac-monitor.mjs';
import { hubArgs } from './worker-remote.mjs';

export function releasePayload(root, baseline) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw Error('Runtime release requires a clean checkout.');
  const revision = git('rev-parse', 'HEAD');
  if (git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0] !== revision) throw Error('Publish and verify this exact main revision first.');
  const manifest = JSON.parse(git('show', revision + ':Config/runtime-release-files.json'));
  const files = Object.fromEntries(manifest.files.map(rel => {
    const data = execFileSync('git', ['-C', root, 'show', revision + ':' + rel]);
    return [rel, { base64: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') }];
  }));
  const hashes = Object.fromEntries(Object.entries(baseline.files).map(([rel, value]) => [rel, value.sha256]));
  return { revision, manifest, files, baseline: hashes };
}

export async function main(argv = process.argv.slice(2)) {
  const values = {}, switches = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--install') switches.add(argv[i]);
    else if (['--baseline', '--output', '--worker-root'].includes(argv[i]) && argv[i + 1]) values[argv[i]] = argv[++i];
    else throw Error('Use --baseline <read-only-source-inventory.json> --output <receipt.json> [--install] [--worker-root <existing-production-root>].');
  }
  if (!values['--baseline'] || !values['--output']) throw Error('Baseline and evidence output are required.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const payload = releasePayload(root, JSON.parse(fs.readFileSync(values['--baseline'], 'utf8')));
  const source = execFileSync('git', ['-C', root, 'show', payload.revision + ':scripts/install-runtime-release.py'], { encoding: 'utf8' });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const worker = await readWorker({ workerRoot: values['--worker-root'] || path.join(os.homedir(), '.local/share/ai-newsletter-production'), updateOnly: true });
  const command = 'python3 -c ' + quote(source) + (switches.has('--install') ? '' : ' --dry-run');
  const output = await run('/usr/bin/ssh', [...hubArgs(worker), worker.hubHost, command],
    { input: JSON.stringify(payload), timeout: 120000, outputLimit: 1024 * 1024 });
  const receipt = JSON.parse(output);
  fs.writeFileSync(values['--output'], JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: receipt.ok, dryRun: receipt.dryRun || false,
    sourceRevision: receipt.sourceRevision, fileCount: Object.keys(payload.files).length,
    newsletterWorkersRestarted: false, output: values['--output'] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
