// Read durable checkpoint metadata only. Never restore files, acquire ownership,
// reopen a question, or commission a retry while displaying a blocker.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
const clean = (s, n = 500) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '';
const cache = new Map();
export const PM_FIELD_ID = 'c266c259-3eb9-47d4-b108-3232d6bbd7a7';
export function currentPm(task) {
  const fields = (task.custom_fields || []).filter(f => f.id === PM_FIELD_ID && f.type === 'users');
  if (fields.length !== 1 || !Array.isArray(fields[0].value)) return {};
  const users = fields[0].value.filter(u => u && /^\d+$/.test(String(u.id)) && clean(u.username, 100));
  return users.length === 1 ? { pmOwner: clean(users[0].username, 100), pmOwnerId: String(users[0].id) } : {};
}
export function blockerContext(detail, { state, technical = false } = {}) {
  const reason = clean(detail);
  let reasonCode = 'blocker_review_required', responsibleRole = 'Zuständigkeit ungeklärt', nextStep = 'Gesicherten Originalbefund prüfen und die zuständige Rolle für die Behebung festlegen.';
  if (/Kunde fehlt im RS Hub|noch nicht als Kunde|Kunden-Onboarding|Designbasis.*nicht freigegeben|Design.Library.*nicht freigegeben/i.test(reason)) {
    reasonCode = 'customer_setup_incomplete'; responsibleRole = 'PM und Design'; nextStep = 'Designbasis freigeben und Kunden-Onboarding abschließen; danach den Auftrag gezielt fortsetzen.';
  } else if (/Produktfeed fehlt|Feed[^.;]*nicht gibt|kein[^.;]*Feed|Feed[^.;]*fehlt/i.test(reason)) {
    reasonCode = 'product_feed_missing'; responsibleRole = 'Klaviyo-Technik'; nextStep = 'Den beauftragten Produktfeed einrichten und den gespeicherten Draft prüfen; offene fachliche Vorgaben mit dem aktuellen PM klären.';
  } else if (/Platzhalter|Angebotswerte fehlen/i.test(reason)) {
    reasonCode = 'approved_content_incomplete'; responsibleRole = 'PM'; nextStep = 'Fehlende Angebotswerte in der Quelle klären und intern korrigieren lassen; erst danach Upload erneut beauftragen.';
  } else if (/Endabnahme|QA.*(?:fehlgeschlagen|nicht bestanden)|Fixrunden/i.test(reason)) {
    reasonCode = 'quality_review_failed'; responsibleRole = 'Design und QA'; nextStep = 'Offene Muss-Punkte anhand des gespeicherten Prüfberichts korrigieren und erneut abnehmen lassen.';
  } else if (technical || state === 'technisch_blockiert') {
    reasonCode = 'technical_blocker'; responsibleRole = 'Technik'; nextStep = 'Technischen Originalbefund beheben und den betroffenen Schritt mit den vorhandenen Belegen prüfen.';
  }
  return { blockerReason: reason || 'Der gespeicherte Vorgang enthält noch keinen lesbaren Blockergrund.',
    reasonCode: reason ? reasonCode : 'blocker_context_missing', responsibleRole, nextStep };
}
export function checkpointBlocker(entry) {
  const cacheKey = [entry.digest, entry.run_id, entry.task_id, entry.producer].join(':');
  try {
    if (typeof entry.packed !== 'string' || entry.packed.length > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.digest)
      || crypto.createHash('sha256').update(entry.packed).digest('hex') !== entry.digest) throw Error('digest');
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const bytes = Buffer.from(entry.packed, 'base64');
    const raw = zlib.brotliDecompressSync(bytes.subarray(0, 7).equals(Buffer.from('RSART2\0')) ? bytes.subarray(7) : bytes, { maxOutputLength: 32 * 1024 * 1024 });
    const value = JSON.parse(raw);
    if (![1, 2].includes(value.schema) || value.producer !== entry.producer || value.runId !== entry.run_id) throw Error('identity');
    const run = value.runs?.find(v => v.run?.run_id === entry.run_id)?.run;
    if (!run || run.task_id !== entry.task_id) throw Error('task');
    const result = { ...blockerContext(run.detail || run.pause_detail, { state: run.state }),
      blockerRecordedAt: run.finished_at || run.paused_since || run.queued_at,
      blockerSource: 'checkpoint', blockerSourceRunId: entry.run_id, blockerSourceHash: entry.digest };
    cache.set(cacheKey, result); if (cache.size > 128) cache.delete(cache.keys().next().value);
    return result;
  } catch { return { blockerReason: 'Blockerbefund im gesicherten Vorgang kann nicht verifiziert gelesen werden.',
    reasonCode: 'blocker_context_unreadable', responsibleRole: 'Technik', nextStep: 'Integrität und Format des gesicherten Vorgangs prüfen; Arbeitsstand erhalten.' }; }
}
export function applyBlockerContexts(rows, tasks, now = Date.now()) {
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  for (const row of rows) {
    if (row.status !== 'blocked') continue;
    const taskId = row.url?.match(/^https:\/\/app\.clickup\.com\/t\/([^/?#]+)/)?.[1];
    const pm = byId.has(taskId) ? currentPm(byId.get(taskId)) : {};
    // Fresh source only. Never inherit old assignees or a previous PM snapshot.
    delete row.pmOwner; delete row.pmOwnerId;
    Object.assign(row, pm);
    row.pmCheckedAt = new Date(now).toISOString();
    // A workflow name proves no technical cause. Preserve unknown ownership
    // until an actual worker state or structured PM journal supplies it.
    if (!row.reasonCode) Object.assign(row, blockerContext(row.blockedReason));
    const cause = clean(row.blockerReason || row.blockedReason, 200), who = clean(row.responsibleRole, 60);
    row.blockedReason = clean(`Gesicherter Befund: ${cause} · Zuständig: ${who}${pm.pmOwner ? ' (PM: ' + pm.pmOwner + ')' : ' (PM nicht zugeordnet)'} · Nächster Schritt: ${clean(row.nextStep, 160)}`);
  }
  return rows;
}
