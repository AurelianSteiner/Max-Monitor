// Prefer an identity-only probe of this Mac's existing Figma connection.
// Fall back to successful whoami results from its own worker attempts.
// Provider credentials stay in the native probe; no model calls or job changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const LABEL = 'de.rs.max-monitor.figma-account';

export function identityFromStream(stream) {
  const calls = new Set();
  let email;
  const visit = value => {
    if (typeof value === 'string') { try { visit(JSON.parse(value)); } catch {} return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.email === 'string' && value.email.length <= 254 && EMAIL.test(value.email.trim())) email = value.email.trim();
    // MCP results wrap the JSON in text content blocks.
    if (Array.isArray(value)) value.forEach(visit);
    else if (value.type === 'text') visit(value.text);
    else if (value.structuredContent) visit(value.structuredContent);
    else if (value.whoami) visit(value.whoami);
    else if (value.content) visit(value.content);
    else if (value.result) visit(value.result);
  };
  for (const line of stream.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const block of event.message?.content || []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && /(?:^|__)figma(?:__|.*__)whoami$/.test(block.name || '')) calls.add(block.id);
      if (event.type === 'user' && block.type === 'tool_result' && !block.is_error && calls.has(block.tool_use_id)) visit(block.content);
    }
  }
  return email;
}

export function collectFigmaAccount(config, { now = Date.now(), database = file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true }) } = {}) {
  let db;
  try {
    db = database(config.paths.state_db);
    const runs = db.prepare('SELECT run_dir, started_at, stream_offset FROM runs WHERE started_at IS NOT NULL ORDER BY started_at DESC LIMIT 80').all();
    const root = fs.realpathSync(config.paths.runs_dir);
    for (const run of runs) {
      const observed = Date.parse(run.started_at);
      if (!Number.isFinite(observed) || observed > now + 30000) continue;
      try {
        const directory = fs.realpathSync(run.run_dir);
        // Imported artifacts have their own database rows, sometimes offset 0.
        // Only direct local run directories can prove this Mac's identity.
        if (path.dirname(directory) !== root) continue;
        const file = path.join(directory, 'stream.jsonl');
        const stat = fs.lstatSync(file);
        const offset = Number(run.stream_offset || 0);
        if (!stat.isFile() || !Number.isSafeInteger(offset) || offset < 0 || offset >= stat.size) continue;
        // The worker records the append offset when starting its local process.
        // Imported continuation history before that offset belongs to another Mac.
        const bytes = Math.min(stat.size - offset, MAX_STREAM_BYTES);
        const buffer = Buffer.alloc(bytes);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buffer, 0, bytes, offset); } finally { fs.closeSync(fd); }
        const email = identityFromStream(buffer.toString('utf8'));
        if (email) return { email, observedAt: new Date(observed).toISOString(), source: 'worker-whoami' };
      } catch { /* Missing or unfinished attempts are not account evidence. */ }
    }
  } catch { /* Missing evidence stays unknown. */ }
  finally { db?.close(); }
  return undefined;
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function connectedFigmaAccount({ home = os.homedir(), now = Date.now(), exec = execFileSync } = {}) {
  const probe = path.join(home, '.local/share/max-monitor-figma/FigmaAccountProbe');
  if (!fs.existsSync(probe)) return undefined;
  try {
    const value = JSON.parse(exec(probe, [], { timeout: 27000, encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }));
    if (value.source !== 'mcp-whoami' || typeof value.email !== 'string' || value.email.length > 254 || !EMAIL.test(value.email)
      || !Number.isFinite(Date.parse(value.observedAt)) || Math.abs(now - Date.parse(value.observedAt)) > 60000) return undefined;
    return { email: value.email, observedAt: new Date(value.observedAt).toISOString(), source: 'mcp-whoami' };
  } catch { return undefined; }
}

export function installFigmaAccountObserver({ home = os.homedir(), node = process.execPath, exec = execFileSync } = {}) {
  const directory = path.join(home, '.local/share/max-monitor-figma');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'observer.mjs');
  if (fileURLToPath(import.meta.url) !== target) fs.copyFileSync(fileURLToPath(import.meta.url), target);
  fs.chmodSync(target, 0o600);
  // Build only when command-line tools already exist; never show an install dialog.
  const probeSource = fileURLToPath(new URL('./macos/FigmaAccountProbe.m', import.meta.url));
  if (fs.existsSync(probeSource)) {
    const digest = createHash('sha256').update(fs.readFileSync(probeSource)).digest('hex');
    const stamp = path.join(directory, 'probe-source-sha256');
    const probe = path.join(directory, 'FigmaAccountProbe');
    if (!fs.existsSync(probe) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== digest) {
      try {
        exec('/usr/bin/xcode-select', ['-p'], { stdio: 'pipe', timeout: 5000 });
        exec('/usr/bin/clang', ['-fobjc-arc', '-Wno-deprecated-declarations', '-Wno-incompatible-pointer-types',
          '-framework', 'Foundation', '-framework', 'Security', probeSource, '-o', probe + '.new'], { stdio: 'pipe', timeout: 30000 });
        exec('/usr/bin/codesign', ['--force', '--sign', '-', probe + '.new'], { stdio: 'pipe', timeout: 5000 });
        fs.chmodSync(probe + '.new', 0o700); fs.renameSync(probe + '.new', probe);
        fs.writeFileSync(stamp, digest, { mode: 0o600 });
      } catch { /* Historical evidence remains available without a helper. */ }
    }
  }
  const file = path.join(home, 'Library/LaunchAgents', LABEL + '.plist');
  const document = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(target)}</string></array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(path.join(directory, 'error.log'))}</string></dict></plist>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== document;
  if (changed) {
    fs.writeFileSync(file, document, { mode: 0o600 });
    try { exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'pipe', timeout: 5000 }); } catch {}
  }
  try { exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'pipe', timeout: 5000 }); }
  catch { exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'pipe', timeout: 5000 }); }
  return { installed: true };
}

export async function main({ home = os.homedir() } = {}) {
  const profile = JSON.parse(fs.readFileSync(path.join(home, '.local/share/mac-monitor-agent/profile.json'), 'utf8'));
  process.env.MAC_MONITOR_WORKER_ROOT = profile.root;
  const { loadConfig } = require(path.join(profile.root, 'src/config.js'));
  const config = loadConfig(profile.configFile, { root: profile.root });
  const figmaAccount = connectedFigmaAccount({ home }) || collectFigmaAccount(config);
  if (!figmaAccount) return { reported: false };
  // Reuse the installed observer's complete report and authenticated transport.
  const canonical = path.join(profile.root, 'src/monitor-agent.js');
  const fallback = path.join(home, '.local/share/mac-monitor-agent/agent.cjs');
  const entry = [canonical, fallback].find(file => fs.existsSync(file)
    && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === profile.entryHash);
  if (!entry) throw new Error('Installierter Beobachter stimmt nicht mit dem Profil überein');
  const agent = require(entry);
  await agent.sendReport(config, { ...agent.collectReport(config), figmaAccount });
  return { reported: true, email: figmaAccount.email };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => { process.stderr.write('Figma-Account konnte nicht gemeldet werden.\n'); process.exitCode = 1; });
