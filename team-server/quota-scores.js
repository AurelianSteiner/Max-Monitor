// Pure scheduling preference, serialized unchanged into the Sales Hub call.
// Percent points belong to an account, not to the Mac or a fixed token amount.
function quotaScores({ candidates, peers = candidates, jobs = [], kind, nowMs }) {
  const fresh = (at, maxAge) => {
    const t = typeof at === 'number' ? at * 1000 : Date.parse(at);
    return Number.isFinite(t) && nowMs - t >= -60000 && nowMs - t <= maxAge;
  };
  const valid = q => q?.schema === 1 && typeof q.account === 'string' && q.account.length <= 100 && fresh(q.generated_at, 180000);
  const windowOf = (q, name) => {
    if (!valid(q)) return null;
    const w = q.windows?.[name];
    if (!w || !Number.isFinite(w.used) || w.used < 0 || w.used > 100 || !fresh(w.at, 900000)) return null;
    // A zero, inactive 5h window legitimately has no reset timestamp.
    if (w.reset === null && name === 'five_hour' && w.used === 0) return w;
    const horizon = name === 'seven_day' ? 7 * 86400000 : 5 * 3600000;
    return Number.isFinite(w.reset) && w.reset * 1000 > nowMs && w.reset * 1000 - nowMs <= horizon + 3600000 ? w : null;
  };
  const metricName = name => name === 'seven_day' ? 'weekly_pp' : 'five_hour_pp';
  const metric = (q, taskKind, name) => {
    const m = q?.costs?.[taskKind]?.[metricName(name)];
    return Number.isInteger(m?.n) && m.n >= 3 && Number.isFinite(m.mean) && m.mean > 0 && m.mean <= 100
      && Number.isFinite(m.sd) && m.sd >= 0 && m.sd <= 100 ? m : null;
  };
  const byWorker = new Map(peers.filter(p => valid(p.quota)).map(p => [p.worker, p.quota]));
  const pending = (q, name) => {
    let points = 0;
    for (const peer of peers) {
      if (byWorker.get(peer.worker)?.account !== q.account) continue;
      const current = jobs.filter(j => j.worker === peer.worker);
      for (const job of current) points += metric(q, job.kind, name)?.mean || 0;
      // Sales, previews and browser leases can occupy physical places without a
      // newsletter claim. Use the largest measured mean of this account only.
      const fallback = Math.max(0, ...Object.keys(q.costs || {}).map(k => metric(q, k, name)?.mean || 0));
      points += Math.max(0, peer.load - current.length) * fallback;
    }
    return points;
  };
  let informed = false;
  const rows = candidates.map(candidate => {
    const q = candidate.quota;
    const row = { worker: candidate.worker, score: 0, blocked: false, windows: {}, load: candidate.load, cap: candidate.maxTasks };
    for (const name of ['five_hour', 'seven_day']) {
      const w = windowOf(q, name);
      if (!w) continue;
      informed = true;
      const m = metric(q, kind, name);
      const remaining = Math.max(0, 100 - w.used - pending(q, name));
      // Three completed measurements, variance plus one whole point of rounding
      // margin. With fewer samples we do not invent a per-task cost or reject fit.
      const estimatedCost = m ? Math.min(100, m.mean + 2 * m.sd + 1) : null;
      if (w.used >= 100 || estimatedCost !== null && remaining < estimatedCost) row.blocked = true;
      row.windows[name] = { remaining_pp: remaining, expected_pp: estimatedCost, n: m?.n || 0 };
      if (name === 'seven_day') {
        row.account = q.account;
        // Aim to use the budget by 18h before reset, while retaining a 6h floor
        // so a very near reset cannot dominate all other accounts indefinitely.
        row.budget_per_hour = remaining / Math.max(6, (w.reset * 1000 - nowMs) / 3600000 - 18);
      }
    }
    return row;
  });
  if (!informed) return null; // Existing even-load rule, not a new outage gate.
  const budgets = [...new Map(rows.filter(r => !r.blocked && r.budget_per_hour > 0)
    .map(r => [r.account, r.budget_per_hour])).values()].sort((a, b) => a - b);
  const reference = budgets.length ? budgets[Math.floor(budgets.length / 2)] : 1;
  for (const row of rows) {
    const weekly = row.budget_per_hour === undefined ? .5 : row.budget_per_hour / (row.budget_per_hour + reference);
    const session = row.windows.five_hour ? row.windows.five_hour.remaining_pp / 100 : .5;
    const free = Math.max(0, 1 - (row.load + 1) / Math.max(1, row.cap));
    row.score = .55 * weekly + .20 * session + .25 * free;
    row.mode = Object.keys(row.windows).length === 2 ? 'quota' : 'partial';
  }
  return rows;
}

module.exports = { quotaScores };
