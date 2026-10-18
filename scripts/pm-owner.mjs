import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Display the recipients of the task's actual Slack question, including both PMs.
// These channel identities were verified in Slack. ClickUp assignments are not used.
export const SLACK_PM_CHANNELS = Object.freeze({
  C0C994GPYKS: 'Ben & Abdou',
  C0C88G211UK: 'Hannes & Luca',
  C0C89DYUDDK: 'John',
  C0C8CPRNX8E: 'Aurelian',
});

export function isPmQuestion(row) {
  return row.status === 'clarification'
    || row.status === 'queued' && row.phase === 'Wartet · PM-Rückfrage'
    || row.status === 'blocked' && (row.phase === 'PM-Rückfrage offen'
      || /(?:^|\W)PM(?:$|\W)/.test(row.responsibleRole || ''));
}

// Reuse the exact customer resolver and channel table used by the PM question
// service. No independent ClickUp PM interpretation or inferred Slack members.
export function createPmRoutingReader(localHub, { load = require, clock = Date.now } = {}) {
  try {
    const root = path.join(localHub, '..', 'rs-pm-question-pilot', 'src');
    const { CHANNELS } = load(path.join(root, 'pm-questions.js'));
    const { resolveCustomer } = load(path.join(root, 'pm-question-hub.js'));
    const channels = Object.fromEntries(Object.entries(CHANNELS).map(([team, channel]) => [channel.id, team]));
    const cache = new Map();
    return { channels, async resolve(taskId) {
      const now = clock(), old = cache.get(taskId);
      if (old && now >= old.at && now - old.at < 300000) return old.route;
      cache.delete(taskId);
      const customer = await resolveCustomer(localHub, taskId);
      const channelId = CHANNELS[customer.team]?.id;
      if (!channelId || customer.taskId !== taskId) return null;
      const route = { team: customer.team, channelId };
      cache.set(taskId, { at: now, route });
      for (const [id, entry] of cache) if (now - entry.at >= 300000) cache.delete(id);
      return route;
    } };
  } catch { return undefined; }
}

export async function applyPmOwners(rows, tasks, { questions = {}, routing, now = Date.now() } = {}) {
  const sets = questions.sets || [];
  const channels = routing?.channels || SLACK_PM_CHANNELS;
  for (const row of rows) {
    if (!isPmQuestion(row)) continue;
    delete row.pmOwner;
    delete row.pmOwnerId;
    const taskId = /^https:\/\/app\.clickup\.com\/t\/([a-z0-9]+)(?:[?#].*)?$/i.exec(row.url || '')?.[1];
    const stage = row.workflow === 'upload' ? 'klaviyo' : row.workflow === 'correction' ? 'korrektur' : row.workflow;
    const matches = sets.filter(set => set.mode === 'production' && !set.archivedAt && set.taskId === taskId
      && set.stage === stage && row.attemptId && (set.headRunId || set.runId) === row.attemptId
      && set.channelId && channels[set.channelId] === set.team
      && /^\d{10}\.\d{6}$/.test(set.threadTs || '')
      && set.questions?.some(question => ['open', 'waiting'].includes(question.status))
      && (stage !== 'translation' || row.id === `clickup:translation-${String(set.language).toLowerCase()}:${set.taskId}`));
    if (matches.length === 1) row.pmOwner = channels[matches[0].channelId];
    else if (!matches.length && taskId && routing) {
      try {
        const route = await routing.resolve(taskId);
        if (route?.channelId && channels[route.channelId] === route.team) row.pmOwner = route.team;
      } catch { /* Optional metadata cannot hide the queue or retain a wrong name. */ }
    }
    // Replace only the monitor's generated PM attribution, preserving the finding.
    if (row.blockerSource === 'checkpoint' && typeof row.blockedReason === 'string') {
      row.blockedReason = row.blockedReason.replace(/ \(PM(?:: [^)]*| nicht zugeordnet)\) · Nächster Schritt:/,
        () => ` (${row.pmOwner ? 'PM: ' + row.pmOwner : 'PM in Slack noch nicht bestätigt'}) · Nächster Schritt:`);
    }
    row.pmCheckedAt = new Date(now).toISOString();
  }
  return rows;
}
