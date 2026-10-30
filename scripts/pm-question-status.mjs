// Read the existing durable PM journal; never create questions or continuations.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const displayText = (value, limit) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit).trim();
// Fehleraudit 21.10.2026: 29 of 34 saved PM answers were taken over within 1.8 min.
// A complete answer still unclaimed after 15 min (Teaworld, Kamelur: about 2 h
// unnoticed) is a technical stall on the owner Mac, not production waiting.
export const CONTINUATION_STALL_MS = 15 * 60000;
const BERLIN_MINUTE = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
// Visible worker names are the central colour names, never technical IDs.
const WORKER_NAMES = (() => { try { return require('../team-server/worker-identities.json'); } catch { return {}; } })();
const workerName = id => WORKER_NAMES[id]?.name || id || 'unbekannter Mac';
// Questions only a person can still settle. While one exists in any set of the
// order, the worker may not claim the saved answer (pm-questions.js sameTaskReady).
const UNSETTLED = ['open', 'waiting', 'conflict', 'failed'];

// Answer time of a complete set whose saved answer is still unclaimed after
// CONTINUATION_STALL_MS; the newest answer starts the clock. A started claim or
// dispatch is progress, an unknown answer time never escalates.
// Fehleraudit 30.10.2026 (Gartenfachmarkt24 86c91vafx): a dispatch still bound to the asking
// run, without a stored checkpoint (stored) and without completion, is no progress: its
// continuation was neither published nor started (the checkpoint exceeded the safe size).
function stalledAnswer(set, sets, jobs, now, { stored = false } = {}) {
  const own = jobs.filter(job => job.setId === set.id);
  const unstarted = job => job.state === 'dispatched' && !stored && !set.completion && job.dispatchRunId === (set.headRunId || set.runId);
  if (own.some(job => ['running', 'uncertain'].includes(job.state) || job.state === 'dispatched' && !unstarted(job))
    || sets.some(other => (other.id === set.id || other.mode === set.mode && !other.archivedAt && other.taskId === set.taskId)
      && other.questions.some(q => UNSETTLED.includes(q.status)))) return null;
  const answered = own.filter(job => (job.state === 'queued' || unstarted(job)) && job.sourceVersion === set.sourceVersion
    && set.questions.some(q => q.id === job.questionId && q.status === 'accepted' && q.revision === job.revision))
    .map(job => job.createdAt);
  if (!answered.length || !answered.every(Number.isFinite)) return null;
  const at = Math.max(...answered);
  return now - at >= CONTINUATION_STALL_MS ? at : null;
}

export function readPmQuestions(file, openDatabase = file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true })) {
  if (!fs.existsSync(file)) return { sets: [], jobs: [] };
  const db = openDatabase(file);
  try {
    const sets = db.prepare('SELECT doc FROM question_sets').all().map(row => JSON.parse(row.doc));
    const jobs = db.prepare('SELECT doc,state FROM question_jobs').all().map(row => ({ ...JSON.parse(row.doc), state: row.state }));
    return { sets, jobs };
  } finally { db.close(); }
}

export function applyPmQuestions(rows, { sets = [], jobs = [] } = {}, bindings = new Map(), { now = Date.now() } = {}) {
  for (const row of rows) {
    const run = row.run || bindings.get(row.id);
    const storedContinuation = row.status === 'queued' && row.phase === 'Wartet · Fortsetzung im RS Hub gesichert';
    // Fehleraudit 30.10.2026 (Gartenfachmarkt24 86c91vafx): a queued row whose own claim names
    // the PM but which has no phase (no stored checkpoint) waits on its PM journal as well.
    const pmHeld = row.status === 'queued' && !row.phase && row.blockerOwner === 'pm';
    if ((!['blocked', 'failed'].includes(row.status) && !storedContinuation && !pmHeld) || !run || (row.attemptId && row.attemptId !== run.id)) continue;
    const stage = row.workflow === 'upload' ? 'klaviyo' : row.workflow === 'correction' ? 'korrektur' : row.workflow;
    const matches = sets.filter(set => set.mode === 'production' && !set.archivedAt && set.stage === stage
      && set.questions.some(q => ['open', 'waiting', 'accepted'].includes(q.status) || q.status === 'replaced' && set.sourceChange?.reason)
      && set.taskId === run.taskId && set.workerId === (run.workerId || row.workerId)
      && (set.headRunId || set.runId) === run.id && set.threadTs
      && (stage !== 'translation' || row.id === `clickup:translation-${String(set.language).toLowerCase()}:${set.taskId}`));
    // An answered predecessor keeps its accepted questions and moves its head to
    // the continuation. A new follow-up may bind to that same head repeatedly.
    // Only journals still waiting for an answer or a queued continuation compete.
    const waiting = matches.map(set => ({ set,
      pending: jobs.some(job => job.setId === set.id && job.sourceVersion === set.sourceVersion
        && (job.state === 'queued' || job.state === 'dispatched' && !set.completion
          && set.runId === run.id && job.runId === run.id && job.dispatchRunId === run.id)
        && set.questions.some(q => q.id === job.questionId && q.status === 'accepted' && q.revision === job.revision)),
      open: set.questions.filter(q => ['open', 'waiting'].includes(q.status)),
      sourceChange: set.sourceChange?.reason && set.questions.some(q => q.status === 'replaced') ? set.sourceChange : null,
    })).filter(({ pending, open, sourceChange }) => pending || open.length || sourceChange);
    // Never guess between genuinely competing open journals for one attempt.
    if (waiting.length !== 1) continue;
    const { set, open, sourceChange } = waiting[0];
    row.attemptId = run.id;
    row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt) || 0, set.createdAt || 0)).toISOString();
    if (sourceChange) {
      const saved = set.questions.filter(q => q.answer).map(q => `${q.id}: ${q.answer.value}`).join(' · ');
      const technical = /Figma-Rahmen/.test(sourceChange.reason);
      row.status = technical ? 'blocked' : 'queued';
      row.phase = technical ? 'Blockiert · Quellenabgleich' : 'Wartet · PM-Rückfrage';
      row.blockedReason = displayText(`${saved ? `PM-Antwort gespeichert (${saved}). ` : ''}${sourceChange.reason}`, 500);
      row.blockerReason = row.blockedReason;
      row.reasonCode = technical ? 'preparation_source_changed' : 'pm_source_changed';
      row.responsibleRole = technical ? 'Technik' : 'PM';
      row.nextStep = displayText('Die geänderte Quelle mit dem gespeicherten Stand abgleichen; anschließend die vorhandene Antwort im selben Auftrag fortsetzen.', 300);
      row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt), Number(sourceChange.at) || 0)).toISOString();
      continue;
    }
    const stalledAt = !open.length && stalledAnswer(set, sets, jobs, now, { stored: /im RS Hub gesichert$/.test(row.phase || '') });
    if (stalledAt) {
      const owner = workerName(set.workerId);
      const saved = set.questions.filter(q => q.answer).map(q => `${q.id}: ${q.answer.value}`).join(' · ');
      // A stable answer time, not a minute count: the diagnosis binds operator decisions (fleet.js taskVersion).
      row.status = 'blocked';
      row.phase = 'Blockiert · PM-Antwort nicht übernommen';
      row.blockedReason = displayText(`Gespeicherte PM-Antwort seit ${BERLIN_MINUTE.format(stalledAt)} nach über ${CONTINUATION_STALL_MS / 60000} min nicht übernommen (Besitzer: ${owner}).${saved ? ` Antwort: ${saved}` : ''}`, 500);
      row.blockerReason = row.blockedReason;
      row.reasonCode = 'continuation_stalled';
      row.responsibleRole = 'Technik';
      row.nextStep = displayText(`Auf ${owner} prüfen, warum der Fragen-Worker die gespeicherte Antwort nicht übernimmt; Antwort und Arbeitsstand erhalten.`, 300);
      row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt), stalledAt + CONTINUATION_STALL_MS)).toISOString();
      continue;
    }
    row.blockedReason = displayText(open.map(q => `${q.id}: ${q.title}`).join(' · '), 500) || undefined;
    row.status = 'queued';
    row.phase = open.length ? 'Wartet · PM-Rückfrage' : 'Wartet auf Fortsetzung';
    // The fresh journal replaces a historical technical checkpoint diagnosis.
    // A PM decision and an answered continuation need different next actions.
    row.blockerReason = row.blockedReason;
    row.reasonCode = open.length ? 'pm_decision_pending' : 'continuation_pending';
    row.responsibleRole = open.length ? 'PM' : 'Produktion';
    row.nextStep = open.length
      ? displayText(`Im bestehenden Rückfragen-Thread klären: ${row.blockedReason}`, 300)
      : 'Die gespeicherte PM-Antwort im bestehenden Produktionsauftrag fortsetzen und das Ergebnis prüfen.';
  }
  return rows;
}
