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

export function applyPmQuestions(rows, { sets = [], jobs = [] } = {}) {
  for (const row of rows) {
    if (!['blocked', 'failed'].includes(row.status) || !row.run) continue;
    const stage = row.workflow === 'upload' ? 'klaviyo' : row.workflow === 'correction' ? 'korrektur' : row.workflow;
    const matches = sets.filter(set => set.mode === 'production' && set.stage === stage
      && set.questions.some(q => ['open', 'waiting', 'accepted'].includes(q.status))
      && set.taskId === row.run.taskId && set.workerId === row.workerId
      && (set.headRunId || set.runId) === row.run.id && set.threadTs
      && (stage !== 'translation' || row.id === `clickup:translation-${String(set.language).toLowerCase()}:${set.taskId}`));
    // Never guess between two journals for one source attempt.
    if (matches.length !== 1) continue;
    const set = matches[0];
    const pending = jobs.some(job => job.setId === set.id && job.sourceVersion === set.sourceVersion
      && job.state === 'queued' && set.questions.some(q => q.id === job.questionId && q.status === 'accepted' && q.revision === job.revision));
    const open = set.questions.filter(q => ['open', 'waiting'].includes(q.status));
    if (!pending && !open.length) continue;
    row.attemptId = row.run.id;
    row.updatedAt = new Date(Math.max(Date.parse(row.updatedAt) || 0, set.createdAt || 0)).toISOString();
    row.blockedReason = open.map(q => `${q.id}: ${q.title}`).join(' · ').slice(0, 500) || undefined;
    row.status = 'queued';
    row.phase = pending ? 'Wartet auf Fortsetzung' : 'Wartet · PM-Rückfrage';
  }
  return rows;
}
