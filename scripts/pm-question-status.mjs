// Read the existing durable PM journal; never create questions or continuations.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function readPmQuestions(file, openDatabase = file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true })) {
  if (!fs.existsSync(file)) return { sets: [], jobs: [] };
  const db = openDatabase(file);
  try {
    const sets = db.prepare('SELECT doc FROM question_sets').all().map(row => JSON.parse(row.doc));
    const jobs = db.prepare('SELECT doc,state FROM question_jobs').all().map(row => ({ ...JSON.parse(row.doc), state: row.state }));
    return { sets, jobs };
  } finally { db.close(); }
}

export function applyPmQuestions(rows, { sets = [], jobs = [] } = {}, bindings = new Map()) {
  for (const row of rows) {
    const run = row.run || bindings.get(row.id);
    if (!['blocked', 'failed'].includes(row.status) || !run || (row.attemptId && row.attemptId !== run.id)) continue;
    const stage = row.workflow === 'upload' ? 'klaviyo' : row.workflow === 'correction' ? 'korrektur' : row.workflow;
    const matches = sets.filter(set => set.mode === 'production' && !set.archivedAt && set.stage === stage
      && set.questions.some(q => ['open', 'waiting', 'accepted'].includes(q.status))
      && set.taskId === run.taskId && set.workerId === (run.workerId || row.workerId)
      && (set.headRunId || set.runId) === run.id && set.threadTs
      && (stage !== 'translation' || row.id === `clickup:translation-${String(set.language).toLowerCase()}:${set.taskId}`));
    // Never guess between two journals for one source attempt.
    if (matches.length !== 1) continue;
    const set = matches[0];
    const pending = jobs.some(job => job.setId === set.id && job.sourceVersion === set.sourceVersion
      && job.state === 'queued' && set.questions.some(q => q.id === job.questionId && q.status === 'accepted' && q.revision === job.revision));
    const open = set.questions.filter(q => ['open', 'waiting'].includes(q.status));
    if (!pending && !open.length) continue;
    row.attemptId = run.id;
    row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt) || 0, set.createdAt || 0)).toISOString();
    row.blockedReason = open.map(q => `${q.id}: ${q.title}`).join(' · ').slice(0, 500) || undefined;
    row.status = 'queued';
    row.phase = open.length ? 'Wartet · PM-Rückfrage' : 'Wartet auf Fortsetzung';
    // The fresh journal replaces a historical technical checkpoint diagnosis.
    // A PM decision and an answered continuation need different next actions.
    row.blockerReason = row.blockedReason;
    row.reasonCode = open.length ? 'pm_decision_pending' : 'continuation_pending';
    row.responsibleRole = open.length ? 'PM' : 'Produktion';
    row.nextStep = open.length
      ? `Im bestehenden Rückfragen-Thread klären: ${row.blockedReason}`.slice(0, 500)
      : 'Die gespeicherte PM-Antwort im bestehenden Produktionsauftrag fortsetzen und das Ergebnis prüfen.';
  }
  return rows;
}
