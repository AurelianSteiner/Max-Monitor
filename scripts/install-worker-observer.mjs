// The observer source stays in the private newsletter repo. Bootstrap a pinned,
// verified copy until the registered worker checkout includes a compatible observer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workerProfile } = require('../team-server/worker-kinds.js');
export const OBSERVER_SOURCE = Object.freeze({
  revision: '5c7cc3f611d35a5cf18398af67e414bc035f9ba3',
  sha256: 'e779ed1a2a1862f51b83ff7decfcce35675780f9637494b825ef0fb4fc550576',
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
  if (config.worker_kind === 'codex-repair' || workerProfile(config.worker_id).provider !== 'claude') return { installed: false };
  if (config.clickup?.transport !== 'rs_hub' || config.testbetrieb?.nur_aufgaben?.length) return { installed: false };
  let entry = path.join(root, 'src/monitor-agent.js');
  process.env.MAC_MONITOR_WORKER_ROOT = root;
  let agent;
  try {
    await fs.access(entry);
    const candidate = loadAgent(entry);
    if (typeof candidate.deviceIdOf === 'function' && typeof candidate.collectSkillRelease === 'function') agent = candidate;
  } catch {}
  if (!agent) {
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
  agent ||= loadAgent(entry);
  return agent.installAgent(config, { entry, configFile, home, node, platform });
}
