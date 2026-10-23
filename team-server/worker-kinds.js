// Worker purpose is an operator-owned identity setting, never inferred from a login.
const KINDS = Object.freeze({
  newsletter: Object.freeze({ workerKind: 'newsletter', provider: 'claude',
    allowedWorkflows: Object.freeze(['newsletter', 'upload', 'translation', 'correction', 'sales']) }),
  'codex-repair': Object.freeze({ workerKind: 'codex-repair', provider: 'codex',
    allowedWorkflows: Object.freeze(['technical-repair', 'customer-onboarding']) }),
});

function workerProfile(workerId) {
  const kind = require('./worker-identities.json')[workerId]?.workerKind || 'newsletter';
  // An invalid explicit profile must never silently admit newsletter work.
  return KINDS[kind] || { workerKind: 'unknown', provider: null, allowedWorkflows: [] };
}

function allowsWorkflow(workerId, workflow) {
  const profile = workerProfile(workerId);
  return workflow == null ? profile.workerKind === 'newsletter' : profile.allowedWorkflows.includes(workflow);
}

module.exports = { KINDS, workerProfile, allowsWorkflow };
