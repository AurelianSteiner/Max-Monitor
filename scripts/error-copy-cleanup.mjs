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

// Only a confirmed running continuation or a completed task supersedes an error copy.
// A pause, a queue acceptance, a marker or an open PM question keeps it
// (ablauf.md, Till 13.10.2026: pauses stay visible in #ai-fehler).
const OPEN_STATES = new Set(['queued', 'marked', 'paused', 'clarification']);

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

export function cleanupDecision(payload, snapshot, now = Date.now()) {
  const source = snapshot?.queue?.source;
  const age = now - Date.parse(source?.lastSuccessAt);
  if (!source || source.error || source.status !== 'fresh' || source.stale || !Number.isFinite(age)
    || age < -30000 || age > 90000 || !Array.isArray(snapshot.queue.tasks)) return { remove: false, reason: 'source-not-fresh' };
  const id = errorTaskKey(payload);
  const matches = snapshot.queue.tasks.filter(task => task.id === id);
  if (!id || matches.length !== 1) return { remove: false, reason: 'unknown-task' };
  const task = matches[0];
  if (!['running', 'completed'].includes(task.status)) return { remove: false, reason: keepReason(task.status), task };
  if (task.status === 'running' && !confirmedRunning(task)) return { remove: false, reason: 'running-not-confirmed', task };
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

export async function cleanupErrorCopies({ readFleet, hubFetch, slackWrite, errorChannel,
  archive = async () => {}, now = Date.now, max = 10 }) {
  const initial = await readFleet();
  // Never authenticate for deletion while the task inventory is incomplete.
  if (cleanupDecision({ task_id: '__probe__' }, initial, now()).reason === 'source-not-fresh')
    return { deleted: [], kept: [], skipped: 'source-not-fresh' };
  const errors = initial.queue.errors;
  if (!Array.isArray(errors)) throw new Error('Vollständiger Fehlerbestand fehlt.');
  const known = new Map(initial.queue.tasks.map(task => [task.id, task]));
  const kept = [];
  const candidates = errors.filter(error => error.id?.startsWith(`slack-error:${errorChannel}:`)
    && ['newsletter', 'correction', 'translation', 'upload'].includes(error.workflow));
  const review = candidates.filter(error => {
    const key = errorTaskKey({ task_id: String(error.attemptId || '').replace(/^\d{8}T\d{6}Z-/, '') });
    const task = known.get(key);
    // Open, blocked and unconfirmed running tasks keep their copy; skip them
    // before any Slack call on the shared token.
    if (task?.workflow === error.workflow && (OPEN_STATES.has(task.status) || ['blocked', 'failed'].includes(task.status))) {
      kept.push({ id: error.id, reason: keepReason(task.status) }); return false;
    }
    if (task?.workflow === error.workflow && task.status === 'running' && !confirmedRunning(task)) {
      kept.push({ id: error.id, reason: 'running-not-confirmed' }); return false;
    }
    return true;
  });
  if (!review.length) return { deleted: [], kept };
  const auth = await slackWrite('auth.test');
  if (!/^U[A-Z0-9]+$/.test(String(auth.user_id))) throw new Error('Slack-Bot nicht bestätigt.');
  const deleted = [];
  for (const error of review) {
    if (deleted.length >= max) break;
    const ts = error.id.slice(`slack-error:${errorChannel}:`.length);
    if (!/^\d+\.\d+$/.test(ts)) continue;
    const messages = [];
    let cursor;
    do {
      const url = new URL('https://slack.com/api/conversations.replies');
      for (const [key, value] of Object.entries({ channel: errorChannel, ts, limit: 200, include_all_metadata: true,
        ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, String(value));
      const response = await hubFetch(url.href, { method: 'GET' });
      // The Tuck token is shared with every Mac: a 429 ends this cycle quietly.
      // Nothing of this thread was deleted yet; the next cycle checks it again.
      if (rateLimited(response)) return { deleted, kept, skipped: 'ratelimited' };
      const result = await response.json();
      if (rateLimited(response, result)) return { deleted, kept, skipped: 'ratelimited' };
      if (['thread_not_found', 'message_not_found'].includes(result.error)) break;
      if (!response.ok || !result.ok || !Array.isArray(result.messages)) throw new Error('Fehlerthread nicht vollständig lesbar.');
      messages.push(...result.messages);
      cursor = result.response_metadata?.next_cursor;
      if ((result.has_more && !cursor) || messages.length > 2000) throw new Error('Fehlerthread unvollständig; nichts gelöscht.');
    } while (cursor);
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
    deleted.push(error.id);
  }
  return { deleted, kept };
}
