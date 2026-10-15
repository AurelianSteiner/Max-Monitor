import fs from 'node:fs/promises';
import path from 'node:path';
import policy from './task-state.cjs';

export const STATUS_AUDIT_INTERVAL_MS = 30 * 60 * 1000;

// Serialized by the existing queue loop. No second writer, worker or API budget.
// A failed/partial source read never becomes a successful reconciliation.
export function createStatusAudit({ readFleet, save, now = Date.now, intervalMs = STATUS_AUDIT_INTERVAL_MS } = {}) {
  let nextAt = 0, pending;
  return {
    async begin(refresh = () => {}) {
      if (pending || now() < nextAt) return;
      const before = await readFleet();
      pending = { startedAt: new Date(now()).toISOString(), before: policy.auditTaskStates(before.queue.tasks) };
      refresh();
    },
    async finish(snapshot, { fresh = true } = {}) {
      if (!pending || !fresh || snapshot.source?.error || !Array.isArray(snapshot.tasks)) return;
      const fleet = await readFleet();
      if (fleet.queue.source.error || fleet.queue.source.stale === true) return;
      // An external newer sync wins; retry with its next complete source cycle.
      if (fleet.queue.source.lastSuccessAt !== snapshot.source.lastSuccessAt) return;
      const findings = policy.auditTaskStates(fleet.queue.tasks);
      const actual = new Map(fleet.queue.tasks.map(task => [task.id, task]));
      for (const task of snapshot.tasks) {
        if (!actual.has(task.id)) findings.push({ taskId: task.id, code: 'published_task_missing' });
        else if (task.status === 'completed' && actual.get(task.id).status !== 'completed')
          findings.push({ taskId: task.id, code: 'published_completion_reopened' });
      }
      const report = { schema: 1, startedAt: pending.startedAt, checkedAt: new Date(now()).toISOString(),
        sourceAt: snapshot.source.lastSuccessAt, intervalSeconds: intervalMs / 1000,
        tasksChecked: fleet.queue.tasks.length, ok: findings.length === 0,
        repaired: pending.before.filter(entry => !findings.some(item => item.taskId === entry.taskId && item.code === entry.code)), findings };
      await save(report);
      if (report.ok) { pending = undefined; nextAt = now() + intervalMs; }
      return report;
    },
  };
}

export async function saveStatusAudit(directory, report) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'status-reconciliation.json');
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
  // Bounded history: retain the last 96 half-hour checks (two days).
  const historyFile = path.join(directory, 'status-reconciliation.jsonl');
  let history = '';
  try { history = await fs.readFile(historyFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = [...history.trim().split('\n').filter(Boolean), JSON.stringify(report)].slice(-96);
  const historyTemporary = `${historyFile}.${process.pid}.tmp`;
  await fs.writeFile(historyTemporary, lines.join('\n') + '\n', { mode: 0o600 });
  await fs.rename(historyTemporary, historyFile);
}
