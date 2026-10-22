// Independent worker-token observations; never merge these with app login data.
function validateClaudeAccounts(raw) {
  if (raw == null) return undefined;
  const fail = () => { throw Error('Ungültige Claude-Account-Meldung'); };
  const ids = new Set();
  if (!Array.isArray(raw.accounts) || raw.accounts.length !== 2) fail();
  const accounts = raw.accounts.map(a => {
    if (!['primary','account-2'].includes(a?.id) || ids.has(a.id)
      || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 160
      || /[\x00-\x1f\x7f]|sk-ant-/i.test(a.name)
      || !['ready','limited','error','unknown'].includes(a.status) || !Array.isArray(a.windows) || a.windows.length > 2) fail();
    ids.add(a.id);
    const kinds = new Set();
    const date = value => value == null ? undefined : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fail();
    const email = typeof a.email === 'string' ? a.email.trim() : undefined;
    if (a.email != null && (!email || email.length > 254 || /[\x00-\x1f\x7f]|sk-ant-/i.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail();
    return { id:a.id, name:email ? email.slice(0,email.indexOf('@')) : a.name.trim(), ...(email ? {email} : {}), status:a.status, updatedAt:date(a.updatedAt), blockedUntil:date(a.blockedUntil),
      windows:a.windows.map(w => {
        if (!['session','weekly'].includes(w?.kind) || kinds.has(w.kind) || typeof w.percent !== 'number'
          || !Number.isFinite(w.percent) || w.percent < 0 || w.percent > 100) fail();
        kinds.add(w.kind); return {kind:w.kind,percent:w.percent,reset:date(w.reset)};
      }) };
  });
  if (!ids.has(raw.selectedAccountId)) fail();
  const reasons=['Account hat freies Kontingent','Account mit freiem Kontingent','Wochenreset naht · verbleibendes Budget nutzen','Beide Accounts am Limit · wartet auf Reset','Kontingente werden geprüft','Gleichmäßige Auslastung beider Accounts'];
  return { selectedAccountId:raw.selectedAccountId,accounts,...(reasons.includes(raw.selectionReason)?{selectionReason:raw.selectionReason}:{}) };
}
function publicClaudeAccounts(raw, now) {
  if (!raw) return undefined;
  return { ...raw, accounts:raw.accounts.map(a => ({...a,
    stale: !Number.isFinite(Date.parse(a.updatedAt)) || now-Date.parse(a.updatedAt)>10*60000 || Date.parse(a.updatedAt)>now+30000,
  })) };
}
module.exports = { validateClaudeAccounts, publicClaudeAccounts };
