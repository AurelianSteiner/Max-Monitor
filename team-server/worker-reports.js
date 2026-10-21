// Direct local observations. No provider credentials or arbitrary log output.
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const { DEVICE_ID } = require('./worker-control');
const { validateSkillRelease, skillReleaseFresh } = require('./skill-versions');
const { validateCapabilities, publicCapabilities, validateIntegrationContract } = require('./integration-contract');
const { validateClaudeAccounts, publicClaudeAccounts } = require('./claude-accounts');
const FRESH_MS = 45000;
function validateReport(raw, now = Date.now()) {
  const fail = () => { throw new Error('Ungültiger Worker-Bericht'); };
  if (!raw || raw.schema !== 1 || !ID.test(raw.workerId) || !raw.service || !raw.activity) fail();
  if (raw.deviceId != null && (typeof raw.deviceId !== 'string' || !DEVICE_ID.test(raw.deviceId))) fail();
  const at = Date.parse(raw.sampledAt);
  if (!Number.isFinite(at) || now - at > 90000 || at > now + 30000) fail();
  const text = (value, max, required = false) => {
    if (value == null && !required) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
    return value.trim();
  };
  const date = value => value == null ? undefined : Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fail();
  if (typeof raw.service.running !== 'boolean' || typeof raw.activity.acceptingTasks !== 'boolean'
    || !['idle', 'busy', 'unknown'].includes(raw.activity.state) || !Array.isArray(raw.activity.runs) || raw.activity.runs.length > 50) fail();
  const ids = new Set();
  const runs = raw.activity.runs.map(run => {
    const id = text(run.id, 240, true);
    if (ids.has(id) || !['newsletter', 'upload', 'translation', 'correction', 'sales'].includes(run.workflow)
      || !['running', 'queued'].includes(run.status)) fail();
    ids.add(id);
    if (run.progress != null && (!Number.isInteger(run.progress) || run.progress < 0 || run.progress > 100)) fail();
    const url = text(run.url, 2000);
    if (url) { let parsed; try { parsed = new URL(url); } catch { fail(); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(); }
    return { id, runId: text(run.runId, 160, true), title: text(run.title, 300, true), workflow: run.workflow,
      status: run.status, url, progress: run.progress ?? undefined, step: text(run.step, 160) };
  });
  // The worker's own admission count and maximum (src/mac-capacity.js): every
  // place holder, also browser jobs, previews and transfers without a run row.
  // Optional: older workers do not send them.
  const places = value => value == null ? undefined : Number.isInteger(value) && value >= 0 && value <= 50 ? value : fail();
  const occupiedTasks = places(raw.activity.occupiedTasks);
  const maxTasks = places(raw.activity.maxTasks);
  // Idle is a positive observation, never the absence of a queue assignment.
  if (raw.activity.state === 'idle' && (!raw.service.running || runs.length || occupiedTasks > 0 || now - Date.parse(raw.service.lastPollAt) > 180000
    || !Number.isFinite(Date.parse(raw.service.lastPollAt)))) fail();
  const maintenance = raw.maintenance;
  if (maintenance && typeof maintenance.ok !== 'boolean') fail();
  let figmaAccount;
  if (raw.figmaAccount != null) {
    const email = text(raw.figmaAccount.email, 254, true);
    const observedAt = date(raw.figmaAccount.observedAt);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !observedAt
      || Date.parse(observedAt) > now + 30000 || !['worker-whoami', 'mcp-whoami'].includes(raw.figmaAccount.source)) fail();
    figmaAccount = { email, observedAt, source: raw.figmaAccount.source };
  }
  return { schema: 1, workerId: raw.workerId, deviceId: raw.deviceId, sampledAt: new Date(at).toISOString(), receivedAt: new Date(now).toISOString(),
    claudeAccounts: validateClaudeAccounts(raw.claudeAccounts),
    workerVersion: text(raw.workerVersion, 80), workerRevision: text(raw.workerRevision, 80),
    skillRelease: validateSkillRelease(raw.skillRelease, now),
    ...(figmaAccount ? { figmaAccount } : {}),
    // Optional integration telemetry must never discard an otherwise valid poll.
    rsHubMcp: validateCapabilities(raw.rsHubMcp, now),
    integrationContract: validateIntegrationContract(raw.integrationContract, now),
    service: { running: raw.service.running, lastPollAt: date(raw.service.lastPollAt) },
    activity: { state: raw.activity.state, acceptingTasks: raw.activity.acceptingTasks, runs,
      ...(occupiedTasks === undefined ? {} : { occupiedTasks }), ...(maxTasks === undefined ? {} : { maxTasks }) },
    maintenance: maintenance ? { ok: maintenance.ok, checkedAt: date(maintenance.checkedAt), summary: text(maintenance.summary, 300, true) } : undefined,
  };
}
function publicReport(report, now = Date.now()) {
  if (!report) return {};
  const fresh = now - Date.parse(report.sampledAt) <= FRESH_MS && now - Date.parse(report.receivedAt) <= FRESH_MS;
  return { agentLastSeenAt: report.receivedAt, agentStatus: fresh ? 'online' : 'silent',
    ...(report.claudeAccounts ? {claudeAccounts:publicClaudeAccounts(report.claudeAccounts,now)} : {}),
    ...(report.figmaAccount ? { figmaAccount: report.figmaAccount } : {}),
    ...(report.workerVersion || report.workerRevision ? { workerVersion: report.workerVersion, workerRevision: report.workerRevision,
      workerVersionObservedAt: report.sampledAt, workerVersionSource: 'worker-observer' } : {}),
    ...(report.rsHubMcp ? { rsHubMcp: publicCapabilities(report.rsHubMcp, now) } : {}),
    ...(report.integrationContract ? { integrationContract: { ...report.integrationContract,
      ...(report.integrationContract.rsHubMcp ? { rsHubMcp: publicCapabilities(report.integrationContract.rsHubMcp, now) } : {}) } } : {}),
    activity: { ...report.activity, fresh, sampledAt: report.sampledAt }, service: report.service, maintenance: report.maintenance,
    ...(report.skillRelease ? { skillRelease: { ...report.skillRelease, fresh: fresh && skillReleaseFresh(report.skillRelease, now) } } : {}) };
}
module.exports = { validateReport, publicReport, FRESH_MS, ID };
