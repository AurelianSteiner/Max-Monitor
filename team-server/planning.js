'use strict';
const { workerProfile } = require('./worker-kinds');
function planningEvidence(summary, fleet) {
  const visible = new Set((fleet?.machines || []).filter(machine => workerProfile(machine.workerId).provider === 'claude')
    .map(machine => machine.workerId).filter(Boolean));
  const accounts = new Map();
  for (const [worker, quota] of Object.entries(summary?.scheduling?.workers || {})) {
    if (!visible.has(worker) || !quota.account) continue;
    const account = accounts.get(quota.account) || { id: quota.account, windows: {} };
    for (const name of ['five_hour', 'seven_day']) {
      const value = quota.windows?.[name];
      if (value && (!account.windows[name] || value.at > account.windows[name].at)) account.windows[name] = value;
    }
    accounts.set(quota.account, account);
  }
  return { generated_at: summary?.generated_at || null, accounts: [...accounts.values()], averages: summary?.by_kind || [] };
}
module.exports = { planningEvidence };
