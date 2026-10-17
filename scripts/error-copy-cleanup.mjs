// Authorized maintenance of #ai-fehler only. Source and PM threads stay intact.
import { spawn } from 'node:child_process';

export function errorTaskKey(payload) {
  const job = String(payload?.task_id || '');
  if (/^(?:korrektur-)?cu-[A-Za-z0-9_-]+@\d+-(?:intern|extern)(?:-file-[a-f0-9]{31,32})?$/.test(job)) return `correction:${job}`;
  const translation = /^([A-Za-z0-9_-]+?)(?:@\d+)?-uebersetzung-(en|it|fr|se|sp)$/.exec(job);
  if (translation) return `clickup:translation-${translation[2]}:${translation[1]}`;
  const upload = /^([A-Za-z0-9_-]+?)(?:@\d+)?-klaviyo$/.exec(job);
  if (upload) return `clickup:upload:${upload[1]}`;
  const newsletter = /^([A-Za-z0-9_-]+?)(?:@\d+)?$/.exec(job);
  return newsletter ? `clickup:newsletter:${newsletter[1]}` : null;
}

// A pause, a queue acceptance, a marker or an open PM question never supersedes
// a copy (ablauf.md, Till 13.10.2026). A copy from before 17.10.2026 goes with a
// confirmed running continuation or the completion; a copy of the 17.10. policy
// only with the completion (policyCopy).
const OPEN_STATES = new Set(['queued', 'marked', 'paused', 'clarification']);
// A cause post lists at most this many orders of one customer and cause.
const MAX_CAUSE_TASKS = 50;

function keepReason(status) {
  return OPEN_STATES.has(status) ? 'still-open' : 'still-blocked';
}

// A running row supersedes a copy only when a reservation or a live Mac report
// backs it: it names the Mac and the attempt. A bare ClickUp '· läuft' tag (row
// phase 'Worker-Zuordnung fehlt') confirms no run (AGENTS.md, Till 13.10.2026:
// only a freshly confirmed running continuation).
function confirmedRunning(task) {
  return task.status === 'running' && Boolean(task.workerId) && Boolean(task.attemptId || task.runId);
}

// #ai-fehler nur bei menschlichem Handlungsbedarf (Till, 17.10.2026, Fehleraudit):
// the worker names why a person has to act (grund), marks an exhausted repair
// chain (eskaliert) and lists every order of a cause post (task_ids). Such a copy
// stays across automatic continuations, and the worker updates it in place; it
// goes only with the confirmed completion of every order it names. Removing it
// at a running continuation would bring back posting and deleting per attempt.
export function policyCopy(payload) {
  return typeof payload?.grund === 'string' || payload?.eskaliert === true || Array.isArray(payload?.task_ids);
}

// Monitor task IDs of every order a copy stands for: its own job and, for a cause
// post, each listed job (deduplicated). null keeps the copy: a job without a task
// key or an oversized list is never resolved to some other task.
export function copyTaskKeys(payload) {
  const listed = Array.isArray(payload?.task_ids) ? payload.task_ids : [];
  if (listed.length > MAX_CAUSE_TASKS) return null;
  const jobs = [...new Set([payload?.task_id, ...listed].filter(job => job !== undefined && job !== null && job !== ''))];
  const keys = jobs.map(job => errorTaskKey({ task_id: job }));
  return keys.length && keys.every(Boolean) ? [...new Set(keys)] : null;
}

export function cleanupDecision(payload, snapshot, now = Date.now()) {
  const source = snapshot?.queue?.source;
  const age = now - Date.parse(source?.lastSuccessAt);
  if (!source || source.error || source.status !== 'fresh' || source.stale || !Number.isFinite(age)
    || age < -30000 || age > 90000 || !Array.isArray(snapshot.queue.tasks)) return { remove: false, reason: 'source-not-fresh' };
  const keys = copyTaskKeys(payload);
  if (!keys) return { remove: false, reason: 'unknown-task' };
  const found = [];
  for (const key of keys) {
    const matches = snapshot.queue.tasks.filter(task => task.id === key);
    if (matches.length !== 1) return { remove: false, reason: 'unknown-task' };
    found.push(matches[0]);
  }
  const task = found[0];
  if (found.every(entry => entry.status === 'completed')) return { remove: true, reason: 'no-longer-blocked', task };
  if (policyCopy(payload)) {
    if (found.length > 1) return { remove: false, reason: 'cause-open', task };
    if (task.status === 'running') return { remove: false, reason: payload.eskaliert === true ? 'escalated-until-completed' : 'until-completed', task };
    return { remove: false, reason: keepReason(task.status), task };
  }
  if (task.status !== 'running') return { remove: false, reason: keepReason(task.status), task };
  if (!confirmedRunning(task)) return { remove: false, reason: 'running-not-confirmed', task };
  return { remove: true, reason: 'no-longer-blocked', task };
}

function rateLimited(response, result) {
  return response?.status === 429 || result?.error === 'ratelimited';
}

// This writer cannot post, update messages, touch another channel or mutate ClickUp.
// Credentials remain inside the already configured RS Hub transport process.
export function createErrorCleanupWriter(hub, { localHub, transport, errorChannel,
  spawnImpl = spawn, nodeBinary = process.execPath } = {}) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(String(localHub)) || !/^C[A-Z0-9]{8,}$/.test(String(errorChannel)))
    throw new Error('Ungültige zentrale Fehlerkanal-Konfiguration.');
  const fetchOnHub = transport.createHubFetch({ ...hub, hub_dir: localHub }, {
    spawnImpl: (binary, _args, options) => {
      if (binary !== 'ssh') throw new Error('Unerwarteter Hub-Transport.');
      return spawnImpl(nodeBinary, ['-'], { ...options, cwd: localHub });
    },
  });
  return async (method, body = {}) => {
    if (method === 'auth.test') {
      if (Object.keys(body).length) throw new Error('Auth-Test nimmt keine Daten an.');
    } else if (method === 'chat.delete') {
      if (body.channel !== errorChannel || !/^\d+\.\d+$/.test(String(body.ts))
        || Object.keys(body).some(key => !['channel', 'ts'].includes(key))) throw new Error('Löschen außerhalb des Fehlerkanals ist gesperrt.');
    } else throw new Error('Fehlerbereinigung erlaubt nur auth.test und chat.delete.');
    const response = await fetchOnHub(`https://slack.com/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if ((!response.ok || !result.ok) && !(method === 'chat.delete' && result.error === 'message_not_found'))
      throw new Error(`Slack ${method}: ${/^[a-z_]+$/.test(result.error) ? result.error : 'Abfrage fehlgeschlagen'}`);
    return result;
  };
}

// Slack ts of an inventory row: slack-error:<channel>:<ts>, a cause post listing
// several orders adds #<job> for each further order (one row per order).
export function errorRowThread(id, errorChannel) {
  const match = /^slack-error:([A-Za-z0-9_-]+):(\d+\.\d+)(?:#[A-Za-z0-9_@-]{1,120})?$/.exec(String(id || ''));
  return match && match[1] === errorChannel ? match[2] : null;
}

// readThread → { messages } | { skipped: 'ratelimited' } | { unreadable: true }
async function readThread(hubFetch, errorChannel, ts) {
  const messages = [];
  let cursor;
  do {
    const url = new URL('https://slack.com/api/conversations.replies');
    for (const [key, value] of Object.entries({ channel: errorChannel, ts, limit: 200, include_all_metadata: true,
      ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, String(value));
    const response = await hubFetch(url.href, { method: 'GET' });
    // The Tuck token is shared with every Mac: a 429 ends this cycle quietly.
    // Nothing of this thread was deleted yet; the next cycle checks it again.
    if (rateLimited(response)) return { skipped: 'ratelimited' };
    const result = await response.json();
    if (rateLimited(response, result)) return { skipped: 'ratelimited' };
    if (['thread_not_found', 'message_not_found'].includes(result.error)) break;
    // One unreadable or incomplete thread keeps its copy; the next cycle reads it again.
    if (!response.ok || !result.ok || !Array.isArray(result.messages)) return { unreadable: true };
    messages.push(...result.messages);
    cursor = result.response_metadata?.next_cursor;
    if ((result.has_more && !cursor) || messages.length > 2000) return { unreadable: true };
  } while (cursor);
  return { messages };
}

// payloadOf(ts): the copy's metadata from this cycle's complete read of the error
// channel (conversations.history). It decides which copies stay before any thread
// read on the shared token; the thread parent decides again before any deletion.
export async function cleanupErrorCopies({ readFleet, hubFetch, slackWrite, errorChannel,
  archive = async () => {}, now = Date.now, max = 10, payloadOf = () => null }) {
  const initial = await readFleet();
  // Never authenticate for deletion while the task inventory is incomplete.
  if (cleanupDecision({ task_id: '__probe__' }, initial, now()).reason === 'source-not-fresh')
    return { deleted: [], kept: [], skipped: 'source-not-fresh' };
  const errors = initial.queue.errors;
  if (!Array.isArray(errors)) throw new Error('Vollständiger Fehlerbestand fehlt.');
  const known = new Map(initial.queue.tasks.map(task => [task.id, task]));
  const kept = [];
  // One entry per Slack post; a cause post may stand for several rows.
  const threads = new Map();
  for (const error of errors) {
    const ts = errorRowThread(error.id, errorChannel);
    if (!ts || !['newsletter', 'correction', 'translation', 'upload'].includes(error.workflow)) continue;
    if (!threads.has(ts)) threads.set(ts, []);
    threads.get(ts).push(error);
  }
  const review = [];
  for (const [ts, rows] of threads) {
    const id = `slack-error:${errorChannel}:${ts}`;
    const error = rows.find(row => row.id === id) || rows[0];
    let hint = null;
    try { hint = payloadOf(ts); } catch { hint = null; }
    if (hint?.kind === 'lauf') {
      // Skip copies that stay anyway before any Slack call on the shared token.
      const decision = cleanupDecision(hint, initial, now());
      if (!decision.remove) { kept.push({ id: error.id, reason: decision.reason }); continue; }
    } else {
      const key = errorTaskKey({ task_id: String(error.attemptId || '').replace(/^\d{8}T\d{6}Z-/, '') });
      const task = known.get(key);
      // Open, blocked and unconfirmed running tasks keep their copy.
      if (task?.workflow === error.workflow && (OPEN_STATES.has(task.status) || ['blocked', 'failed'].includes(task.status))) {
        kept.push({ id: error.id, reason: keepReason(task.status) }); continue;
      }
      if (task?.workflow === error.workflow && task.status === 'running' && !confirmedRunning(task)) {
        kept.push({ id: error.id, reason: 'running-not-confirmed' }); continue;
      }
    }
    review.push({ ts, error, rows });
  }
  if (!review.length) return { deleted: [], kept };
  const auth = await slackWrite('auth.test');
  if (!/^U[A-Z0-9]+$/.test(String(auth.user_id))) throw new Error('Slack-Bot nicht bestätigt.');
  const deleted = [];
  let removed = 0;
  for (const { ts, error, rows } of review) {
    if (removed >= max) break;
    const read = await readThread(hubFetch, errorChannel, ts);
    if (read.skipped) return { deleted, kept, skipped: read.skipped };
    if (read.unreadable) { kept.push({ id: error.id, reason: 'thread-unreadable' }); continue; }
    const { messages } = read;
    const parent = messages.find(message => message.ts === ts);
    const payload = parent?.metadata?.event_type === 'ai_newsletter_fehler' ? parent.metadata.event_payload : null;
    if (!parent || !parent.bot_id || parent.user !== auth.user_id || (auth.bot_id && auth.bot_id !== parent.bot_id)
      || payload?.kind !== 'lauf' || payload.run_id !== error.attemptId) {
      kept.push({ id: error.id, reason: 'identity-not-confirmed' }); continue;
    }
    if (messages.some(message => message.user !== auth.user_id || !message.bot_id)) {
      kept.push({ id: error.id, reason: 'human-or-other-author' }); continue;
    }
    let decision = cleanupDecision(payload, await readFleet(), now());
    if (!decision.remove) { kept.push({ id: error.id, reason: decision.reason }); continue; }
    await archive({ checkedAt: new Date(now()).toISOString(), error, task: decision.task, messages });
    // Delete bot replies first. Recheck the authoritative state before the parent.
    for (const message of messages.filter(message => message.ts !== ts)) {
      decision = cleanupDecision(payload, await readFleet(), now());
      if (!decision.remove) break;
      await slackWrite('chat.delete', { channel: errorChannel, ts: message.ts });
    }
    decision = cleanupDecision(payload, await readFleet(), now());
    if (!decision.remove) { kept.push({ id: error.id, reason: decision.reason }); continue; }
    await slackWrite('chat.delete', { channel: errorChannel, ts });
    deleted.push(...rows.map(row => row.id));
    removed += 1;
  }
  return { deleted, kept };
}
