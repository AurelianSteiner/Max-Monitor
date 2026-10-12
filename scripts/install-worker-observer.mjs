// The observer source stays in the private newsletter repo. Bootstrap a pinned,
// verified copy only until the registered worker checkout includes the observer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const OBSERVER_SOURCE = Object.freeze({
  revision: 'f1c0ddcfbed0c68695a882b4e6703459d2e4e116',
  sha256: '00ce62bd066a12d5784b59e53fb014948a2e3c5a67712aeda2ddbbb9d863c257',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function ensureWorkerObserver(options, {
  runner, home = os.homedir(), node = process.execPath, platform = process.platform,
  loadConfig, loadAgent = file => require(file),
} = {}) {
  if (options.check || options.dryRun || platform !== 'darwin') return { installed: false };
  const root = options.workerRoot;
  const configured = options.workerConfig || process.env.MAX_MONITOR_WORKER_CONFIG || 'config/worker.local.json';
  const configFile = path.resolve(root, configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured);
  const config = (loadConfig || require(path.join(root, 'src/config.js')).loadConfig)(configFile, { root });
  if (config.clickup?.transport !== 'rs_hub' || config.testbetrieb?.nur_aufgaben?.length) return { installed: false };
  let entry = path.join(root, 'src/monitor-agent.js');
  try { await fs.access(entry); }
  catch {
    const runtime = path.join(home, '.local/share/mac-monitor-agent');
    entry = path.join(runtime, 'agent.cjs');
    let source;
    try { source = await fs.readFile(entry); } catch {}
    if (!source || digest(source) !== OBSERVER_SOURCE.sha256) {
      const encoded = await runner('gh', ['api',
        `repos/till10k/ai-newsletter-creation/contents/src/monitor-agent.js?ref=${OBSERVER_SOURCE.revision}`, '--jq', '.content'],
        { timeout: 45000, label: 'Worker-Beobachter laden' });
      source = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
      if (digest(source) !== OBSERVER_SOURCE.sha256) throw new Error('Worker-Beobachter: Prüfsumme stimmt nicht.');
      await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
      await fs.writeFile(entry + '.tmp', source, { mode: 0o600 });
      await fs.rename(entry + '.tmp', entry);
    }
  }
  process.env.MAC_MONITOR_WORKER_ROOT = root;
  const agent = loadAgent(entry);
  return agent.installAgent(config, { entry, configFile, home, node, platform });
}
