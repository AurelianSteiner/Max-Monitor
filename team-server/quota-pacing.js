// Kontingent-Takt für alle Claude-Pläne (Till, 21.10.2026). Rein und ohne
// require: Max Monitor übernimmt diese Datei unverändert für die Vorschau.
//
// Ein Account (Claude-Plan) soll sein Wochenbudget gleichmäßig bis kurz vor dem
// Reset ausgeben, kein 5-Stunden-Fenster soll an 100 % stoßen, und bei gleichen
// Prozenten bekommt jeder Mac erst eine Aufgabe, dann zwei, dann drei.
//
//   Pace-Linie: Anteil der erwarteten Arbeit des Zyklus [Reset − 168 h,
//   Reset − 18 h], gewichtet mit Bürozeiten (Mo–Fr 08–20 Uhr Berlin = 1, sonst
//   0,1). target = 100 · Anteil; g = Wochenverbrauch − target (±40 pp).
//   Schlüssel je Mac und Art: Last + min über zulässige Accounts von
//   (g + 0,25 · 5h-Verbrauch · Nähe) / 10. 10 pp Vorsprung vor dem Takt wiegen
//   eine Aufgabe; gleiche Prozente ergeben genau die Last (1, 2, 3 …).
//   Sperren je Account (nie überbrückt): 5h-Planung bis 90 % mit einer
//   Standardabweichung Reserve für laufende und neue Arbeit (nach 60 Minuten
//   Wartezeit bis 100 %, die Reserve bleibt), Woche bis 100 % mit 1,6
//   Standardabweichungen, weiche Obergrenze und Vorausstufe für Accounts, die
//   dem eigenen Takt und dem Flottenmittel weit voraus sind; mehr als 30 Punkte
//   vor dem eigenen Takt bremst die weiche Obergrenze auch eine Flotte, die
//   insgesamt vorausläuft (90 % mit Reset in fünf Tagen: 6 → 2, 3 → 1).
// Laufende Arbeit zählt mit ihrem erwarteten Restverbrauch (lognormale
// Restlaufzeit). Preise sind Planungswerte, nie Messwerte: eigene Messung
// (n ≥ 3) zur Flotte hin geschrumpft, sonst Flottenmittel, sonst Festwerte.

const HOUR = 3600000, MINUTE = 60000;

const PACING = {
  cycleH: 168, marginH: 18,
  gClamp: 40, lambda: 10, mu5: 0.25, tau5H: 1, keyEps: 0.1,
  c5: 90, z5: 1, ageMin: 60, ageC5: 100,
  cW: 100, zW: 1.6,
  leadL1: 10, absLead: 20, tierLA: 48, patienceMin: 15, tierRel: 10,
  freshMin: 15, shrinkN0: 10, remFloor: 0.1,
};

// Planungswerte je Art aus den Messungen der Flotte vom 21.10.2026 (pp je Lauf);
// Dauer der Claude-Arbeit lognormal (Median in Minuten, sigma).
const FALLBACK = {
  newsletter: { five_hour_pp: { mean: 10.43, sd: 4.05 }, weekly_pp: { mean: 1.40, sd: 0.66 }, median: 68, sigma: 0.34 },
  correction: { five_hour_pp: { mean: 5.36, sd: 2.80 }, weekly_pp: { mean: 0.77, sd: 0.38 }, median: 41, sigma: 0.74 },
  upload: { five_hour_pp: { mean: 2.83, sd: 1.19 }, weekly_pp: { mean: 0.53, sd: 0.25 }, median: 18, sigma: 0.56 },
  translation: { five_hour_pp: { mean: 5.36, sd: 2.80 }, weekly_pp: { mean: 0.77, sd: 0.38 }, median: 41, sigma: 0.74 },
  sales: { five_hour_pp: { mean: 12.5, sd: 3.0 }, weekly_pp: { mean: 2.2, sd: 0.6 }, median: 55, sigma: 0.3 },
};
const METRICS = ['five_hour_pp', 'weekly_pp'];

function costKind(kind) {
  const name = ({ korrektur: 'correction', klaviyo: 'upload' })[kind] || kind;
  return Object.hasOwn(FALLBACK, name) ? name : 'newsletter';
}

function measured(metric) {
  return Boolean(metric) && Number.isInteger(metric.n) && metric.n >= 3 && Number.isFinite(metric.mean) && metric.mean > 0
    && metric.mean <= 100 && Number.isFinite(metric.sd) && metric.sd >= 0 && metric.sd <= 100;
}

// n-gewichtetes Flottenmittel je Art und Fenster aus allen gemessenen Accounts.
function fleetPrices(costTables) {
  const prices = {};
  for (const kind of Object.keys(FALLBACK)) {
    prices[kind] = {};
    for (const name of METRICS) {
      let n = 0, sum = 0, squares = 0;
      for (const costs of costTables) {
        const metric = costs?.[kind]?.[name];
        if (!measured(metric)) continue;
        n += metric.n; sum += metric.n * metric.mean;
        squares += metric.n * (metric.sd ** 2 + metric.mean ** 2);
      }
      prices[kind][name] = n >= 3
        ? { mean: sum / n, sd: Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) }
        : FALLBACK[kind][name];
    }
  }
  return prices;
}

function priceOf(costs, prices, kind, name) {
  const fleet = prices[kind][name], own = costs?.[kind]?.[name];
  if (!measured(own)) return fleet;
  const w = own.n / (own.n + PACING.shrinkN0);
  return { mean: w * own.mean + (1 - w) * fleet.mean, sd: w * own.sd + (1 - w) * fleet.sd };
}

function meanMinutes(kind) {
  const d = FALLBACK[kind];
  return d.median * Math.exp(d.sigma * d.sigma / 2);
}

// Standardnormalverteilung (Abramowitz-Stegun 7.1.26, Fehler < 1,5e-7).
function normal(x) {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Erwarteter Restanteil eines Laufs nach elapsed Minuten: mittlere Restlaufzeit
// der lognormalen Dauer geteilt durch ihren Mittelwert (Verbrauch ~ Zeit).
function remainingShare(kind, elapsedMin) {
  if (!(elapsedMin > 0)) return 1;
  const { median, sigma } = FALLBACK[kind];
  const mu = Math.log(median), mean = Math.exp(mu + sigma * sigma / 2);
  const z = (Math.log(elapsedMin) - mu) / sigma, tail = 1 - normal(z);
  if (tail < 1e-6) return PACING.remFloor;
  const residual = mean * normal(sigma - z) / tail - elapsedMin;
  return Math.max(PACING.remFloor, Math.min(3, residual / mean));
}

// Streuung des Verbrauchs vor einem Reset: endet der Lauf vorher (f = 1), die
// des ganzen Laufs; schneidet ihn der Reset (f → 0), die der Verbrauchsrate.
function spread(price, kind, f) {
  const cost = price.sd / price.mean, sigma = FALLBACK[kind].sigma;
  const rate = Math.sqrt(cost * cost + Math.exp(sigma * sigma) - 1);
  return cost + (1 - Math.min(1, Math.max(0, f))) * (rate - cost);
}

// Europe/Berlin ohne Intl: MEZ, Sommerzeit vom letzten Märzsonntag bis zum
// letzten Oktobersonntag jeweils 01:00 UTC.
function lastSunday(year, month) {
  const end = Date.UTC(year, month + 1, 0, 1);
  return end - new Date(end).getUTCDay() * 24 * HOUR;
}
const WEIGHTS = new Map();
function officeWeight(hourIndex) {
  if (WEIGHTS.has(hourIndex)) return WEIGHTS.get(hourIndex);
  const at = hourIndex * HOUR + 30 * MINUTE, year = new Date(at).getUTCFullYear();
  const summer = at >= lastSunday(year, 2) && at < lastSunday(year, 9);
  const local = new Date(at + (summer ? 2 : 1) * HOUR);
  const day = local.getUTCDay(), hour = local.getUTCHours();
  const weight = day >= 1 && day <= 5 && hour >= 8 && hour < 20 ? 1 : 0.1;
  if (WEIGHTS.size > 5000) WEIGHTS.clear();
  WEIGHTS.set(hourIndex, weight);
  return weight;
}
function profileWeight(fromMs, toMs) {
  let total = 0;
  for (let at = fromMs; at < toMs;) {
    const next = Math.min(toMs, (Math.floor(at / HOUR) + 1) * HOUR);
    total += officeWeight(Math.floor(at / HOUR)) * (next - at) / HOUR;
    at = next;
  }
  return total;
}
// Anteil der erwarteten Arbeit des Wochenzyklus, der bis atMs vergangen ist.
function paceShare(atMs, resetMs) {
  const start = resetMs - PACING.cycleH * HOUR, end = resetMs - PACING.marginH * HOUR;
  if (atMs >= end) return 1;
  if (atMs <= start) return 0;
  return profileWeight(start, atMs) / profileWeight(start, end);
}

function clampGap(value) {
  return Math.max(-PACING.gClamp, Math.min(PACING.gClamp, value));
}

// Fenster eines Account-Platzes nach der Uhr nowMs. Ein vergangener Reset
// setzt den Verbrauch auf 0 (der Anbieter hat das Fenster geleert); älter als
// freshMin Minuten heißt unbekannt.
function windowsOf(slot, nowMs) {
  const at = slot?.at;
  if (!Number.isFinite(at) || nowMs - at > PACING.freshMin * MINUTE || at - nowMs > MINUTE) return null;
  const valid = w => w && Number.isFinite(w.used) && w.used >= 0 && w.used <= 100 && (w.reset === null || Number.isFinite(w.reset));
  const five = slot.five_hour, week = slot.seven_day;
  if (!valid(five) || !valid(week) || !Number.isFinite(week.reset)) return null;
  let weekReset = week.reset, weekUsed = week.used;
  if (weekReset <= nowMs) {
    weekUsed = 0;
    while (weekReset <= nowMs) weekReset += PACING.cycleH * HOUR;
  }
  if (weekReset - nowMs > (PACING.cycleH + 1) * HOUR) return null;
  const fivePassed = five.reset !== null && five.reset <= nowMs;
  return {
    u5: fivePassed ? 0 : five.used,
    r5: fivePassed || five.reset === null ? null : (five.reset - nowMs) / HOUR,
    uW: weekUsed, resetW: weekReset,
  };
}

// Analyse aller Account-Plätze der Flotte.
// macs: [{ worker, maxTasks, slots: [{ slot, status, at, five_hour:{used,reset}, seven_day:{used,reset}, costs? }],
//          runs: [{ slot, kind, started }] }]  (Zeiten in ms; runs ohne slot zählen auf keinen Platz)
// → Map worker → [Analyse je Platz]
function analyseFleet(macs, nowMs) {
  const records = [], groups = new Map(), result = new Map();
  const credentialKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? 'credential:' + value : null;
  const credentialProofs = new Map();
  for (const mac of macs) for (const slot of mac.slots || []) {
    const credential = credentialKey(slot.credentialGroup), identity = quotaIdentityKey(slot.identity, nowMs);
    if (!credential || !identity) continue;
    if (!credentialProofs.has(credential)) credentialProofs.set(credential, new Set());
    credentialProofs.get(credential).add(identity);
  }
  const providerAlias = credential => credentialProofs.get(credential)?.size === 1 ? [...credentialProofs.get(credential)][0] : null;
  for (const mac of macs) {
    const entries = [];
    for (const slot of mac.slots || []) {
      const credential = credentialKey(slot.credentialGroup), credentialConflict = credentialProofs.get(credential)?.size > 1;
      const identity = quotaIdentityKey(slot.identity, nowMs) || providerAlias(credential);
      const key = identity || credential || Symbol('unverified-local-slot');
      const entry = { slot: slot.slot, worker: mac.worker, cap: Number.isInteger(mac.maxTasks) ? mac.maxTasks : 6,
        costs: slot.costs || null, known: false, blocked: slot.status === 'limited' || slot.status === 'error', runs: 0 };
      if (identity) Object.assign(entry, { identity, identityKnown: true });
      if (credential) Object.assign(entry, { groupKey: key, groupSource: identity ? 'provider' : 'credential',
        identityKnown: Boolean(identity), credentialConflict: Boolean(credentialConflict) });
      const record = { mac, slot, entry, key, identity, credentialConflict };
      records.push(record); entries.push(entry);
      if (!groups.has(key)) groups.set(key, { records: [], runs: [], identity, shared: Boolean(identity || credential) });
      groups.get(key).records.push(record);
    }
    result.set(mac.worker, entries);
  }
  // A physical owner remains bound to the credential it actually started with.
  // Unknown owners are hypotheses on this Mac's possible accounts, not a newly
  // invented provider identity. Missing IDs are deliberately never deduplicated.
  for (const mac of macs) for (const run of mac.runs || []) {
    const credential = credentialKey(run.credentialGroup);
    const runProvider = (validQuotaIdentity(run.identity) ? quotaIdentityKey(run.identity, Math.min(nowMs, Date.parse(run.identity.verifiedAt))) : null)
      || providerAlias(credential);
    const pinned = runProvider || credential;
    let targets;
    // Contradictory access proofs cannot identify an owner, but each named
    // provider remains a concrete possible cost scope; never merge its gauges.
    if (pinned) targets = [...new Set([...(groups.has(pinned) ? [groups.get(pinned)] : []),
      ...(!runProvider ? [...(credentialProofs.get(credential) || [])].filter(key => groups.has(key)).map(key => groups.get(key)) : []),
      ...records.filter(record => record.mac === mac && (!runProvider || !record.identity)).map(record => groups.get(record.key))])];
    else {
      const local = records.filter(record => record.mac === mac);
      const unknownBinding = Object.hasOwn(run, 'identity') || Object.hasOwn(run, 'credentialGroup');
      targets = [...new Set(local.filter(record => unknownBinding || run.slot === record.slot.slot)
        .map(record => groups.get(record.key)))];
    }
    for (const group of targets) group.runs.push({ ...run, unknownBinding: Boolean(runProvider) ? !group.identity : Boolean(group.shared) });
  }
  // A measured account's cost table must not gain artificial sample weight
  // merely because the same account is installed on more than one Mac.
  for (const group of groups.values()) {
    const costs = group.records.map(record => record.slot.costs).filter(Boolean);
    const count = table => Object.values(table).reduce((sum, row) => sum + METRICS.reduce((n, name) => n + (measured(row?.[name]) ? row[name].n : 0), 0), 0);
    group.costs = costs.sort((a, b) => count(b) - count(a) || JSON.stringify(a).localeCompare(JSON.stringify(b)))[0] || null;
  }
  const prices = fleetPrices([...groups.values()].map(group => group.costs).filter(Boolean));
  const knownGroups = [];
  for (const group of groups.values()) {
    const observations = group.records.map(record => ({ ...record, windows: windowsOf(record.slot, nowMs) }));
    const usable = observations.filter(record => record.windows && !record.credentialConflict && (!group.shared || record.slot.status !== 'error')).sort((a, b) => b.slot.at - a.slot.at
      || b.windows.u5 - a.windows.u5 || b.windows.uW - a.windows.uW || a.entry.worker.localeCompare(b.entry.worker));
    const basis = usable[0];
    let conflict = false, blocked = false;
    if (group.shared) {
      if (basis) for (const other of usable.slice(1)) {
        for (const name of ['five_hour', 'seven_day']) {
          const a = basis.slot[name]?.reset, b = other.slot[name]?.reset;
          if (Number.isFinite(a) && Number.isFinite(b) && a > nowMs && b > nowMs && Math.abs(a - b) > 1000) conflict = true;
        }
      }
      const fresh = observations.filter(record => {
        if (record.credentialConflict) return false;
        const at = Object.hasOwn(record.slot, 'statusAt') ? record.slot.statusAt : record.slot.at;
        return Number.isFinite(at) && nowMs - at >= -MINUTE && (nowMs - at <= PACING.freshMin * MINUTE
          || Number.isFinite(record.slot.blockedUntil) && record.slot.blockedUntil > nowMs);
      });
      blocked = conflict || fresh.some(record => {
        const slot = record.slot;
        if (slot.status !== 'limited') return false;
        if (Number.isFinite(slot.blockedUntil)) return slot.blockedUntil > nowMs;
        const limiting = ['five_hour', 'seven_day'].map(name => slot[name]).filter(window => window?.used >= 100);
        return !limiting.length || limiting.some(window => !Number.isFinite(window.reset) || window.reset > nowMs);
      });
    } else blocked = group.records[0].entry.blocked;
    const windows = !conflict && basis?.windows;
    const totals = { pend5: 0, var5: 0, pendW: 0, varW: 0 }, identified = new Map(), anonymous = [];
    if (windows) for (const run of group.runs) {
      const kind = costKind(run.kind), elapsed = Number.isFinite(run.started) ? (nowMs - run.started) / MINUTE : 0;
      const rest = remainingShare(kind, elapsed), hoursLeft = Math.max(5, rest * meanMinutes(kind)) / 60;
      const f = windows.r5 === null ? 1 : Math.min(1, windows.r5 / hoursLeft);
      const p5 = priceOf(group.costs, prices, kind, 'five_hour_pp'), pW = priceOf(group.costs, prices, kind, 'weekly_pp');
      const cost = { pend5: p5.mean * rest * f, var5: (spread(p5, kind, f) * p5.mean * rest * f) ** 2,
        pendW: pW.mean * rest, varW: (pW.sd * rest) ** 2, unknown: run.unknownBinding };
      if (typeof run.id === 'string' && /^(?:ordinary|sales|knowledge):[A-Za-z0-9][A-Za-z0-9._@:-]{0,289}$/.test(run.id)) {
        const previous = identified.get(run.id);
        identified.set(run.id, previous ? { ...Object.fromEntries(Object.keys(totals).map(key => [key, Math.max(previous[key], cost[key])])),
          unknown: previous.unknown || cost.unknown } : cost);
      } else anonymous.push(cost);
    }
    const costs = [...identified.values(), ...anonymous];
    for (const cost of costs) for (const key of Object.keys(totals)) totals[key] += cost[key];
    for (const record of group.records) {
      const entry = record.entry;
      Object.assign(entry, { prices, costs: group.costs, known: Boolean(windows),
        blocked: blocked || group.shared && record.slot.status === 'error' || Boolean(record.credentialConflict), runs: costs.length });
      if (group.shared) Object.assign(entry, { sharedMembers: group.records.length, gaugeConflict: conflict,
        pendingUnknown: costs.some(cost => cost.unknown), gaugeAt: basis?.slot.at ?? null });
      if (!windows) continue;
      Object.assign(entry, windows, totals);
      const target = 100 * paceShare(nowMs, entry.resetW);
      Object.assign(entry, { target, targetAhead: 100 * paceShare(nowMs + PACING.tierLA * HOUR, entry.resetW),
        g: clampGap(entry.uW - target), gFull: clampGap(entry.uW + entry.pendW - target),
        near: entry.r5 === null ? 1 : Math.min(1, entry.r5 / PACING.tau5H) });
    }
    if (windows) knownGroups.push(group);
  }
  const mean = knownGroups.length ? knownGroups.reduce((sum, group) => sum + group.records[0].entry.gFull, 0) / knownGroups.length : 0;
  for (const group of knownGroups) for (const record of group.records) {
    const entry = record.entry;
    entry.relLead = entry.gFull - mean;
    const lead = Math.max(Math.min(entry.gFull, entry.relLead), entry.gFull - PACING.absLead);
    entry.softTarget = lead > PACING.leadL1
      ? Math.max(1, Math.floor(entry.cap * Math.exp(-(lead - PACING.leadL1) / PACING.leadL1))) : Infinity;
  }
  return result;
}

function slotRefusal(entry, kind, { extra = [], waitedMs = 0, accepting = false } = {}) {
  if (entry.blocked) return 'limited';
  if (!entry.known) return null;
  if (entry.runs + extra.length >= entry.softTarget) return 'soft_cap';
  let pend5 = entry.pend5, var5 = entry.var5, pendW = entry.pendW, varW = entry.varW;
  for (const next of [...extra, kind].map(costKind)) {
    const hours = meanMinutes(next) / 60;
    const f = entry.r5 === null ? 1 : Math.min(1, entry.r5 / hours);
    const p5 = priceOf(entry.costs, entry.prices, next, 'five_hour_pp'), pW = priceOf(entry.costs, entry.prices, next, 'weekly_pp');
    pend5 += p5.mean * f; var5 += (spread(p5, next, f) * p5.mean * f) ** 2;
    pendW += pW.mean; varW += (spread(pW, next, 1) * pW.mean) ** 2;
  }
  const waitedMin = waitedMs / MINUTE;
  // Lange wartende Arbeit darf das Fenster weiter füllen, aber nie ohne Reserve.
  if (entry.u5 + pend5 + PACING.z5 * Math.sqrt(var5) > (waitedMin >= PACING.ageMin ? PACING.ageC5 : PACING.c5)) return 'guard_5h';
  if (entry.uW + pendW + PACING.zW * Math.sqrt(varW) > PACING.cW) return 'guard_weekly';
  if (entry.uW + pendW > entry.targetAhead && entry.relLead > PACING.tierRel && !accepting && waitedMin < PACING.patienceMin) return 'paced';
  return null;
}

// Vorzug eines Platzes in der Flottenreihenfolge (nur Beobachtungen, damit
// gleiche Prozente exakt nach Last verteilen).
function slotPreference(entry) {
  return entry.known ? entry.g + PACING.mu5 * entry.u5 * entry.near : 0;
}

// Wahl des Accounts beim Prozessstart: kleinster Vorsprung plus geplantes
// 5h-Volumen; Gleichstand → der früher zurückgesetzte 5h-Platz.
function slotChoiceKey(entry, extra = []) {
  if (!entry.known) return 0;
  let pend5 = entry.pend5;
  for (const next of extra.map(costKind)) pend5 += priceOf(entry.costs, entry.prices, next, 'five_hour_pp').mean;
  return entry.g + PACING.mu5 * (entry.u5 + pend5) * entry.near;
}
function plannedForSlot(entries, entry, extra) {
  const key = entry.groupKey || entry.identity;
  const slots = key ? entries.filter(other => (other.groupKey || other.identity) === key).map(other => other.slot) : [entry.slot];
  return [...new Set(slots)].flatMap(slot => extra.get(slot) || []);
}

function chooseSlot(entries, kind, { extra = new Map(), waitedMs = 0 } = {}) {
  let best = null;
  for (const entry of entries || []) {
    const planned = plannedForSlot(entries, entry, extra);
    if (slotRefusal(entry, kind, { extra: planned, waitedMs })) continue;
    // Bekannte Plätze vor unbekannten; unter bekannten der kleinste Schlüssel.
    const rank = entry.known ? 0 : 1, key = slotChoiceKey(entry, planned), reset = entry.r5 ?? Infinity;
    if (!best || rank < best.rank || rank === best.rank && (key < best.key - 1e-9 || Math.abs(key - best.key) <= 1e-9 && reset < best.reset)) {
      best = { slot: entry.slot, entry, key, reset, rank };
    }
  }
  return best;
}

// Schlüssel eines Macs für einen Auftrag der Art kind: Last plus Vorzug des
// besten zulässigen Platzes in Aufgaben-Einheiten. Ohne bekannte Plätze zählt
// nur die Last (bisherige Gleichverteilung). → { key, slot } oder { refusal }
function macKey(entries, load, kind, { extra = new Map(), waitedMs = 0 } = {}) {
  let best = null, open = false, refusal = null;
  for (const entry of entries || []) {
    const why = slotRefusal(entry, kind, { extra: plannedForSlot(entries, entry, extra), waitedMs });
    if (why) { refusal ??= why; continue; }
    if (!entry.known) { open = true; continue; }
    const preference = slotPreference(entry);
    if (!best || preference < best.preference) best = { preference, slot: entry.slot };
  }
  // Ein zulässiger Platz ohne bekannten Stand ist neutral (Vorzug 0).
  if (best && !(open && best.preference > 0)) return { key: load + best.preference / PACING.lambda, slot: best.slot };
  if (open || !(entries || []).length) return { key: load, slot: null };
  return { refusal: refusal || 'limited' };
}

// Prüft die Kontingentplätze eines Betriebsnachweises (quota_slots). Läuft auch
// auf dem Hub (per toString() ins Skript kopiert): ohne Hilfsfunktionen außerhalb.
function validQuotaIdentity(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'account,organization,provider,schema,source,verifiedAt'
    && value.schema === 1 && value.provider === 'anthropic'
    && typeof value.account === 'string' && /^[0-9a-f]{64}$/.test(value.account)
    && typeof value.organization === 'string' && /^[0-9a-f]{64}$/.test(value.organization)
    && ['oauth-profile', 'oauth-validate'].includes(value.source)
    && typeof value.verifiedAt === 'string' && value.verifiedAt.length <= 40 && Number.isFinite(Date.parse(value.verifiedAt));
}
function quotaIdentityKey(value, nowMs) {
  if (!validQuotaIdentity(value)) return null;
  const age = nowMs - Date.parse(value.verifiedAt);
  return age >= -30000 && age <= 24 * 60 * 60000 ? `anthropic:${value.account}:${value.organization}` : null;
}

function validQuotaSlots(value) {
  const time = t => typeof t === 'string' && t.length <= 40 && Number.isFinite(Date.parse(t));
  const windowOk = w => Boolean(w) && typeof w === 'object' && !Array.isArray(w) && Object.keys(w).sort().join(',') === 'reset,used'
    && typeof w.used === 'number' && Number.isFinite(w.used) && w.used >= 0 && w.used <= 100 && (w.reset === null || time(w.reset));
  return Array.isArray(value) && value.length >= 1 && value.length <= 2
    && new Set(value.map(s => s?.slot)).size === value.length
    && value.every(s => Boolean(s) && typeof s === 'object' && !Array.isArray(s)
      && Object.keys(s).every(key => ['at', 'five_hour', 'runs', 'seven_day', 'slot', 'status', 'identity', 'credentialGroup', 'blockedUntil', 'statusAt'].includes(key))
      && ['at', 'five_hour', 'runs', 'seven_day', 'slot', 'status'].every(key => Object.hasOwn(s, key))
      && (!Object.hasOwn(s, 'identity') || s.identity === null || validQuotaIdentity(s.identity))
      && (!Object.hasOwn(s, 'credentialGroup') || s.credentialGroup === null || typeof s.credentialGroup === 'string' && /^[0-9a-f]{64}$/.test(s.credentialGroup))
      && (!Object.hasOwn(s, 'blockedUntil') || s.blockedUntil === null || time(s.blockedUntil))
      && (!Object.hasOwn(s, 'statusAt') || time(s.statusAt))
      && ['single', 'primary', 'account-2'].includes(s.slot) && ['ready', 'limited', 'error', 'unknown'].includes(s.status)
      && time(s.at) && windowOk(s.five_hour) && windowOk(s.seven_day) && s.seven_day.reset !== null
      && Array.isArray(s.runs) && s.runs.length <= 12
      && s.runs.every(r => Boolean(r) && typeof r === 'object' && !Array.isArray(r)
        && Object.keys(r).every(key => ['kind', 'started', 'id', 'identity', 'credentialGroup'].includes(key))
        && Object.hasOwn(r, 'kind') && Object.hasOwn(r, 'started')
        && (!Object.hasOwn(r, 'id') || typeof r.id === 'string' && r.id.length <= 300 && /^(?:ordinary|sales|knowledge):[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(r.id))
        && (!Object.hasOwn(r, 'identity') || r.identity === null || validQuotaIdentity(r.identity))
        && (!Object.hasOwn(r, 'credentialGroup') || r.credentialGroup === null || typeof r.credentialGroup === 'string' && /^[0-9a-f]{64}$/.test(r.credentialGroup))
        && ['newsletter', 'correction', 'upload', 'translation', 'sales'].includes(r.kind)
        && (time(r.started) || r.started === null && (Object.hasOwn(r, 'id') || Object.hasOwn(r, 'identity') || Object.hasOwn(r, 'credentialGroup')))));
}

// Flottenstand → Eingabe von analyseFleet. fleet: Betriebsnachweise vom Hub
// ({ worker_id, max_tasks?, quota_slots?, quota? }); quota ist die Zeile aus dem
// Max-Monitor-Snapshot (Sekunden), quota_slots der eigene Stand des Macs (ISO).
// jobs: aktive Reservierungen [{ worker, kind }] für Macs ohne quota_slots.
// own: { worker, maxTasks, slots, runs } ersetzt den eigenen Eintrag (ms).
function fleetMacs(fleet, { jobs = [], own = null } = {}) {
  const ms = t => typeof t === 'string' ? Date.parse(t) : null;
  const macs = [];
  for (const mac of fleet || []) {
    const worker = mac?.worker_id;
    if (typeof worker !== 'string' || own?.worker === worker) continue;
    const maxTasks = Number.isInteger(mac.max_tasks) ? mac.max_tasks : null;
    const quota = mac.quota?.schema === 1 ? mac.quota : null;
    if (validQuotaSlots(mac.quota_slots)) {
      macs.push({ worker, maxTasks, slots: mac.quota_slots.map(s => ({ slot: s.slot, status: s.status, at: ms(s.at),
        ...(Object.hasOwn(s, 'identity') ? { identity: s.identity } : {}),
        ...(Object.hasOwn(s, 'credentialGroup') ? { credentialGroup: s.credentialGroup } : {}),
        ...(Object.hasOwn(s, 'blockedUntil') ? { blockedUntil: ms(s.blockedUntil) } : {}),
        ...(Object.hasOwn(s, 'statusAt') ? { statusAt: ms(s.statusAt) } : {}),
        five_hour: { used: s.five_hour.used, reset: ms(s.five_hour.reset) },
        seven_day: { used: s.seven_day.used, reset: ms(s.seven_day.reset) },
        // Gemessene Preise gibt es nur für den an Max Monitor gebundenen Account.
        costs: s.slot === 'single' ? quota?.costs || null : null })),
      runs: mac.quota_slots.flatMap(s => s.runs.map(r => ({ slot: s.slot, kind: r.kind, started: ms(r.started),
        ...(Object.hasOwn(r, 'id') ? { id: r.id } : {}), ...(Object.hasOwn(r, 'identity') ? { identity: r.identity } : {}),
        ...(Object.hasOwn(r, 'credentialGroup') ? { credentialGroup: r.credentialGroup } : {}) }))) });
      continue;
    }
    const five = quota?.windows?.five_hour, week = quota?.windows?.seven_day;
    const seconds = v => Number.isFinite(v) ? v * 1000 : null;
    const at = Math.min(seconds(five?.at) ?? Infinity, seconds(week?.at) ?? Infinity);
    const slots = five && week && Number.isFinite(at) ? [{ slot: 'single', at,
      status: ['ready', 'limited', 'error'].includes(quota.status) ? quota.status : 'ready',
      five_hour: { used: five.used, reset: seconds(five.reset) }, seven_day: { used: week.used, reset: seconds(week.reset) },
      costs: quota.costs || null }] : [];
    macs.push({ worker, maxTasks, slots,
      runs: slots.length ? jobs.filter(job => job?.worker === worker).map(job => ({ slot: 'single', kind: job.kind, started: null })) : [] });
  }
  if (own) macs.push(own);
  return macs;
}

module.exports = { PACING, FALLBACK, analyseFleet, slotRefusal, chooseSlot, macKey, paceShare, remainingShare, costKind, fleetPrices,
  validQuotaIdentity, quotaIdentityKey, validQuotaSlots, fleetMacs };
