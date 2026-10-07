#!/usr/bin/env node
// Read-only source adapter. The only write target is the configured Max Monitor relay.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
export const SOURCE_NAME = 'ClickUp · AI Newsletter Creation';
const STATUSES = new Set(['queued', 'running', 'blocked', 'completed', 'failed']);
const CLAIM_STATES = new Set(['claiming', 'running', 'final', 'released', 'withdrawn']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DEFAULT_WORKFLOWS = [
  { id: 'newsletter', triggerTags: ['pre gen.'], claimWorkflow: 'newsletter', stateTags: {
    queued: ['pre gen · wartet'], running: ['pre gen · läuft'],
    blocked: ['pre gen · blockiert'], completed: ['pre gen · fertig'],
  } },
  { id: 'upload', triggerTags: ['upload', 'klaviyo upload'], stateTags: {
    queued: ['upload · wartet'], running: ['upload · läuft'],
    blocked: ['upload · blockiert'], completed: ['upload · fertig'], failed: ['upload · fehlgeschlagen'],
  } },
];

export function normalizeTag(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]/gu, '');
}

export function displayText(value, max, fallback) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return text || fallback;
}

export function validateWorkflows(value) {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error('Workflow-Liste muss 1–30 Einträge enthalten.');
  const ids = new Set();
  for (const workflow of value) {
    if (!workflow || !/^[a-z][a-z0-9-]{0,39}$/.test(workflow.id) || ids.has(workflow.id)) throw new Error('Workflow-IDs müssen eindeutig und gültig sein.');
    ids.add(workflow.id);
    if (!Array.isArray(workflow.triggerTags) || !workflow.triggerTags.length) throw new Error(`Start-Tags fehlen: ${workflow.id}.`);
    for (const [status, tags] of Object.entries(workflow.stateTags ?? {})) {
      if (!STATUSES.has(status) || !Array.isArray(tags)) throw new Error(`Status-Tags ungültig: ${workflow.id}.`);
    }
    const tags = [...workflow.triggerTags, ...Object.values(workflow.stateTags ?? {}).flat()];
    if (tags.some(tag => typeof tag !== 'string' || !normalizeTag(tag) || tag.length > 200)) throw new Error(`Tag ungültig: ${workflow.id}.`);
  }
  return value;
}

export function workflowMatches(workflow, tags) {
  const configured = [...workflow.triggerTags, ...Object.values(workflow.stateTags ?? {}).flat()].map(normalizeTag);
  return tags.some(tag => configured.includes(normalizeTag(tag)));
}

async function requestJson(hubFetch, url, service) {
  const response = await hubFetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status}.`);
  const data = await response.json();
  if (!data || typeof data !== 'object') throw new Error(`${service}: ungültige Antwort.`);
  if (service === 'Slack' && data.ok !== true) throw new Error(`Slack: ${/^[a-z_]+$/.test(data.error) ? data.error : 'Abfrage fehlgeschlagen'}.`);
  return data;
}

export async function discoverTags(hubFetch, workspaceId, workflows) {
  const spaces = await requestJson(hubFetch, `https://api.clickup.com/api/v2/team/${encodeURIComponent(workspaceId)}/space?archived=false`, 'ClickUp');
  if (!Array.isArray(spaces.spaces)) throw new Error('ClickUp: Space-Liste fehlt.');
  // ClickUp filters tags by their exact spelling, even when our matching is normalized.
  const variants = new Set();
  for (const space of spaces.spaces) {
    const result = await requestJson(hubFetch, `https://api.clickup.com/api/v2/space/${encodeURIComponent(space.id)}/tag`, 'ClickUp');
    if (!Array.isArray(result.tags)) throw new Error('ClickUp: Tag-Liste fehlt.');
    for (const tag of result.tags) {
      if (typeof tag?.name === 'string' && workflows.some(workflow => workflowMatches(workflow, [tag.name]))) variants.add(tag.name);
    }
  }
  return [...variants];
}

export async function listTasks(hubFetch, workspaceId, variants, { maxPages = 200, pageSize = 100 } = {}) {
  const tasks = new Map();
  for (const tag of variants) {
    let complete = false;
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`https://api.clickup.com/api/v2/team/${encodeURIComponent(workspaceId)}/task`);
      for (const [key, value] of Object.entries({ page, 'tags[]': tag, subtasks: true, include_closed: false })) url.searchParams.set(key, String(value));
      const result = await requestJson(hubFetch, url, 'ClickUp');
      if (!Array.isArray(result.tasks)) throw new Error('ClickUp: Aufgabenliste fehlt.');
      for (const task of result.tasks) {
        if (!task || typeof task.id !== 'string' || !task.id || !Array.isArray(task.tags)) throw new Error('ClickUp: ungültige Aufgabe.');
        tasks.set(task.id, task);
      }
      if (result.last_page === true || result.tasks.length < pageSize) { complete = true; break; }
    }
    if (!complete) throw new Error('ClickUp: Aufgabenliste unvollständig; bisherige Queue bleibt erhalten.');
  }
  return [...tasks.values()];
}

export function parseClaim(message) {
  if (message?.metadata?.event_type !== 'ai_newsletter_claim') return null;
  const value = message.metadata.event_payload;
  if (!value?.task_id || !value.worker || !value.run_id || !CLAIM_STATES.has(value.state)) return null;
  const heartbeat = Number(value.heartbeat) || Number(message.ts);
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) return null;
  return { taskId: String(value.task_id), runId: String(value.run_id), workerId: String(value.worker),
    state: value.state, heartbeat, ts: String(message.ts), workflow: typeof value.workflow === 'string' ? value.workflow : 'newsletter' };
}

export async function listClaims(hubFetch, channelId, { now = Date.now(), maxPages = 100, lookbackDays = 60 } = {}) {
  const claims = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL('https://slack.com/api/conversations.history');
    for (const [key, value] of Object.entries({ channel: channelId, include_all_metadata: true, limit: 100,
      oldest: ((now - lookbackDays * 86400000) / 1000).toFixed(6), ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, String(value));
    const result = await requestJson(hubFetch, url, 'Slack');
    if (!Array.isArray(result.messages)) throw new Error('Slack: Nachrichtenliste fehlt.');
    for (const message of result.messages) { const claim = parseClaim(message); if (claim) claims.push(claim); }
    cursor = result.response_metadata?.next_cursor;
    if (!result.has_more) return claims;
    if (typeof cursor !== 'string' || !cursor) throw new Error('Slack: Cursor fehlt; Reservierungen unvollständig.');
  }
  throw new Error('Slack: Reservierungen unvollständig; bisherige Queue bleibt erhalten.');
}

function taskDate(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function buildQueue(tasks, claims, workflows, { now = Date.now(), staleMinutes = 30 } = {}) {
  const updatedAt = new Date(now).toISOString();
  const rows = [];
  for (const task of tasks) {
    const tags = task.tags.map(tag => typeof tag === 'string' ? tag : String(tag?.name ?? ''));
    for (const workflow of workflows) {
      if (!workflowMatches(workflow, tags)) continue;
      const normalized = new Set(tags.map(normalizeTag));
      let status = 'queued';
      for (const name of ['queued', 'running', 'failed', 'blocked', 'completed']) {
        if ((workflow.stateTags?.[name] ?? []).some(tag => normalized.has(normalizeTag(tag)))) status = name;
      }
      const matches = claims.filter(claim => claim.taskId === task.id && claim.workflow === (workflow.claimWorkflow ?? workflow.id));
      const active = matches.filter(claim => ['claiming', 'running'].includes(claim.state)).sort((a, b) => Number(a.ts) - Number(b.ts));
      const fresh = active.find(claim => now - claim.heartbeat * 1000 <= staleMinutes * 60000);
      const previous = ['completed', 'blocked', 'failed'].includes(status)
        ? matches.filter(item => item.state === 'final').sort((a, b) => Number(b.ts) - Number(a.ts))[0] : undefined;
      const claim = fresh ?? active[0] ?? previous;
      let phase;
      if (status !== 'completed' && status !== 'failed' && status !== 'blocked') {
        if (fresh) { status = fresh.state === 'running' ? 'running' : 'queued'; phase = fresh.state === 'running' ? 'In Bearbeitung' : 'Reserviert'; }
        else if (active.length) { status = 'blocked'; phase = 'Worker meldet sich nicht mehr'; }
        else if (status === 'running') { phase = 'Läuft laut ClickUp; Worker-Zuordnung fehlt'; }
      }
      if (status === 'blocked' && !phase) phase = 'Blockiert oder pausiert';
      let url = `https://app.clickup.com/t/${encodeURIComponent(task.id)}`;
      try {
        const candidate = new URL(task.url);
        if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && String(task.url).length <= 2000) url = candidate.href;
      } catch { /* Use the canonical ClickUp task link. */ }
      rows.push({ id: `clickup:${workflow.id}:${task.id}`, title: displayText(task.name, 300, task.id), url, workflow: workflow.id, status,
        sourceStatus: displayText(typeof task.status === 'string' ? task.status : task.status?.status, 120),
        workerId: claim?.workerId, phase: displayText(phase, 160), progress: status === 'completed' ? 100 : undefined,
        updatedAt: taskDate(task.date_updated, updatedAt), tags: [...new Set(tags.map(tag => displayText(tag, 80)).filter(Boolean))].slice(0, 30) });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseObservedWorkers(values) {
  if (!Array.isArray(values)) throw new Error('Hub: Worker-Liste ungültig.');
  const byId = new Map();
  for (const value of values) {
    if (!value || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.worker_id) || !Number.isFinite(Date.parse(value.seen_at))) continue;
    const worker = { workerId: value.worker_id, name: value.worker_id, lastSeenAt: new Date(value.seen_at).toISOString(),
      workerVersion: displayText(value.worker_version, 80), workerRevision: displayText(value.worker_revision, 80),
      pendingClickup: Number.isInteger(value.pending_clickup) && value.pending_clickup >= 0 && value.pending_clickup <= 100000 ? value.pending_clickup : undefined };
    if (!byId.has(worker.workerId) || Date.parse(worker.lastSeenAt) > Date.parse(byId.get(worker.workerId).lastSeenAt)) byId.set(worker.workerId, worker);
  }
  return [...byId.values()];
}

export async function readHubFleet(hub, { spawnImpl = spawn, fleetDirectory = path.join(hub.hub_dir, 'logs', 'ai-newsletter-fleet') } = {}) {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(hub.ssh_host) || !/^\/[A-Za-z0-9._/-]+$/.test(fleetDirectory)) throw new Error('Hub: SSH-Konfiguration ungültig.');
  const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const args = ['-i', expand(hub.identity_file), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile="${expand(hub.known_hosts_file)}"`,
    '-o', 'ConnectTimeout=15', '-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(os.homedir(), '.ssh', 'cm-ainl-%C')}`,
    '-o', 'ControlPersist=120', hub.ssh_host, 'node -'];
  // Fixed read-only program; no remote paths, credentials or file content are returned except telemetry allowlist.
  const program = `const fs=require('fs'),path=require('path');const dir=${JSON.stringify(fleetDirectory)};const rows=[];
    for(const name of fs.readdirSync(dir)){if(!/^[a-z0-9][a-z0-9._-]{0,79}\\.json$/i.test(name))continue;
      const file=path.join(dir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>16384)continue;
      try{const v=JSON.parse(fs.readFileSync(file,'utf8'));rows.push({worker_id:v.worker_id,seen_at:v.seen_at,worker_version:v.worker_version,worker_revision:v.worker_revision,pending_clickup:v.pending_clickup});}catch{}}
    process.stdout.write(JSON.stringify(rows));`;
  const output = await new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Hub: Worker-Abfrage hat das Zeitlimit erreicht.')); }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1048576) { child.kill('SIGKILL'); finish(new Error('Hub: Worker-Antwort zu groß.')); } });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('Hub: SSH nicht verfügbar.')));
    child.once('close', code => finish(code === 0 ? null : new Error('Hub: Worker-Dateien nicht lesbar.'), stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(program);
  });
  return parseObservedWorkers(JSON.parse(output));
}

export async function readLocalHubFleet(hub, { fleetDirectory = path.join(hub.hub_dir, 'logs', 'ai-newsletter-fleet') } = {}) {
  const names = await fs.readdir(fleetDirectory);
  if (names.length > 5000) throw new Error('Hub: zu viele Worker-Dateien.');
  const rows = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}\.json$/i.test(name)) continue;
    const file = path.join(fleetDirectory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 16384) continue;
    try { rows.push(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { /* A broken worker file must not hide the others. */ }
  }
  return parseObservedWorkers(rows);
}

export function createLocalHubFetch(hub, { localHub, transport, spawnImpl = spawn, nodeBinary = process.execPath } = {}) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(String(localHub))) throw new Error('Lokaler Hub-Pfad ist ungültig.');
  // The Newsletter transport creates exactly the same remoteScript and parses
  // its response. Only the process carrying that script changes from SSH to a
  // local Node process; service credentials stay inside the existing Hub code.
  const fetchOnHub = transport.createHubFetch({ ...hub, hub_dir: localHub }, {
    spawnImpl: (binary, _args, options) => {
      if (binary !== 'ssh') throw new Error('Hub: unerwarteter Transportprozess.');
      return spawnImpl(nodeBinary, ['-'], { ...options, cwd: localHub });
    },
  });
  return async (url, options = {}) => {
    if ((options.method || 'GET').toUpperCase() !== 'GET' || options.body !== undefined || options.workerHeartbeat !== undefined) {
      throw new Error('Monitoring erlaubt ausschließlich lesende Hub-Abfragen.');
    }
    const request = transport.checkRequest(String(url), 'GET');
    if (request.method !== 'GET' || !['clickup', 'slack'].includes(request.service)) throw new Error('Monitoring-Quelle ist nicht erlaubt.');
    return fetchOnHub(url, { ...options, method: 'GET' });
  };
}

export async function collectSnapshot({ config, hubFetch, workflows = DEFAULT_WORKFLOWS, fleetReader = readHubFleet, fleetDirectory, now = Date.now() }) {
  validateWorkflows(workflows);
  const variants = await discoverTags(hubFetch, config.clickup.workspace_id, workflows);
  const tasks = await listTasks(hubFetch, config.clickup.workspace_id, variants);
  const claims = await listClaims(hubFetch, config.slack.channel_id, { now });
  let observedWorkers; let fleetDetail;
  try { observedWorkers = await fleetReader(config.hub, fleetDirectory ? { fleetDirectory } : {}); }
  catch { fleetDetail = 'Hub-Worker-Dateien nicht verfügbar; Gerätewerte stammen weiter aus App-Berichten.'; }
  const queue = buildQueue(tasks, claims, workflows, { now, staleMinutes: Number(config.claims?.stale_minutes) || 30 });
  if (queue.length > 5000) throw new Error('Queue enthält mehr als 5000 Einträge; bisheriger Snapshot bleibt erhalten.');
  return { tasks: queue, ...(observedWorkers === undefined ? {} : { observedWorkers }), source: {
    name: SOURCE_NAME, lastSuccessAt: new Date(now).toISOString(),
    detail: `${queue.length} Aufgaben · ${variants.length} Tags · ${claims.length} Reservierungen${fleetDetail ? ` · ${fleetDetail}` : ''}`,
  } };
}

export function relayEndpoint(relayUrl, teamId) {
  const url = new URL(relayUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))) throw new Error('Relay-URL muss HTTPS verwenden (lokal HTTP erlaubt).');
  if (!/^[A-Z0-9]{4,16}$/.test(teamId)) throw new Error('Team-ID ungültig.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/teams/${teamId}/queue`;
  return url;
}

export async function publishSnapshot(snapshot, { relayUrl, teamId, token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('MONITOR_BRIDGE_TOKEN fehlt.');
  const response = await fetchImpl(relayEndpoint(relayUrl, teamId), { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Relay: HTTP ${response.status}; Snapshot wurde nicht bestätigt.`);
}

export async function syncOnce({ collect, publish, cachedSource, save }) {
  let snapshot;
  try { snapshot = await collect(); }
  catch (error) {
    // Source-only error leaves every previously accepted task intact in the relay.
    const message = error instanceof Error ? error.message : 'Quellenabfrage fehlgeschlagen.';
    snapshot = { source: { name: SOURCE_NAME, ...(cachedSource?.lastSuccessAt ? { lastSuccessAt: cachedSource.lastSuccessAt } : {}), error: displayText(message, 300, 'Quellenabfrage fehlgeschlagen.') } };
    await publish(snapshot);
    return { ok: false, snapshot };
  }
  await publish(snapshot);
  if (save) await save(snapshot);
  return { ok: true, snapshot };
}

export function argumentsFrom(argv, env) {
  const values = { workerRoot: env.NEWSLETTER_WORKER_ROOT, relayUrl: env.MONITOR_RELAY_URL, teamId: env.MONITOR_TEAM_ID,
    token: env.MONITOR_BRIDGE_TOKEN, workflowsFile: env.MONITOR_WORKFLOWS_FILE, fleetDirectory: env.MONITOR_HUB_FLEET_DIRECTORY,
    interval: Number(env.MONITOR_BRIDGE_INTERVAL_SECONDS || 60), localHub: env.MONITOR_LOCAL_HUB, enrollmentConfig: env.MONITOR_ENROLLMENT_CONFIG,
    cacheFile: env.MONITOR_BRIDGE_CACHE || path.join(os.homedir(), '.cache', 'max-monitor', 'newsletter-bridge.json') };
  const keys = { '--worker-root': 'workerRoot', '--relay-url': 'relayUrl', '--team-id': 'teamId', '--workflows': 'workflowsFile', '--fleet-directory': 'fleetDirectory', '--interval': 'interval', '--cache': 'cacheFile', '--local-hub': 'localHub', '--enrollment-config': 'enrollmentConfig' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') values.once = true;
    else if (arg === '--dry-run') { values.dryRun = true; values.once = true; }
    else if (arg === '--help') values.help = true;
    else if (keys[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) values[keys[arg]] = argv[++index];
    else throw new Error(`Unbekannter oder unvollständiger Parameter: ${arg}.`);
  }
  values.interval = Number(values.interval);
  if (!Number.isFinite(values.interval) || values.interval < 30 || values.interval > 86400) throw new Error('Intervall muss 30–86400 Sekunden sein.');
  if (values.enrollmentConfig) {
    if (!values.localHub) throw new Error('--enrollment-config ist nur für den zentralen --local-hub-Modus erlaubt.');
  }
  return values;
}

export async function applyEnrollmentConfiguration(options) {
  if (!options.enrollmentConfig) return options;
  // Optional dynamic import keeps the existing standalone Mac bridge installer
  // independent of the central Hub provisioning helper.
  const { loadConfiguration } = await import('./enroll-monitor-worker.mjs');
  const settings = loadConfiguration({ env: {}, configPath: options.enrollmentConfig });
  if ((options.relayUrl && options.relayUrl !== settings.serverURL) || (options.teamId && options.teamId !== settings.teamId)) throw new Error('Relay-Adresse oder Team-ID widerspricht der privaten Hub-Konfiguration.');
  return { ...options, relayUrl: settings.serverURL, teamId: settings.teamId, token: settings.ownerToken };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = await applyEnrollmentConfiguration(argumentsFrom(argv, env));
  if (options.help) {
    console.log('node scripts/newsletter-monitor-bridge.mjs --worker-root <repo> [--once|--dry-run] [--workflows <json>] [--interval 60]\nHub-Dienst: --local-hub /opt/rs-hub --enrollment-config /etc/max-monitor/enrollment.json\nRelay: MONITOR_RELAY_URL, MONITOR_TEAM_ID, MONITOR_BRIDGE_TOKEN (admin/super; nur Umgebung).');
    return;
  }
  if (!options.workerRoot) throw new Error('NEWSLETTER_WORKER_ROOT oder --worker-root fehlt.');
  if (!options.dryRun) { relayEndpoint(options.relayUrl, options.teamId); if (!options.token) throw new Error('MONITOR_BRIDGE_TOKEN fehlt.'); }
  const root = path.resolve(options.workerRoot);
  const { loadConfig } = require(path.join(root, 'src', 'config.js'));
  const transport = require(path.join(root, 'src', 'hub-transport.js'));
  const config = loadConfig(path.join(root, 'config', 'worker.local.json'), { root });
  const workflows = validateWorkflows(options.workflowsFile ? JSON.parse(await fs.readFile(options.workflowsFile, 'utf8')) : DEFAULT_WORKFLOWS);
  if (options.localHub) config.hub.hub_dir = options.localHub;
  const hubFetch = options.localHub ? createLocalHubFetch(config.hub, { localHub: options.localHub, transport }) : transport.createHubFetch(config.hub);
  let cached;
  try { cached = JSON.parse(await fs.readFile(options.cacheFile, 'utf8')); } catch { /* Fresh installation. */ }
  let stopped = false;
  const controller = new AbortController();
  const stop = () => { stopped = true; controller.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      try {
        const result = await syncOnce({ collect: () => collectSnapshot({ config, hubFetch, workflows, fleetDirectory: options.fleetDirectory,
          ...(options.localHub ? { fleetReader: readLocalHubFleet } : {}) }), cachedSource: cached?.source,
          publish: snapshot => options.dryRun ? console.log(JSON.stringify(snapshot, null, 2)) : publishSnapshot(snapshot, options),
          save: options.dryRun ? undefined : async snapshot => {
            await fs.mkdir(path.dirname(options.cacheFile), { recursive: true, mode: 0o700 });
            const temporary = `${options.cacheFile}.${process.pid}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
            await fs.rename(temporary, options.cacheFile); cached = snapshot;
          },
        });
        if (!options.dryRun) console.log(`${new Date().toISOString()} ${result.ok ? `Queue aktualisiert (${result.snapshot.tasks.length} Aufgaben).` : 'Quelle nicht erreichbar; letzte Queue bleibt erhalten.'}`);
        if (!result.ok && options.once) process.exitCode = 1;
      } catch (error) {
        // Never print an upstream response body or a token.
        console.error(`${new Date().toISOString()} ${String(error.message).replaceAll(options.token || '\0', '[REDACTED]').slice(0, 300)}`);
        if (options.once) process.exitCode = 1;
      }
      if (!options.once && !stopped) { try { await delay(options.interval * 1000, undefined, { signal: controller.signal }); } catch { /* Stop requested. */ } }
    } while (!options.once && !stopped);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(String(error.message).replaceAll(process.env.MONITOR_BRIDGE_TOKEN || '\0', '[REDACTED]').slice(0, 300)); process.exitCode = 1; });
}
