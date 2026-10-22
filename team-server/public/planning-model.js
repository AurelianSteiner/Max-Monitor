'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MaxMonitorPlanningModel = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const KINDS = ['newsletter', 'correction', 'upload'];
  const zero = () => Object.fromEntries(KINDS.map(k => [k, 0]));
  const fresh = (at, now, age) => Number.isFinite(at) && at <= now + 60000 && now - at <= age;
  function capacity(source, mode = 'current', period = 'day', now = Date.now()) {
    const accounts = new Map();
    for (const account of source?.accounts || []) accounts.set(account.id, account);
    const budgets = { fiveHour: 0, weekly: 0 }, costs = {};
    const current = value => Number.isFinite(value?.used) && value.used >= 0 && value.used <= 100
      && fresh(value.at * 1000, now, 900000)
      && (Number.isFinite(value.reset) && value.reset * 1000 > now || value.used === 0 && value.reset === null);
    let counted = 0;
    for (const account of accounts.values()) {
      const windows = [['fiveHour', 'five_hour'], ['weekly', 'seven_day']].map(([key, window]) => [key, account.windows?.[window]]);
      // A silent or retired Mac's account without both current windows is left
      // out of current capacity: it neither blocks the panel nor counts as unused.
      if (mode !== 'full' && !windows.every(([, value]) => current(value))) continue;
      for (const [key, value] of windows) budgets[key] += mode === 'full' ? 100 : 100 - value.used;
      counted += 1;
    }
    let available = fresh(Date.parse(source?.generated_at), now, 180000) && counted > 0;
    // Same Max plan on every account: exactly the shared means from Verbrauch.
    // Day is a daily rate within the seven-day allowance. The 5-hour limit
    // constrains that same pace; it is not an extra daily allowance.
    for (const kind of KINDS) {
      const average = source?.averages?.find(row => row.key === kind);
      const fiveHour = average?.five_hour_pp?.mean, weekly = average?.weekly_pp?.mean;
      if (![fiveHour, weekly].every(n => Number.isFinite(n) && n > 0)) available = false;
      costs[kind] = { fiveHour: fiveHour * 5 / (period === 'day' ? 24 : 168), weekly: weekly * (period === 'day' ? 7 : 1) };
    }
    return { available, budgets, costs, accounts: accounts.size, skipped: accounts.size - counted, mode, period };
  }
  function maximum(cap, kind, mix = zero()) {
    if (!cap.available) return 0;
    return Math.max(0, Math.floor(Math.min(...['fiveHour', 'weekly'].map(window => {
      const spent = KINDS.reduce((sum, key) => sum + (key === kind ? 0 : (mix[key] || 0) * cap.costs[key][window]), 0);
      return (cap.budgets[window] - spent + 1e-9) / cap.costs[kind][window];
    }))));
  }
  function initial(cap) { return { newsletter: maximum(cap, 'newsletter'), correction: 0, upload: 0 }; }
  function balance(cap, selected, changed) {
    const count = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const mix = Object.fromEntries(KINDS.map(k => [k, count(selected[k])]));
    mix.newsletter = Math.min(mix.newsletter, maximum(cap, 'newsletter'));
    if (changed === 'correction') {
      mix.correction = Math.min(mix.correction, maximum(cap, 'correction', { ...mix, upload: 0 }));
      mix.upload = maximum(cap, 'upload', mix);
    } else {
      // First try one upload per newsletter, bounded by actual headroom.
      mix.upload = Math.min(changed === 'newsletter' ? mix.newsletter : mix.upload,
        maximum(cap, 'upload', { ...mix, correction: 0 }));
      mix.correction = maximum(cap, 'correction', mix);
    }
    return mix;
  }
  function usage(cap, mix) {
    if (!cap.available) return { percent: 0, shares: zero() };
    const totals = Object.fromEntries(['fiveHour', 'weekly'].map(window => [window,
      KINDS.reduce((sum, k) => sum + mix[k] * cap.costs[k][window], 0)]));
    const window = totals.fiveHour / (cap.budgets.fiveHour || 1) > totals.weekly / (cap.budgets.weekly || 1) ? 'fiveHour' : 'weekly';
    const shares = Object.fromEntries(KINDS.map(k => [k, cap.budgets[window] ? mix[k] * cap.costs[k][window] / cap.budgets[window] * 100 : 0]));
    return { percent: Math.min(100, Object.values(shares).reduce((a, b) => a + b, 0)), shares };
  }
  return { KINDS, capacity, maximum, initial, balance, usage };
});
