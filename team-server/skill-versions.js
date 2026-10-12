// Public release metadata only; the RS-Skills installer owns content and sync.
const SHA = /^[a-f0-9]{40}$/;
const SKILL = /^[a-z][a-z0-9-]{0,79}$/;
const SYNC_FRESH_MS = 180000;
function validateSkillRelease(raw, now = Date.now()) {
  if (raw == null) return undefined;
  const fail = () => { throw new Error('Ungültiger Skill-Stand'); };
  if (typeof raw.revision !== 'string' || !SHA.test(raw.revision) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 40) fail();
  if (typeof raw.checkedAt !== 'string' || typeof raw.publishedAt !== 'string') fail();
  const checked = Date.parse(raw.checkedAt), published = Date.parse(raw.publishedAt);
  if (!Number.isFinite(checked) || !Number.isFinite(published) || checked > now + 30000 || published > checked + 30000) fail();
  const ids = new Set();
  const items = raw.items.map(item => {
    if (!item || typeof item.id !== 'string' || !SKILL.test(item.id) || ids.has(item.id)
      || typeof item.version !== 'string' || !/^V\d{1,6}\.\d{1,6}$/.test(item.version)
      || typeof item.tree !== 'string' || !SHA.test(item.tree)) fail();
    ids.add(item.id);
    return { id: item.id, version: item.version, tree: item.tree };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { revision: raw.revision, publishedAt: new Date(published).toISOString(), checkedAt: new Date(checked).toISOString(), items };
}
function newerSkillRelease(current, candidate) {
  if (!candidate) return current;
  if (!current || Date.parse(candidate.publishedAt) > Date.parse(current.publishedAt)
    || (candidate.revision === current.revision && Date.parse(candidate.checkedAt) > Date.parse(current.checkedAt))) return candidate;
  // Commits can share a timestamp. A later sync may advance the package, but
  // never let a lower per-skill version replace the known latest reference.
  if (candidate.revision !== current.revision && candidate.publishedAt === current.publishedAt) {
    const number = v => v.slice(1).split('.').map(Number);
    const old = new Map(current.items.map(item => [item.id, number(item.version)]));
    let advanced = false;
    for (const item of candidate.items) {
      const previous = old.get(item.id); if (!previous) { advanced = true; continue; }
      const next = number(item.version), delta = next[0] - previous[0] || next[1] - previous[1];
      if (delta < 0) return current;
      if (delta > 0) advanced = true;
    }
    if (advanced) return candidate;
  }
  return current;
}
function skillReleaseFresh(release, now = Date.now()) {
  const at = Date.parse(release?.checkedAt);
  return Number.isFinite(at) && now - at <= SYNC_FRESH_MS && at <= now + 30000;
}
module.exports = { validateSkillRelease, newerSkillRelease, skillReleaseFresh };
