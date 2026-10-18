// One projection policy for source snapshots, live reports and periodic audits.
// It changes monitor state only; ClickUp, reviews and production stay untouched.
const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const PRE_GEN_DOWNSTREAM = new Set(['qa', 'revisionintern', 'revisionextern',
  'designrevisionintern', 'designrevisionextern', 'approvalintern', 'approvalextern', 'klaviyoupload', 'golive']);

function preGenFinished(task) {
  return task.workflow === 'newsletter' && PRE_GEN_DOWNSTREAM.has(normalize(task.sourceStatus));
}

function reconcileTask(task) {
  if (task.completion === 'manual') return { ...task, status: 'completed', progress: 100,
    phase: 'Manuell erledigt', step: undefined, blockedReason: undefined, errorUrl: undefined };
  if (task.status === 'completed' || preGenFinished(task)) {
    return { ...task, status: 'completed', progress: 100, workerId: task.status === 'completed' ? task.workerId : null,
      phase: preGenFinished(task) ? 'Pre-Gen abgeschlossen · ' + task.sourceStatus : task.status === 'completed' && !/Pausiert|Wartet|blockiert/i.test(task.phase || '') ? task.phase : undefined,
      step: undefined, blockedReason: undefined, errorUrl: undefined,
      completionSource: task.completionSource || (preGenFinished(task) ? 'review' : undefined) };
  }
  const current = { ...task, completedAt: undefined, completionSource: undefined };
  if (task.status === 'clarification' || task.phase === 'Wartet · PM-Rückfrage')
    return { ...current, status: 'queued', workerId: null, phase: 'Wartet · PM-Rückfrage' };
  return current;
}

function reportMayReplace(task, run, sampledAt) {
  if (!task) return true;
  if (task.phase === 'Wartet · PM-Rückfrage') return false;
  if (task.attemptId && run.runId !== task.attemptId) {
    const source = /^(\d{8}T\d{6}Z)-/.exec(task.attemptId)?.[1];
    const observed = /^(\d{8}T\d{6}Z)-/.exec(run.runId || '')?.[1];
    if (source && observed && observed <= source) return false;
    if (task.status === 'queued' && !(source && observed && observed > source)) return false;
  }
  if (['paused', 'blocked', 'failed', 'completed'].includes(task.status)
    && Date.parse(task.updatedAt) > Date.parse(sampledAt)) return false;
  if (task.status !== 'completed') return true;
  // A heartbeat is observation time, never proof of a new production order.
  if (preGenFinished(task) || task.completion === 'manual') return false;
  if (task.attemptId || task.completedAt) return false;
  // Legacy unbound tag-only rows retain their existing live-report behaviour.
  return true;
}

function auditTaskStates(tasks) {
  const findings = [], ids = new Set();
  for (const task of tasks) {
    const add = code => findings.push({ taskId: task.id, code, status: task.status, phase: task.phase });
    if (ids.has(task.id)) add('duplicate_task');
    ids.add(task.id);
    if (preGenFinished(task) && task.status !== 'completed') add('finished_pre_gen_reopened');
    if (task.status !== 'completed' && task.completedAt) add('completion_on_active_attempt');
    if (task.status === 'completed' && (/Pausiert|Wartet|blockiert/i.test(task.phase || '') || task.blockedReason)) add('stale_terminal_details');
    if (task.phase === 'Wartet · PM-Rückfrage' && (task.status !== 'queued' || task.workerId)) add('pm_question_dispatched');
  }
  return findings;
}

module.exports = { preGenFinished, reconcileTask, reportMayReplace, auditTaskStates };
