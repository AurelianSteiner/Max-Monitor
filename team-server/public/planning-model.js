'use strict';
// Shared, deterministic what-if model. No reservations, provider calls or task writes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MaxMonitorPlanningModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const KINDS = ['newsletter', 'correction', 'upload', 'translation', 'sales'];
  const SLOTS = { newsletter: 'newsletter', correction: 'korrektur', upload: 'klaviyo', translation: 'translation', sales: 'sales' };
  const HOUR = 3600000, DAY = 24 * HOUR, STEP = HOUR / 4, LIMIT = 2000;
  const DEFAULTS = Object.freeze({ horizon: 7, startMode: 'cycle', startHour: 8, hoursPerDay: 12,
    workdays: 5, reserve: 20, conservative: true, includeQueue: true, newsletters: 10,
    correctionsPerNewsletter: 1, uploadsPerNewsletter: 1, extraCorrections: 0, extraUploads: 0,
    extraMacs: 0, extraAccounts: 0, referenceWorker: '', fiveHourFactor: 1, weeklyFactor: 1, newSlots: 1, overrides: {} });
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fresh = (value, now, age = 180000) => {
    const at = typeof value === 'number' ? value * 1000 : Date.parse(value);
    return Number.isFinite(at) && at <= now + 60000 && now - at <= age;
  };
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  function berlinParts(time) {
    return Object.fromEntries(dateParts.formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  }
  function berlinTime(y, m, d, hour) {
    const local = Date.UTC(y, m - 1, d, hour);
    let result = local;
    for (let i = 0; i < 3; i++) {
      const p = berlinParts(result);
      result += local - Date.UTC(p.year, p.month - 1, p.day, p.hour);
    }
    return result;
  }
  function calendar(config, now) {
    const p = berlinParts(now), days = [];
    // Cycle planning starts with full budgets on the next operating day. Live
    // planning starts now. Calendar arithmetic retains Berlin hours across DST.
    let offset = config.startMode === 'cycle' ? 1 : 0;
    if (config.horizon === 1 && config.startMode === 'cycle') {
      while (config.workdays === 5 && [0, 6].includes(new Date(Date.UTC(p.year, p.month - 1, p.day + offset)).getUTCDay())) offset++;
    }
    for (let i = 0; i < config.horizon; i++) {
      const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset + i));
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
      const from = berlinTime(y, m, day, config.startHour);
      const end = berlinTime(y, m, day, config.startHour + config.hoursPerDay);
      const workday = config.workdays === 7 || ![0, 6].includes(d.getUTCDay());
      const start = config.startMode === 'live' ? Math.max(from, now) : from;
      days.push({ date: d.toISOString().slice(0, 10), start, end, hours: workday ? Math.max(0, (end - start) / HOUR) : 0 });
    }
    return days;
  }
  function validConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).some(k => !Object.hasOwn(DEFAULTS, k))) return false;
    const c = { ...DEFAULTS, ...value };
    const integer = (k, min, max) => Number.isInteger(c[k]) && c[k] >= min && c[k] <= max;
    if (![1, 7, 28].includes(c.horizon) || !['cycle', 'live'].includes(c.startMode) || ![5, 7].includes(c.workdays)
      || !integer('startHour', 0, 23) || !integer('hoursPerDay', 1, 24) || c.startHour + c.hoursPerDay > 24
      || !integer('reserve', 0, 80) || !integer('newsletters', 0, LIMIT) || !integer('extraCorrections', 0, LIMIT)
      || !integer('extraUploads', 0, LIMIT) || !integer('extraMacs', 0, 30) || !integer('extraAccounts', 0, c.extraMacs)
      || !integer('newSlots', 1, 10) || !['fiveHourFactor', 'weeklyFactor'].every(k => finite(c[k]) && c[k] >= .1 && c[k] <= 20)
      || !finite(c.correctionsPerNewsletter) || c.correctionsPerNewsletter < 0 || c.correctionsPerNewsletter > 10
      || !finite(c.uploadsPerNewsletter) || c.uploadsPerNewsletter < 0 || c.uploadsPerNewsletter > 5
      || typeof c.conservative !== 'boolean' || typeof c.includeQueue !== 'boolean'
      || typeof c.referenceWorker !== 'string' || c.referenceWorker.length > 100
      || !c.overrides || typeof c.overrides !== 'object' || Array.isArray(c.overrides) || Object.keys(c.overrides).length > 100) return false;
    return Object.entries(c.overrides).every(([worker, costs]) => worker.length <= 100 && costs && typeof costs === 'object' && !Array.isArray(costs)
      && Object.entries(costs).every(([kind, row]) => KINDS.includes(kind) && row && typeof row === 'object' && !Array.isArray(row)
        && Object.keys(row).every(k => ['minutes', 'fiveHour', 'weekly'].includes(k))
        && Object.entries(row).every(([k, n]) => finite(n) && n > 0 && n <= (k === 'minutes' ? 1440 : 100))));
  }
  function measured(metric, conservative, minimum = 5) {
    if (!metric || metric.n < minimum || !finite(metric.mean) || metric.mean <= 0 || !finite(metric.sd) || metric.sd < 0) return null;
    return metric.mean + (conservative ? metric.sd : 0);
  }
  function costsFor(quota, override, conservative) {
    return Object.fromEntries(KINDS.map(kind => {
      const raw = quota?.costs?.[kind], manual = override?.[kind] || {};
      const fiveHour = manual.fiveHour ?? measured(raw?.five_hour_pp, conservative);
      const weekly = manual.weekly ?? measured(raw?.weekly_pp, conservative);
      const minutes = manual.minutes ?? (measured(raw?.duration_seconds, conservative) / 60 || null);
      return [kind, { fiveHour, weekly, minutes, ready: [fiveHour, weekly, minutes].every(n => finite(n) && n > 0),
        manual: Object.keys(manual).length > 0, n: Math.min(raw?.five_hour_pp?.n || 0, raw?.weekly_pp?.n || 0, raw?.duration_seconds?.n || 0) }];
    }));
  }
  function inventory(source, config, expansion, now) {
    const scheduling = source?.scheduling, accounts = new Map(), machines = [], excluded = [];
    const sourceFresh = fresh(source?.generated_at, now) && fresh(scheduling?.generated_at, now) && scheduling?.routing?.available === true;
    const fleet = scheduling?.routing?.fleet || [];
    for (const row of fleet) {
      const id = row.worker_id, quota = scheduling?.workers?.[id];
      const slots = row.plaetze;
      let reason = !sourceFresh || !fresh(row.seen_at, now) ? 'Meldung veraltet' : !quota?.account ? 'Account fehlt'
        : !Number.isInteger(row.max_tasks) || row.max_tasks < 1 || row.max_tasks > 50 || !slots ? 'Platzlimit fehlt' : null;
      if (!reason && config.startMode === 'live') {
        reason = row.annahme !== true ? 'Annahme pausiert' : null;
        for (const name of ['five_hour', 'seven_day']) {
          const w = quota.windows?.[name];
          if (!fresh(w?.at, now, 900000) || !finite(w?.used) || w.used < 0 || w.used > 100
            || (!finite(w?.reset) && !(name === 'five_hour' && w.used === 0))
            || (finite(w?.reset) && w.reset * 1000 <= now)) reason = 'Kontingent oder Reset fehlt/veraltet';
        }
      }
      if (reason) { excluded.push({ worker: id, reason }); continue; }
      const costs = costsFor(quota, config.overrides[id], config.conservative);
      // All workers bound to the same Claude account share one budget. Manual
      // account costs are selected once and apply to every Mac on that account.
      if (!accounts.has(quota.account)) accounts.set(quota.account, { id: quota.account, costs, windows: quota.windows, workers: [] });
      const account = accounts.get(quota.account);
      if (config.overrides[id]) account.costs = costs;
      account.workers.push(id);
      machines.push({ id, account: quota.account, max: row.max_tasks,
        slots: Object.fromEntries(KINDS.map(k => [k, Number.isInteger(slots[SLOTS[k]]) ? Math.max(0, slots[SLOTS[k]]) : 0])) });
    }
    const reference = machines.find(m => m.id === config.referenceWorker);
    if (expansion && config.extraMacs && reference) {
      const original = accounts.get(reference.account);
      for (let i = 0; i < config.extraAccounts; i++) {
        const id = `scenario-account-${i}`;
        const costs = Object.fromEntries(KINDS.map(k => [k, { ...original.costs[k], manual: true,
          fiveHour: original.costs[k].fiveHour / config.fiveHourFactor, weekly: original.costs[k].weekly / config.weeklyFactor }]));
        accounts.set(id, { id, costs, windows: {}, workers: [], scenario: true });
      }
      for (let i = 0; i < config.extraMacs; i++) {
        const account = config.extraAccounts ? `scenario-account-${i % config.extraAccounts}` : reference.account;
        machines.push({ id: `scenario-mac-${i}`, account, max: config.newSlots,
          slots: Object.fromEntries(KINDS.map(k => [k, config.newSlots])) });
      }
    }
    return { accounts: [...accounts.values()], machines, excluded, sourceFresh, missingReference: expansion && config.extraMacs > 0 && !reference };
  }
  function demand(config, newsletters = config.newsletters) {
    return { newsletter: newsletters, correction: Math.ceil(newsletters * config.correctionsPerNewsletter) + config.extraCorrections,
      upload: Math.ceil(newsletters * config.uploadsPerNewsletter) + config.extraUploads, translation: 0, sales: 0 };
  }
  function simulate(source, config, inv, requested, now) {
    const days = calendar(config, now), start = days[0].start;
    const backlog = config.includeQueue ? source?.backlog || {} : {};
    const pending = Object.fromEntries(KINDS.map(k => [k, (requested[k] || 0) + (backlog[k] || 0)]));
    const initial = { ...pending }, done = Object.fromEntries(KINDS.map(k => [k, 0]));
    const accountById = new Map(inv.accounts.map(a => {
      const cycle = config.startMode === 'cycle' || a.scenario;
      const windows = {};
      for (const [key, duration] of [['five_hour', 5 * HOUR], ['seven_day', 7 * DAY]]) {
        const raw = a.windows?.[key];
        windows[key] = { used: cycle ? 0 : raw.used, reset: cycle ? (key === 'five_hour' ? null : start + duration) : (raw.reset ? raw.reset * 1000 : null), duration };
      }
      return [a.id, { ...a, windows, peak: windows.seven_day.used }];
    }));
    const machines = inv.machines.map(m => ({ ...m, active: [] })), active = [];
    const daily = days.map(d => ({ date: d.date, hours: d.hours, busyHours: 0, capacityHours: d.hours * inv.machines.reduce((s, m) => s + m.max, 0),
      completed: Object.fromEntries(KINDS.map(k => [k, 0])), kindHours: Object.fromEntries(KINDS.map(k => [k, 0])) }));
    const reasons = { time: 0, five_hour: 0, seven_day: 0, slots: 0, evidence: 0 };
    const quotaLimit = 100 - config.reserve;
    if (!inv.machines.length || !days.some(d => d.hours)) return { fits: Object.values(pending).every(n => n === 0), done, initial, pending, daily, reasons, accounts: [] };
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      if (!day.hours) continue;
      for (let at = day.start; at < day.end; at += STEP) {
        for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= at) {
          const job = active.splice(i, 1)[0];
          done[job.kind]++; daily[job.day].completed[job.kind]++;
          job.machine.active.splice(job.machine.active.indexOf(job), 1);
        }
        for (const a of accountById.values()) for (const w of Object.values(a.windows)) {
          if (w.reset !== null && at >= w.reset) {
            w.used = 0;
            w.reset = w.duration === 5 * HOUR ? null : w.reset + (Math.floor((at - w.reset) / w.duration) + 1) * w.duration;
          }
        }
        for (const kind of KINDS) {
          let searching = true;
          while (pending[kind] > 0 && searching) {
            searching = false;
            const candidates = machines.filter(m => m.active.length < m.max && m.active.filter(j => j.kind === kind).length < m.slots[kind]);
            if (!candidates.length) reasons.slots++;
            candidates.sort((a, b) => a.active.length / a.max - b.active.length / b.max);
            for (const machine of candidates) {
              const account = accountById.get(machine.account), cost = account.costs[kind];
              if (!cost.ready) { reasons.evidence++; continue; }
              const duration = Math.ceil(cost.minutes / 15) * STEP;
              if (at + duration > day.end) { reasons.time++; continue; }
              if (account.windows.five_hour.used + cost.fiveHour > quotaLimit + 1e-9) { reasons.five_hour++; continue; }
              if (account.windows.seven_day.used + cost.weekly > quotaLimit + 1e-9) { reasons.seven_day++; continue; }
              account.windows.five_hour.reset ??= at + 5 * HOUR;
              account.windows.five_hour.used += cost.fiveHour;
              account.windows.seven_day.used += cost.weekly;
              account.peak = Math.max(account.peak, account.windows.seven_day.used);
              const job = { kind, machine, day: di, end: at + duration };
              machine.active.push(job); active.push(job); pending[kind]--;
              daily[di].busyHours += duration / HOUR;
              daily[di].kindHours[kind] += duration / HOUR;
              searching = true; break;
            }
          }
        }
      }
      // Jobs ending exactly at closing time count as completed that day.
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= day.end) {
        const job = active.splice(i, 1)[0]; done[job.kind]++; daily[job.day].completed[job.kind]++;
        job.machine.active.splice(job.machine.active.indexOf(job), 1);
      }
    }
    const unsupported = config.includeQueue && (source?.unsupportedBacklog || 0) > 0;
    return { fits: !unsupported && KINDS.every(k => done[k] === initial[k]), done, initial, pending, daily, reasons,
      accounts: [...accountById.values()].map(a => ({ id: a.id, peak: a.peak })) };
  }
  function searchMaximum(check) {
    if (!check(0)) return 0;
    let low = 0, high = LIMIT + 1;
    while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (check(mid)) low = mid; else high = mid; }
    return low;
  }
  function evaluate(source, settings, expansion = false, now = Date.now()) {
    const config = { ...DEFAULTS, ...settings };
    if (!validConfig(config)) throw Error('Ungültige Planungsannahmen.');
    const inv = inventory(source, config, expansion, now), requested = demand(config);
    const result = simulate(source, config, inv, requested, now);
    const maximum = searchMaximum(n => simulate(source, config, inv, demand(config, n), now).fits);
    const remaining = Object.fromEntries(['newsletter', 'correction', 'upload'].map(kind => [kind,
      result.fits ? searchMaximum(n => simulate(source, config, inv, { ...requested, [kind]: requested[kind] + n }, now).fits) : 0]));
    const duration = result.daily.reduce((s, d) => s + d.busyHours, 0), capacity = result.daily.reduce((s, d) => s + d.capacityHours, 0);
    const manual = inv.accounts.some(a => Object.values(a.costs).some(c => c.manual));
    const required = KINDS.filter(k => result.initial[k] > 0 || k === 'newsletter'
      || (k === 'correction' && config.correctionsPerNewsletter > 0) || (k === 'upload' && config.uploadsPerNewsletter > 0));
    const missing = required.filter(k => !inv.machines.some(m => m.slots[k] > 0 && inv.accounts.find(a => a.id === m.account)?.costs[k].ready));
    const bottleneck = missing.length ? 'Messbasis' : Object.entries(result.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || 'time';
    const calibratedAccounts = inv.accounts.filter(a => required.every(k => a.costs[k].ready)).length;
    return { ...result, requested, maximum, remaining, manual, missing, bottleneck, utilization: capacity ? duration / capacity : 0,
      calibratedAccounts, quotaPeak: Math.max(0, ...result.accounts.map(a => a.peak)),
      machines: inv.machines.length, accountsCount: inv.accounts.length, excluded: inv.excluded, missingReference: inv.missingReference,
      sourceFresh: inv.sourceFresh, limited: maximum >= LIMIT, inventory: inv,
      ready: inv.machines.length > 0 && !missing.length && !inv.missingReference && inv.sourceFresh && (!config.includeQueue || source?.backlogFresh === true) && !(source?.unsupportedBacklog && config.includeQueue) };
  }
  return { DEFAULTS, KINDS, validConfig, calendar, costsFor, inventory, demand, simulate, evaluate };
});
