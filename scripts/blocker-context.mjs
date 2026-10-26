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
// Fehleraudit 19.10.2026 (Smileypack/Klingele24): an empty or doubly filled PM
// field is no missing assignment. Display only; currentPm stays the one owner.
export function pmFieldState(task) {
  const fields = (task?.custom_fields || []).filter(f => f.id === PM_FIELD_ID && f.type === 'users');
  if (fields.length !== 1) return { read: false, names: [] };
  const users = Array.isArray(fields[0].value) ? fields[0].value.filter(u => u && /^\d+$/.test(String(u.id)) && clean(u.username, 100)) : [];
  return { read: true, names: users.map(u => clean(u.username, 100)) };
}
function pmCaption(task, pm) {
  if (pm.pmOwner) return ` (PM: ${pm.pmOwner})`;
  const field = task ? pmFieldState(task) : { read: false, names: [] };
  if (field.read && !field.names.length) return ' (PM-Feld leer)';
  // Bounded, so the next step always fits into the 500 characters.
  if (field.names.length > 1) return ` (PM-Feld nicht eindeutig: ${clip(field.names.slice(0, 3).map(name => name.replace(/[()]/g, '')).join(', '), 100)})`;
  return ' (PM nicht zugeordnet)';
}

// Fehleraudit 19.10.2026: the worker's typed owner of a finished run (Hub
// reservation `owner`, #ai-fehler metadata). Roles without a standalone "PM"
// never reach the PM channel (pm-owner.mjs isPmQuestion).
export const BLOCKER_OWNERS = new Set(['pm', 'onboarding', 'stammdaten', 'technik', 'automatisch']);
export const STAMMDATEN_ROLE = 'Stammdaten (RS Hub/ClickUp)';
const SETUP_STEP = 'Designbasis im RS Hub freigeben bzw. Kundenakte mit diesem ClickUp-Ordner anlegen (oder Auftragsausnahme eintragen); danach den Auftrag neu beauftragen.';
const TECHNICAL_STEP = 'Technischen Originalbefund beheben und den betroffenen Schritt mit den vorhandenen Belegen prüfen.';
const OWNER_CONTEXT = {
  pm: { reasonCode: 'pm_decision_pending', responsibleRole: 'PM', blockerKind: 'waiting_human',
    nextStep: 'Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.' },
  onboarding: { reasonCode: 'customer_setup_incomplete', responsibleRole: 'PM und Design', blockerKind: 'waiting_human', nextStep: SETUP_STEP },
  stammdaten: { reasonCode: 'master_data_missing', responsibleRole: STAMMDATEN_ROLE, blockerKind: 'waiting_human',
    nextStep: 'Genannte Angabe im RS Hub bzw. in ClickUp eintragen; danach 🔁 an der Meldung.' },
  technik: { reasonCode: 'technical_blocker', responsibleRole: 'Technik', blockerKind: 'technical_failure', nextStep: TECHNICAL_STEP },
};
OWNER_CONTEXT.automatisch = OWNER_CONTEXT.technik;
// Till, 26.10.2026 (Fehleraudit): a Sales finding the worker typed itself (shop not
// available, not public, no shop) closes the Sales order without production; it is
// no open technical error. Only the Sales job carries it (readLocalSales), never a
// worker reservation or #ai-fehler copy (BLOCKER_OWNERS).
export const SALES_CLOSED_PHASE = 'Abgeschlossen · keine Produktion möglich';
OWNER_CONTEXT.sales = { reasonCode: 'sales_shop_unavailable', responsibleRole: 'Sales', blockerKind: 'withdrawn',
  nextStep: 'Keine Produktion möglich: Der Shop ist nicht nutzbar; der Sales-Auftrag ist fachlich abgeschlossen, kein technischer Schritt.' };
// Owner group of each fallback result. A typed owner keeps a more specific
// result of its own group and replaces any other.
const GROUP = { customer_setup_incomplete: 'onboarding', master_data_missing: 'stammdaten',
  pm_decision_pending: 'pm', pm_source_changed: 'pm', approved_content_incomplete: 'pm',
  technical_blocker: 'technik', preparation_source_changed: 'technik', source_link_changed: 'technik',
  product_feed_missing: 'technik', quality_review_failed: 'technik', sales_shop_unavailable: 'sales' };
const OWNER_GROUP = { pm: 'pm', onboarding: 'onboarding', stammdaten: 'stammdaten', technik: 'technik', automatisch: 'technik', sales: 'sales' };

// The worker's setup predicate (technical-repair.js MISSING_SETUP, worker.js
// missingCustomer). A season design gate is a PM decision, never customer setup.
const SETUP = /Kunde fehlt im RS Hub|noch nicht als Kunde|Kunden-Onboarding|Designbasis.*nicht freigegeben|Design.Library.*nicht freigegeben|(?:keine?|ohne|fehlende?)\s+(?:im RS[- ]Hub\s+)?freigegeben\w*\s+(?:Design\w*|Gestaltung\w*|Library|Basis)|Kunden-?(?:Setup|Onboarding)\s+(?:ist\s+)?(?:noch\s+)?nicht\s+(?:fertig|abgeschlossen|vollständig)|kein RS-Hub-Kunde für ClickUp-Ordner|kein Flow-Ziel/i;
const DESIGN_GATE = /(?:Black[- ]?(?:Week(?:end)?|Friday)|Cyber[- ]?Monday)[^.;]{0,60}(?:Gestaltung|Freigabe|freigegeben|Bausteine)|(?:Gestaltung|Freigabe|Bausteine)[^.;]{0,40}(?:Black[- ]?Week(?:end)?|Cyber[- ]?Monday)/gi;
// Missing Klaviyo key: the Hub's codes count everywhere, the prose only in the
// cause (technical-repair.js KLAVIYO_KEY_CODE/KLAVIYO_KEY_PROSE).
const KLAVIYO_KEY_CODE = /KEY_NOT_SET|klaviyo_key_missing|kein (?:API|Klaviyo)-Schl(?:ü|ue)ssel hinterlegt|No Klaviyo key configured/i;
const KLAVIYO_KEY_PROSE = /(?:Render-|Klaviyo-)Schl(?:ü|ue)ssel(?:\s+(?:für|des|der|im|in)\b(?:(?!\s(?:und|sowie|aber|oder|ok|okay|geprüft|vorhanden|funktionier\w*|gültig|korrekt|-)(?![\wäöüß]))[^.;,:()\n–—]){0,40})?\s+fehlt\b|\bfehlt\s+(?:im RS Hub\s+)?(?:noch\s+)?der\s+(?:Klaviyo-)?(?:Render-|Klaviyo-)Schl(?:ü|ue)ssel|\bFehlende[rn]?\s+(?:Klaviyo-)?(?:Render-|Klaviyo-)Schl(?:ü|ue)ssel/i;
// Hub mappings only a person enters (ai-fehler-policy.js STAMMDATEN).
const STAMMDATEN = /RS-Hub-Stammdaten|widerspricht der bestätigten Kundenzuordnung|im RS[- ]Hub (?:keinem|mehreren) Kunden zugeordnet|genau einen Hub-Bereich ergeben|Klaviyo-Konto nicht eindeutig|Zuordnung im RS Hub einrichten|Website im RS Hub nachtragen/i;
// Till, 19.10.2026 (docs/ablauf.md): a source changed during preparation is no PM
// decision; the old caption „PM-Entscheidung erforderlich“ does not change that.
const PREPARATION_SOURCE = /Aufgabenquelle während der Vorbereitung geändert/i;
const PM_ANSWER_CHANGE = /nach der PM-Antwort geändert(?: \(([^)]*)\))?/i;
const LINK_FIELD = /^(?:Klaviyo[ -]?Link|Freigabe (?:intern|extern)|Filestage[ -]Link(?: (?:intern|extern))?)$/i;
const PM_DECISION = /PM[- ]Entscheidung erforderlich|PM entscheidet|im Aufgabentitel/i;
// Fehleraudit 26.10.2026 (Tomishop Black Week): the worker's fixed prefix of a PM
// question it withdrew after a source change (pm-question-worker.js
// withdrawnQuestionRelease, technical-repair.js PM_QUESTION_WITHDRAWN). Nothing is
// left to answer: the PM commissions again. The worker types its owner 'pm'.
// Like the worker, only at the start of the cause, also of this bridge's own
// rendering (HEAD); a text quoting an earlier attempt's withdrawal stays as it is.
const QUESTION_WITHDRAWN = /^(?:Gesicherter Befund:\s*)?Offene PM-Rückfrage zurückgezogen:/i;
export const questionWithdrawn = text => QUESTION_WITHDRAWN.test(clean(text, 4000));
// Checked access or setup in the "Stand:" section never decides the cause.
const causeOf = reason => reason.split(/(?:^|\s)\**Stand\**\s*:/)[0];

// Nachkontrolle 21.10.2026 (Tomishop 86c95myuv, 86caxdrej): the worker posts a
// customer setup gap with the ❓ status of a decision block, but types its owner
// onboarding; no question is registered and nothing continues by itself until the
// PM commissions again (docs/ablauf.md). Such a ❓ is no PM question. Untyped rows
// follow the worker's setup predicate. → 'onboarding' | 'stammdaten' | null
export function setupOwner(owner, text) {
  if (owner === 'onboarding' || owner === 'stammdaten') return owner;
  return !BLOCKER_OWNERS.has(owner) && SETUP.test(causeOf(clean(text, 4000)).replace(DESIGN_GATE, ' ')) ? 'onboarding' : null;
}
const SETUP_PHASE = { onboarding: 'Blockiert · Kunden-Setup', stammdaten: 'Blockiert · Stammdaten' };

function fallbackContext(reason, state, technical) {
  const cause = causeOf(reason);
  const setupCause = cause.replace(DESIGN_GATE, ' ');
  const change = PM_ANSWER_CHANGE.exec(cause);
  if (QUESTION_WITHDRAWN.test(cause)) return { reasonCode: 'pm_source_changed', responsibleRole: 'PM', blockerKind: 'waiting_human',
    nextStep: 'Rückfrage ist zurückgezogen: den Startstatus in ClickUp erneut setzen; der neue Lauf prüft die aktuelle Quelle.' };
  if (SETUP.test(setupCause)) return { ...OWNER_CONTEXT.onboarding };
  if (PREPARATION_SOURCE.test(cause)) return { reasonCode: 'preparation_source_changed', responsibleRole: 'Technik',
    nextStep: 'Geänderte Angaben aus dem Befund mit der gespeicherten Vorbereitung abgleichen; Arbeitsstand erhalten.' };
  if (change) {
    const fields = String(change[1] || '').split(',').map(field => field.trim()).filter(Boolean);
    // Only link fields changed: possibly the run's own output (Magnethandel 19.10.2026).
    return fields.length && fields.every(field => LINK_FIELD.test(field))
      ? { reasonCode: 'source_link_changed', responsibleRole: 'Technik',
        nextStep: 'Geänderten Link mit der eigenen Ausgabe des Laufs abgleichen (möglicherweise eigener Schreibvorgang); Arbeitsstand erhalten.' }
      : { reasonCode: 'pm_source_changed', responsibleRole: 'PM', blockerKind: 'waiting_human',
        nextStep: 'Geänderte Angabe prüfen: gewollt, dann neu beauftragen; sonst zurücksetzen.' };
  }
  if (PM_DECISION.test(cause)) return { ...OWNER_CONTEXT.pm };
  if (KLAVIYO_KEY_CODE.test(reason) || KLAVIYO_KEY_PROSE.test(cause)) return { ...OWNER_CONTEXT.stammdaten,
    nextStep: 'Privaten Klaviyo-Schlüssel „RS Hub“ (Full Access Key) im Kundenkonto anlegen und im RS Hub beim Kunden speichern; danach 🔁 am blockierten Beitrag.' };
  if (STAMMDATEN.test(cause)) return { ...OWNER_CONTEXT.stammdaten };
  if (/Produktfeed fehlt|Feed[^.;]*nicht gibt|kein[^.;]*Feed|Feed[^.;]*fehlt/i.test(cause)) {
    return { reasonCode: 'product_feed_missing', responsibleRole: 'Klaviyo-Technik', nextStep: 'Den beauftragten Produktfeed einrichten und den gespeicherten Draft prüfen; offene fachliche Vorgaben mit dem aktuellen PM klären.' };
  }
  if (/Platzhalter|Angebotswerte fehlen/i.test(cause)) return { reasonCode: 'approved_content_incomplete', responsibleRole: 'PM', blockerKind: 'waiting_human',
    nextStep: 'Fehlende Angebotswerte in der Quelle klären und intern korrigieren lassen; erst danach Upload erneut beauftragen.' };
  if (/Endabnahme|QA.*(?:fehlgeschlagen|nicht bestanden)|Fixrunden/i.test(cause)) {
    return { reasonCode: 'quality_review_failed', responsibleRole: 'Design und QA', nextStep: 'Offene Muss-Punkte anhand des gespeicherten Prüfberichts korrigieren und erneut abnehmen lassen.' };
  }
  if (technical || state === 'technisch_blockiert') return { reasonCode: 'technical_blocker', responsibleRole: 'Technik', nextStep: TECHNICAL_STEP };
  return { reasonCode: 'blocker_review_required', responsibleRole: 'Zuständigkeit ungeklärt', nextStep: 'Gesicherten Originalbefund prüfen und die zuständige Rolle für die Behebung festlegen.' };
}
export function blockerContext(detail, { state, technical = false, owner } = {}) {
  const reason = clean(detail, 4000);
  let context = fallbackContext(reason, state, technical);
  // The worker decided the owner once at the end of the run (O53); the text
  // patterns above remain the fallback for untyped and older rows.
  if (OWNER_CONTEXT[owner]) {
    context = GROUP[context.reasonCode] === OWNER_GROUP[owner] ? { ...context, blockerKind: OWNER_CONTEXT[owner].blockerKind } : { ...OWNER_CONTEXT[owner] };
  }
  return { blockerReason: clean(reason) || 'Der gespeicherte Vorgang enthält noch keinen lesbaren Blockergrund.',
    ...context, reasonCode: reason ? context.reasonCode : 'blocker_context_missing' };
}

// Fehleraudit 19.10.2026: readable short cause instead of a 200-character cut.
const SUMMARY_MAX = 240;
const SUMMARY_PREFIX = /^(?:Korrekturauftrag nicht vorbereitet|Technische Quellenbindung|Klaviyo-Quellenbindung|PM-Entscheidung erforderlich):\s*/i;
const SECTION = /\s\**(?:Ursachen|Nächste Schritte)\**(?::|\s+(?=\d{1,2}\.\s|•))\s*|\s\**Stand\**:\s*/;
// Ends of sentences; abbreviations (z. B., bzw.) and ordinals (1., 19.) continue.
function sentenceEnds(text) {
  const ends = [];
  for (const match of text.matchAll(/[.!?]+["“”»«')\]]*(?=\s|$)/gu)) {
    const word = /(\S+)$/u.exec(text.slice(0, match.index))?.[1]?.replace(/^[("„“«']+/u, '') ?? '';
    if (/^(?:\p{L}|\d{1,2}|bzw|ca|Nr|inkl|vgl|evtl|ggf|usw|etc|max|min|Str|Abs)$/iu.test(word)) continue;
    ends.push(match.index + match[0].length);
  }
  return ends;
}
export function clip(text, max) {
  if (text.length <= max) return text;
  const sentence = sentenceEnds(text).filter(end => end <= max).at(-1);
  if (sentence >= max / 3) return text.slice(0, sentence);
  const cut = text.slice(0, Math.max(0, max - 2));
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/u, '') + ' …';
}
export function summary(text) {
  let value = clean(text, 4000).replace(SUMMARY_PREFIX, '');
  const brief = /(?:^|\s)\**Kurzfassung\**:?\s+/i.exec(value);
  if (brief) value = value.slice(brief.index + brief[0].length);
  value = value.split(SECTION)[0].trim();
  const second = sentenceEnds(value)[1];
  return clip(second ? value.slice(0, second) : value, SUMMARY_MAX);
}
// The first point of the worker's "Nächste Schritte:" or "Nächster Schritt:", if it has one.
// This bridge's own rendering (HEAD … · Zuständig: … · Nächster Schritt: …) is no
// worker step: a row read back without its blockerReason never keeps its old step.
function workerNextStep(text) {
  const value = clean(text, 4000);
  const own = value.startsWith(HEAD) ? value.split(' · Zuständig: ')[0] : value;
  const steps = /(?:^|\s)\**Nächste(?: Schritte|r Schritt)\**:?\s+(.+)$/i.exec(own)?.[1];
  if (!steps) return '';
  const first = steps.replace(/^(?:•|-|\d{1,2}\.)\s*/u, '').split(/\s(?:•|\d{1,2}\.\s)|\s\**Stand\**:\s/u)[0].trim();
  const end = sentenceEnds(first)[0];
  return clip(end ? first.slice(0, end) : first, 160);
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
      blockerState: run.state,
      blockerRecordedAt: run.finished_at || run.paused_since || run.queued_at,
      blockerSource: 'checkpoint', blockerSourceRunId: entry.run_id, blockerSourceHash: entry.digest };
    cache.set(cacheKey, result); if (cache.size > 128) cache.delete(cache.keys().next().value);
    return result;
  } catch { return { blockerReason: 'Blockerbefund im gesicherten Vorgang kann nicht verifiziert gelesen werden.',
    reasonCode: 'blocker_context_unreadable', responsibleRole: 'Technik', nextStep: 'Integrität und Format des gesicherten Vorgangs prüfen; Arbeitsstand erhalten.' }; }
}
// Codes a typed worker owner may replace: they name no owner of their own.
const UNOWNED = new Set(['blocker_review_required', 'blocker_context_missing', 'technical_blocker']);
const HEAD = 'Gesicherter Befund: ';
export function applyBlockerContexts(rows, tasks, now = Date.now()) {
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  for (const row of rows) {
    if (row.status !== 'blocked') continue;
    const taskId = row.url?.match(/^https:\/\/app\.clickup\.com\/t\/([^/?#]+)/)?.[1];
    const task = byId.get(taskId);
    const pm = task ? currentPm(task) : {};
    // Fresh source only. Never inherit old assignees or a previous PM snapshot.
    delete row.pmOwner; delete row.pmOwnerId;
    Object.assign(row, pm);
    row.pmCheckedAt = new Date(now).toISOString();
    const reason = row.blockerReason || row.blockedReason;
    // Still open here means no bound journal (applyPmQuestions gives each its own
    // phase): a ❓ of a setup gap or missing master data keeps that owner and step.
    const setup = row.phase === 'PM-Rückfrage offen' && setupOwner(row.blockerOwner, reason);
    if (setup) row.phase = SETUP_PHASE[setup];
    // An open PM question is a PM decision, also against a checkpoint code (Fehleraudit 19.10.2026).
    if (row.phase === 'PM-Rückfrage offen') {
      Object.assign(row, { ...OWNER_CONTEXT.pm, nextStep: row.reasonCode === 'pm_decision_pending' && row.nextStep || OWNER_CONTEXT.pm.nextStep,
        blockerReason: clean(reason) || 'PM-Rückfrage offen' });
    // A workflow name proves no technical cause. Preserve unknown ownership
    // until an actual worker state, typed owner or structured PM journal supplies it.
    } else if (!row.reasonCode || (OWNER_CONTEXT[row.blockerOwner] && UNOWNED.has(row.reasonCode))
      || (setup && GROUP[row.reasonCode] !== setup)) {
      Object.assign(row, blockerContext(reason, { owner: row.blockerOwner }));
    }
    if (row.workflow === 'sales' && row.reasonCode === OWNER_CONTEXT.sales.reasonCode) row.phase = SALES_CLOSED_PHASE;
    // A superseded worker handover (Leebmann 19.10.2026) never redirects technical work.
    const step = ['PM', 'PM und Design', STAMMDATEN_ROLE].includes(row.responsibleRole) && workerNextStep(reason);
    if (step) row.nextStep = step;
    // Build the attribution first, then fit the cause at a word boundary into
    // the relay's 500 characters (team-server/fleet.js validateQueue).
    // A Sales order has no ClickUp task and therefore no PM field.
    const caption = row.responsibleRole === OWNER_CONTEXT.sales.responsibleRole ? '' : pmCaption(task, pm);
    const tail = ` · Zuständig: ${clean(row.responsibleRole, 60)}${caption} · Nächster Schritt: ${clip(clean(row.nextStep), 160)}`;
    const cause = clip(summary(row.blockerReason || row.blockedReason), Math.min(SUMMARY_MAX, 500 - HEAD.length - tail.length));
    row.blockedReason = clean(HEAD + cause + tail);
  }
  return rows;
}
