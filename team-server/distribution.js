// Read-only next-job projection. The scorer is the unchanged Worker function;
// task-specific access, reservations and the bounded preference wait still apply.
const { quotaScores } = require('./quota-scores');
const KINDS = { newsletter: 'newsletter', correction: 'korrektur', translation: 'translation', upload: 'klaviyo' };
function distribution(summary, machines, nowMs = Date.now()) {
  const snapshot = summary?.scheduling;
  const fresh = at => Number.isFinite(Date.parse(at)) && nowMs - Date.parse(at) >= -60000 && nowMs - Date.parse(at) <= 180000;
  const available = snapshot?.schema === 1 && fresh(snapshot.generated_at) && snapshot.routing?.available === true;
  const fleet = snapshot?.routing?.fleet || [];
  const jobs = snapshot?.routing?.jobs || [];
  const visible = new Map(machines.filter(m => m.workerId).map(m => [m.workerId, m]));
  const peers = fleet.filter(m => Number.isFinite(Date.parse(m.seen_at)) && Math.max(0,nowMs-Date.parse(m.seen_at)) <= 3600000)
    .map(m => ({ worker: m.worker_id, quota: snapshot?.workers?.[m.worker_id],
    load: Math.max(Number.isInteger(m.occupied_tasks) ? m.occupied_tasks : 0, jobs.filter(j => j.worker === m.worker_id).length) }));
  const byKind = {};
  for (const [kind, slot] of Object.entries(KINDS)) {
    const rows = [...visible].map(([worker, machine]) => {
      const m = fleet.find(m => m.worker_id === worker);
      const load = peers.find(p => p.worker === worker)?.load ?? null;
      const cap = Number.isInteger(m?.max_tasks) && m.max_tasks >= 0 && m.max_tasks <= 50 ? m.max_tasks : null;
      const places = m?.plaetze;
      const validPlaces = places && ['newsletter','klaviyo','translation'].every(k => Object.hasOwn(places,k))
        && Object.keys(places).every(k => ['newsletter','klaviyo','translation','korrektur'].includes(k))
        && Object.values(places).every(n => Number.isInteger(n) && n >= 0 && n <= 50);
      const count = jobs.filter(j => j.worker === worker && j.kind === kind).length;
      const reason = !available ? 'unavailable' : !fresh(m?.seen_at) ? 'stale_worker' : m.annahme !== true ? 'not_accepting'
        : cap === null || !validPlaces ? 'missing_slots' : load >= cap ? 'full' : !(places[slot] > count) ? 'kind_full' : null;
      const quota = snapshot?.workers?.[worker];
      const input = {worker, load: load ?? 0, maxTasks: cap ?? 1, quota};
      const diagnostic = quotaScores({candidates:[input], peers, jobs, kind, nowMs})?.[0];
      const windows = Object.fromEntries(['five_hour','seven_day'].map(name => {
        const raw = quota?.windows?.[name];
        const scored = diagnostic?.windows[name];
        const validRaw = Number.isFinite(raw?.used) && raw.used >= 0 && raw.used <= 100;
        return [name, {fresh: Boolean(scored), remaining: validRaw ? 100-raw.used : null,
          reset: Number.isFinite(raw?.reset) && raw.reset > 0 ? raw.reset : null,
          at: Number.isFinite(raw?.at) ? raw.at : null,
          ...(scored || {})}];
      }));
      // A paused worker can stop its intake heartbeat while its independent
      // observer still proves physical load. Display it without renewing intake.
      return {worker, name: machine.name || worker,
        load: load ?? (machine.load?.fresh ? machine.load.occupied ?? null : null),
        cap: cap ?? (machine.load?.fresh ? machine.load.max ?? null : null),
        seen_at: m?.seen_at || null, reason, windows, input};
    });
    const candidates = rows.filter(r => !r.reason).map(r => r.input);
    const scores = available ? quotaScores({candidates, peers, jobs, kind, nowMs}) : null;
    for (const row of rows) {
      const scored = scores?.find(s => s.worker === row.worker);
      row.score = scored?.score ?? null;
      row.budget_per_hour = scored?.budget_per_hour ?? null;
      if (scored?.blocked) row.reason = 'quota';
      delete row.input;
    }
    const eligible = rows.filter(r => !r.reason);
    const best = scores ? Math.max(...eligible.map(r => r.score)) : Math.min(...eligible.map(r => r.load));
    for (const row of rows) row.preferred = !row.reason && (scores ? best - row.score <= .03 : row.load === best);
    rows.sort((a,b) => Number(Boolean(a.reason))-Number(Boolean(b.reason)) || Number(b.preferred)-Number(a.preferred)
      || (scores ? (b.score??-1)-(a.score??-1) : (a.load??Infinity)-(b.load??Infinity)) || a.name.localeCompare(b.name,'de'));
    byKind[kind] = {mode: !available ? 'unavailable' : scores ? 'quota' : 'load', rows};
  }
  return {generated_at:new Date(nowMs).toISOString(), source_at:snapshot?.generated_at || null, by_kind:byKind};
}
module.exports = {distribution};
