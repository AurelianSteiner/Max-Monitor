// Read-only next-job projection. Ordering and per-account refusals come from
// the unchanged Worker module (quota-pacing.js, see vendor/README.md);
// task-specific access, reservations and the bounded preference wait still apply.
const { analyseFleet, macKey, slotRefusal, fleetMacs, PACING } = require('./quota-pacing');
const { workerProfile } = require('./worker-kinds');
const KINDS = { newsletter: 'newsletter', correction: 'korrektur', translation: 'translation', upload: 'klaviyo' };
const percent = value => Number.isFinite(value) && value >= 0 && value <= 100;
// Display values of one account slot. Analysed slots carry the scorer's view
// (a passed reset already counts as empty); others keep their raw, stale values.
function windowsOf(entry, slot, quota) {
  return Object.fromEntries(['five_hour', 'seven_day'].map(name => {
    if (!slot) {
      const raw = quota?.windows?.[name];
      return [name, { fresh: false, remaining: percent(raw?.used) ? 100 - raw.used : null,
        reset: Number.isFinite(raw?.reset) && raw.reset > 0 ? raw.reset : null, at: Number.isFinite(raw?.at) ? raw.at : null }];
    }
    const raw = slot[name], known = Boolean(entry?.known), weekly = name === 'seven_day';
    const used = known ? (weekly ? entry.uW : entry.u5) : raw?.used;
    const reset = known ? (weekly ? entry.resetW : entry.r5 === null ? null : raw.reset) : raw?.reset;
    return [name, { fresh: known, remaining: percent(used) ? 100 - used : null,
      reset: Number.isFinite(reset) && reset > 0 ? reset / 1000 : null, at: Number.isFinite(slot.at) ? slot.at / 1000 : null,
      // Weekly pace line: target = expected use by now, gap = use − target (pp).
      ...(known && weekly ? { target: entry.target, gap: entry.g } : {}) }];
  }));
}
function distribution(summary, machines, nowMs = Date.now()) {
  const snapshot = summary?.scheduling;
  const fresh = at => Number.isFinite(Date.parse(at)) && nowMs - Date.parse(at) >= -60000 && nowMs - Date.parse(at) <= 180000;
  const available = snapshot?.schema === 1 && fresh(snapshot.generated_at) && snapshot.routing?.available === true;
  const fleet = (Array.isArray(snapshot?.routing?.fleet) ? snapshot.routing.fleet : [])
    .filter(m => m && typeof m === 'object' && workerProfile(m.worker_id).provider === 'claude');
  const jobs = (Array.isArray(snapshot?.routing?.jobs) ? snapshot.routing.jobs : []).filter(j => j && typeof j === 'object');
  const visible = new Map(machines.filter(m => m.workerId && workerProfile(m.workerId).provider === 'claude').map(m => [m.workerId, m]));
  const loads = new Map(fleet.filter(m => Number.isFinite(Date.parse(m.seen_at)) && Math.max(0, nowMs - Date.parse(m.seen_at)) <= 3600000)
    .map(m => [m.worker_id, Math.max(Number.isInteger(m.occupied_tasks) ? m.occupied_tasks : 0, jobs.filter(j => j.worker === m.worker_id).length)]));
  // The same fleet view as a worker: Hub heartbeats (own quota_slots first,
  // Max Monitor's account row as fallback) and the active reservations.
  const macs = fleetMacs(fleet.map(m => ({ ...m, quota: snapshot?.workers?.[m.worker_id] })), { jobs });
  const analysis = analyseFleet(macs, nowMs);
  const byKind = {};
  for (const [kind, place] of Object.entries(KINDS)) {
    const rows = [...visible].map(([worker, machine]) => {
      const m = fleet.find(m => m.worker_id === worker);
      const load = loads.get(worker) ?? null;
      const cap = Number.isInteger(m?.max_tasks) && m.max_tasks >= 0 && m.max_tasks <= 50 ? m.max_tasks : null;
      const places = m?.plaetze;
      const validPlaces = places && ['newsletter','klaviyo','translation'].every(k => Object.hasOwn(places,k))
        && Object.keys(places).every(k => ['newsletter','klaviyo','translation','korrektur'].includes(k))
        && Object.values(places).every(n => Number.isInteger(n) && n >= 0 && n <= 50);
      const count = jobs.filter(j => j.worker === worker && j.kind === kind).length;
      let reason = !available ? 'unavailable' : !fresh(m?.seen_at) ? 'stale_worker' : m.annahme !== true ? 'not_accepting'
        : cap === null || !validPlaces ? 'missing_slots' : load >= cap ? 'full' : !(places[place] > count) ? 'kind_full' : null;
      const entries = analysis.get(worker) || [];
      // Account refusals (limited, soft_cap, guard_5h, guard_weekly, paced) only
      // for a Mac that could otherwise start; the key is the Worker's order key.
      const scored = reason ? null : macKey(entries, load ?? 0, kind);
      if (scored?.refusal) reason = scored.refusal;
      const shown = (scored?.slot ? entries.find(e => e.slot === scored.slot) : null)
        || (scored?.refusal ? entries.find(e => slotRefusal(e, kind)) : null) || entries.find(e => e.known) || entries[0] || null;
      const slot = shown ? macs.find(mac => mac.worker === worker)?.slots.find(s => s.slot === shown.slot) : null;
      // A paused worker can stop its intake heartbeat while its independent
      // observer still proves physical load. Display it without renewing intake.
      return {worker, name: machine.name || worker,
        load: load ?? (machine.load?.fresh ? machine.load.occupied ?? null : null),
        cap: cap ?? (machine.load?.fresh ? machine.load.max ?? null : null),
        seen_at: m?.seen_at || null, reason, key: scored && !scored.refusal ? scored.key : null,
        slot: shown?.slot ?? null, windows: windowsOf(shown, slot, snapshot?.workers?.[worker])};
    });
    const eligible = rows.filter(r => !r.reason);
    const best = Math.min(...eligible.map(r => r.key));
    for (const row of rows) row.preferred = available && !row.reason && row.key - best <= PACING.keyEps + 1e-9;
    const informed = eligible.some(r => r.windows.five_hour.fresh || r.windows.seven_day.fresh);
    rows.sort((a,b) => Number(Boolean(a.reason))-Number(Boolean(b.reason)) || Number(b.preferred)-Number(a.preferred)
      || (a.key??Infinity)-(b.key??Infinity) || (a.load??Infinity)-(b.load??Infinity) || a.name.localeCompare(b.name,'de'));
    byKind[kind] = {mode: !available ? 'unavailable' : informed ? 'quota' : 'load', rows};
  }
  return {generated_at:new Date(nowMs).toISOString(), source_at:snapshot?.generated_at || null, by_kind:byKind};
}
module.exports = {distribution};
