// Public account observations only. Codex auth material never belongs in Fleet.
const MAX_AGE_MS = 10 * 60 * 1000;
function validateCodexAccount(raw, now = Date.now()) {
  if (raw == null) return undefined;
  const fail = () => { throw Error('Ungültige Codex-Account-Meldung'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !['ready', 'not_configured', 'limited', 'error'].includes(raw.status)
    || !Array.isArray(raw.windows) || raw.windows.length > 2) fail();
  const text = (value, max) => {
    if (value == null) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max
      || /[\x00-\x1f\x7f]|(?:sk-|refresh_token|access_token|Bearer\s)/i.test(value)) fail();
    return value.trim();
  };
  const date = (value, observation = false) => {
    if (value == null) return undefined;
    if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))
      || (observation && Date.parse(value) > now + 30000)) fail();
    return new Date(value).toISOString();
  };
  const accountId = text(raw.accountId, 160), name = text(raw.name, 160), email = text(raw.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail();
  const updatedAt = date(raw.updatedAt, true), checkedAt = date(raw.checkedAt, true);
  const kinds = new Set();
  const windows = raw.windows.map(window => {
    if (!['session', 'weekly'].includes(window?.kind) || kinds.has(window.kind)
      || typeof window.percent !== 'number' || !Number.isFinite(window.percent)
      || window.percent < 0 || window.percent > 100) fail();
    kinds.add(window.kind);
    return { kind: window.kind, percent: window.percent, reset: date(window.reset) };
  });
  if (raw.status === 'ready' && (!accountId || !updatedAt || !windows.length)) fail();
  if (raw.status === 'not_configured' && (windows.length || accountId)) fail();
  return { status: raw.status, accountId, name, email, updatedAt, checkedAt,
    windows, error: text(raw.error, 300) };
}

function publicCodexAccount(raw, now = Date.now()) {
  if (!raw) return undefined;
  const age = now - Date.parse(raw.updatedAt);
  return { ...raw, stale: !Number.isFinite(age) || age < -30000 || age > MAX_AGE_MS };
}

function codexTelemetry(raw, now = Date.now()) {
  const account = publicCodexAccount(raw, now);
  const bound = Boolean(account?.accountId && account.status !== 'not_configured');
  const name = account?.email || account?.name || 'Codex';
  const usageError = account?.error || (account?.status === 'error' ? 'Codex-Kontingente konnten nicht geprüft werden' : undefined);
  const stale = account?.stale ?? true;
  const status = usageError ? 'error' : !bound || !account.windows.length ? 'unavailable' : stale ? 'stale' : 'fresh';
  return {
    codexAccount: account,
    accounts: bound ? [{ accountId: account.accountId, name, email: account.email, provider: 'codex',
      usageUpdatedAt: account.updatedAt, usageError, usageStale: stale, usageStatus: status }] : [],
    limits: bound ? account.windows.map(window => ({ accountId: account.accountId, accountName: name,
      label: window.kind === 'weekly' ? 'Woche' : 'Sitzung', kind: window.kind, percent: window.percent,
      resetsAt: window.reset, usageUpdatedAt: account.updatedAt, usageError,
      usageStale: stale, usageStatus: status })) : [],
    monitoringAccountId: bound ? account.accountId : null,
    monitoringAccountStatus: bound ? 'connected' : 'notConfigured',
    usageUpdatedAt: account?.updatedAt, usageError, usageStale: stale, usageStatus: status,
    // A stale native Claude login must never become this worker's quota source.
    claudeAccounts: undefined, accountProvisioning: undefined,
  };
}

module.exports = { validateCodexAccount, publicCodexAccount, codexTelemetry, MAX_AGE_MS };
