// Per-task elapsed time survives queue refreshes, retries and relay restarts.
// Queue residence before the first run is excluded; waiting after it is blocked.
const BLOCKED = new Set(['blocked', 'failed', 'paused', 'clarification', 'queued']);
const date = value => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
};
const iso = ms => new Date(ms).toISOString();

function observe(record, task, now) {
  const status = task.status;
  const sourceStart = date(task.startedAt);
  const initial = !record;
  if (!record) record = { status: 'queued', since: now, blockedMs: 0, coverageComplete: true };
  if (!record.startedAt && (status !== 'queued' || sourceStart !== null)) {
    if (status === 'completed' && sourceStart === null) {
      return { ...record, status, endedAt: task.completedAt || null, coverageComplete: false };
    }
    const start = sourceStart !== null && sourceStart <= now ? sourceStart : now;
    record.startedAt = iso(start);
    record.startKnown = sourceStart !== null || record.seenQueued === true;
    record.coverageComplete = record.seenQueued === true && status === 'running' && now - start < 90000;
    record.since = now;
  }
  if (sourceStart !== null && record.startedAt && sourceStart < date(record.startedAt)) {
    const missed = date(record.startedAt) - sourceStart;
    record.startedAt = iso(sourceStart);
    record.startKnown = true;
    if (missed > 90000) record.coverageComplete = false;
  }
  if (record.status !== status) {
    // Source timestamps describe a transition only when they lie inside the
    // observed interval. Otherwise use the receipt time, never a later edit.
    const supplied = date(status === 'completed' ? task.completedAt || task.updatedAt : task.statusChangedAt);
    const transition = supplied !== null && supplied >= record.since && supplied <= now ? supplied : now;
    if (record.startedAt && (BLOCKED.has(record.status) || record.status === 'completed')) record.blockedMs += Math.max(0, transition - record.since);
    record.status = status;
    record.since = transition;
    if (status === 'completed') record.endedAt = iso(transition);
    else delete record.endedAt;
  }
  if (status === 'completed') {
    const end = date(task.completedAt);
    if (end !== null && end >= date(record.startedAt) && end <= now) record.endedAt = iso(end);
    else if (initial) delete record.endedAt;
  }
  if (status === 'queued' && !record.startedAt) record.seenQueued = true;
  return record;
}

function reconcileTimings(state, tasks, now) {
  const old = state.queue.timings || {};
  const timings = Object.assign(Object.create(null), old);
  let changed = false;
  for (const task of tasks) {
    let record = Object.hasOwn(old, task.id) ? { ...old[task.id] } : null;
    if (!record) {
      // One-time migration from the bounded event log. A missing beginning is
      // explicitly partial, not silently reported as a full working duration.
      for (const event of state.events) {
        const status = event.type?.replace(/^task_/, '');
        if (event.taskId !== task.id || !['queued', 'running', 'blocked', 'failed', 'paused', 'clarification', 'completed'].includes(status)) continue;
        const at = date(event.at);
        if (at !== null && at <= now) record = observe(record, { status }, at);
      }
    }
    record = observe(record, task, now);
    if (JSON.stringify(record) !== JSON.stringify(Object.hasOwn(old, task.id) ? old[task.id] : undefined)) changed = true;
    timings[task.id] = record;
  }
  // Keep removed tasks for short-lived source/filter gaps, with a hard bound.
  const ids = new Set(tasks.map(task => task.id));
  const extra = Object.keys(timings).filter(id => !ids.has(id)).sort((a, b) => timings[b].since - timings[a].since);
  for (const id of extra.slice(5000)) { delete timings[id]; changed = true; }
  if (changed) state.queue.timings = timings;
  return changed;
}

function withTiming(task, record, now) {
  if (!record?.startedAt) return { ...task, timing: { startedAt: null, completedAt: record?.endedAt || null,
    totalMs: null, blockedMs: null, activeMs: null, coverageComplete: false } };
  const start = date(record.startedAt);
  if (record.status === 'completed' && !record.endedAt) return { ...task, timing: {
    startedAt: record.startedAt, startKnown: record.startKnown, completedAt: null,
    totalMs: null, blockedMs: null, activeMs: null, coverageComplete: false } };
  const end = date(record.endedAt) ?? now;
  const totalMs = Math.max(0, end - start);
  const blockedMs = Math.min(totalMs, record.blockedMs + (BLOCKED.has(record.status) ? Math.max(0, end - record.since) : 0));
  return { ...task, timing: { startedAt: record.startedAt, completedAt: record.endedAt || null,
    totalMs, blockedMs, activeMs: totalMs - blockedMs, coverageComplete: record.coverageComplete,
    startKnown: record.startKnown === true,
    running: record.status !== 'completed' } };
}

module.exports = { reconcileTimings, withTiming };
