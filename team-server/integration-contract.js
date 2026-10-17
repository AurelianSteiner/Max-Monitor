// Bounded public evidence only. Capability health is independent of liveness.
const SHA = /^[a-f0-9]{40,64}$/;
const MCP_FRESH_MS = 10 * 60 * 1000;
const text = (value, limit = 80) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const revision = value => typeof value === 'string' && SHA.test(value) ? value : undefined;
function validateCapabilities(raw, now = Date.now()) {
  if (raw == null) return undefined;
  const at = typeof raw.checkedAt === 'string' ? Date.parse(raw.checkedAt) : NaN;
  if (raw.schema !== 'rs-hub-capabilities/v1' || !Number.isFinite(at) || at > now + 30000
    || typeof raw.connected !== 'boolean'
    || !(typeof raw.fullAccess === 'boolean' || (!raw.connected && raw.fullAccess === null))
    || !(typeof raw.writesEnabled === 'boolean' || (!raw.connected && raw.writesEnabled === null))
    || !['all-customers', 'restricted', 'unknown'].includes(raw.scope)
    || (raw.toolCount != null && (!Number.isInteger(raw.toolCount) || raw.toolCount < 0 || raw.toolCount > 1000))
    || (raw.version != null && !text(raw.version))
    || (raw.releaseRevision != null && !revision(raw.releaseRevision))
    || !(raw.connected && raw.reasonCode === null)
      && (!text(raw.reasonCode) || !/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(raw.reasonCode))) return undefined;
  const contracts = raw.contracts && typeof raw.contracts === 'object' && !Array.isArray(raw.contracts)
    ? Object.fromEntries(['incidents', 'blockers', 'release'].filter(key => Number.isInteger(raw.contracts[key])
      && raw.contracts[key] >= 1 && raw.contracts[key] <= 100).map(key => [key, raw.contracts[key]])) : undefined;
  return { schema: raw.schema, checkedAt: new Date(at).toISOString(), connected: raw.connected,
    fullAccess: raw.fullAccess, writesEnabled: raw.writesEnabled, scope: raw.scope,
    ...(raw.version === undefined ? {} : { version: raw.version }),
    ...(raw.toolCount === undefined ? {} : { toolCount: raw.toolCount }),
    ...(raw.releaseRevision === undefined ? {} : { releaseRevision: raw.releaseRevision }),
    reasonCode: raw.reasonCode, ...(contracts && Object.keys(contracts).length ? { contracts } : {}) };
}
function publicCapabilities(receipt, now = Date.now()) {
  if (!receipt) return undefined;
  const at = Date.parse(receipt.checkedAt);
  const fresh = Number.isFinite(at) && now - at <= MCP_FRESH_MS && at <= now + 30000;
  return { ...receipt, fresh, ready: Boolean(fresh && receipt.connected && receipt.fullAccess && receipt.writesEnabled
    && receipt.scope === 'all-customers'
    && ['incidents', 'blockers', 'release'].every(key => receipt.contracts?.[key] === 1)) };
}
function newerCapabilities(current, candidate) {
  if (!candidate) return current;
  return !current || Date.parse(candidate.checkedAt) > Date.parse(current.checkedAt) ? candidate : current;
}
function validateIntegrationContract(raw, now = Date.now()) {
  if (raw?.schema !== 1 || !revision(raw.worker?.revision) || !text(raw.worker?.version)
    || (raw.skills?.revision != null && !revision(raw.skills.revision))
    || (raw.skills?.contractDigest != null && !/^[a-f0-9]{64}$/.test(raw.skills.contractDigest))) return undefined;
  const receipt = validateCapabilities(raw.rsHubMcp, now);
  return { schema: 1, worker: { revision: raw.worker.revision, version: raw.worker.version },
    ...(raw.skills ? { skills: { ...(raw.skills.revision ? { revision: raw.skills.revision } : {}),
      ...(raw.skills.contractDigest ? { contractDigest: raw.skills.contractDigest } : {}) } } : {}),
    ...(receipt ? { rsHubMcp: receipt } : {}) };
}
module.exports = { validateCapabilities, publicCapabilities, newerCapabilities, validateIntegrationContract, MCP_FRESH_MS };
