import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { blockerContext, checkpointBlocker, currentPm, pmFieldState, applyBlockerContexts, summary, clip, questionWithdrawn, sourceRenewal, designRenewal, PM_FIELD_ID, STAMMDATEN_ROLE, CORRECTION_STEP } from './blocker-context.mjs';
import state from './task-state.cjs';

function checkpoint(change = {}) {
  const value = { schema: 2, producer: 'mac-1', runId: 'exact-run', runs: [{ run: {
    run_id: 'exact-run', task_id: 'exact-task', state: 'technisch_blockiert',
    detail: 'Fixture technical step failed', finished_at: '2026-10-18T12:00:00Z',
  } }] };
  const packed = Buffer.concat([Buffer.from('RSART2\0'), zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)))]).toString('base64');
  return { producer: 'mac-1', run_id: 'exact-run', task_id: 'exact-task', packed,
    digest: crypto.createHash('sha256').update(packed).digest('hex'), ...change };
}

test('checkpoint display binds exact bytes, producer, task and run without restoring a job', () => {
  const e = checkpoint(), result = checkpointBlocker(e);
  assert.equal(result.blockerSourceHash, e.digest);
  assert.equal(result.blockerSourceRunId, 'exact-run');
  assert.equal(result.reasonCode, 'technical_blocker');
  for (const change of [{ producer: 'other' }, { task_id: 'other' }, { run_id: 'other' },
    { digest: '0'.repeat(64) }, { packed: e.packed + 'bad' }]) {
    assert.equal(checkpointBlocker({ ...e, ...change }).reasonCode, 'blocker_context_unreadable');
  }
});

test('PM evidence uses one current explicit users field and never guesses assignees', () => {
  const field = { id: PM_FIELD_ID, type: 'users', value: [{ id: '12', username: 'Current PM' }] };
  assert.deepEqual(currentPm({ custom_fields: [field] }), { pmOwner: 'Current PM', pmOwnerId: '12' });
  for (const custom_fields of [[], [field, field], [{ ...field, value: [field.value[0], { id: '13', username: 'Other' }] }]]) {
    assert.deepEqual(currentPm({ custom_fields }), {});
  }
  const rows = [{ status: 'blocked', workflow: 'upload', url: 'https://app.clickup.com/t/task',
    blockedReason: 'Fixture fault', pmOwner: 'Old PM', pmOwnerId: '99' }];
  applyBlockerContexts(rows, [], 1000);
  assert.equal(rows[0].pmOwner, undefined);
  assert.equal(rows[0].pmOwnerId, undefined);
  assert.equal(rows[0].pmCheckedAt, new Date(1000).toISOString());
});

test('an unknown non-sales blocker is not called technical without state evidence', () => {
  for (const workflow of ['newsletter', 'upload', 'translation', 'correction']) {
    const rows = [{ status: 'blocked', workflow, blockedReason: 'Saved acceptance finding' }];
    applyBlockerContexts(rows, [], 1000);
    assert.equal(rows[0].reasonCode, 'blocker_review_required');
    assert.equal(rows[0].responsibleRole, 'Zuständigkeit ungeklärt');
  }
  assert.equal(blockerContext('Actual worker failure', { state: 'technisch_blockiert' }).responsibleRole, 'Technik');
});

test('manual completion is final and cannot become live work during reconciliation', () => {
  const task = state.reconcileTask({ completion: 'manual', status: 'blocked', step: 'stale',
    blockedReason: 'old', errorUrl: 'https://example.test/old' });
  assert.equal(task.status, 'completed');
  assert.equal(task.progress, 100);
  for (const key of ['step', 'blockedReason', 'errorUrl']) assert.equal(task[key], undefined);
});

// Fehleraudit 19.10.2026: original worker texts of that day.
const SETUP_GAP = 'Kunden-Setup noch nicht abgeschlossen: keine im RS Hub freigegebene Designbasis (produktion/gestaltung.json) bzw. kein Flow-Ziel (ziele.flows)';
const MISSING_CUSTOMER = 'Kunden-Setup noch nicht abgeschlossen: kein RS-Hub-Kunde für ClickUp-Ordner 901515002296 („Niskasten (von Joline)“). '
  + 'Kunden-Onboarding im RS Hub abschließen (Kundenakte mit clickup.folderId 901515002296 und freigegebener Designbasis), danach den Auftrag neu beauftragen.';
const KEY_NOT_SET = 'Klaviyo-Quellenbindung: Klaviyo-Schlüssel fehlt im RS Hub (KEY_NOT_SET) für uficell; Upload wartet auf den Schlüssel, nach dem Eintragen genügt 🔁; Entwurf unverändert.';
const SOURCE_CHANGED = 'PM-Entscheidung erforderlich: Aufgabenquelle während der Vorbereitung geändert. Die geänderte Kunden-/Auftragsbindung muss mit der vorhandenen Arbeit abgeglichen und bestätigt werden. Vorhandene Rahmen, Entwürfe und Prüfbelege bleiben erhalten.';
const LEEBMANN = 'Kurzfassung: Der Newsletter „Herbsterwachen“ ist fertig gebaut und gestalterisch geprüft, darf aber noch nicht übergeben werden. Der Original-Footer von Leebmann24 verletzt drei bestätigte Kundenregeln, und es gibt keine berichtigte Fassung.\n\n'
  + 'Ursachen:\n1. Falsche Support-Adresse: Der Footer nennt shop@leebmann24.de, der Kunde verlangt shop@leebmann24.com.\n\n'
  + 'Nächste Schritte:\n• Das Design-Team berichtigt den Footer in der Leebmann24-Library und den gespeicherten Klaviyo-Footer.\n• Danach wird der neue Footer übernommen.\n\n'
  + 'Stand: Art-Director-Review und zwei Endabnahmen durchgeführt. Weitere offene PM-Punkte stehen in den offenen Punkten.';

test('worker setup texts address PM and Design and ask for a new commission', () => {
  for (const text of [SETUP_GAP, MISSING_CUSTOMER, 'Kunden-Onboarding ist noch nicht abgeschlossen; ohne freigegebene Library kein Bau.']) {
    for (const state of ['blockiert', 'technisch_blockiert', undefined]) {
      const result = blockerContext(text, { state });
      assert.equal(result.reasonCode, 'customer_setup_incomplete', text);
      assert.equal(result.responsibleRole, 'PM und Design');
      assert.match(result.nextStep, /neu beauftragen/);
      assert.doesNotMatch(result.nextStep, /gezielt fortsetzen/);
    }
  }
  // Positive or season wording is no setup gap.
  assert.notEqual(blockerContext('Endabnahme nicht bestanden. Stand: freigegebene Designbasis vorhanden').reasonCode, 'customer_setup_incomplete');
  assert.equal(blockerContext('Endabnahme nicht bestanden. Stand: freigegebene Designbasis vorhanden').reasonCode, 'quality_review_failed');
  assert.notEqual(blockerContext('Es gibt keine freigegebene Gestaltung für Black Week.').reasonCode, 'customer_setup_incomplete');
});

test('missing Klaviyo key and Hub mappings are master data, independent of the run state', () => {
  for (const text of [KEY_NOT_SET, 'Upload-Abnahme: Klaviyo-Render-Schlüssel im RS Hub fehlt (KEY_NOT_SET)', 'Flow-Route: kein Klaviyo-Schlüssel hinterlegt (404)']) {
    for (const state of ['technisch_blockiert', undefined]) {
      const result = blockerContext(text, { state });
      assert.equal(result.reasonCode, 'master_data_missing');
      assert.equal(result.responsibleRole, STAMMDATEN_ROLE);
      assert.doesNotMatch(result.responsibleRole, /(?:^|\W)PM(?:$|\W)/);
      assert.match(result.nextStep, /RS Hub/); assert.match(result.nextStep, /🔁/);
      assert.equal(result.blockerKind, 'waiting_human');
    }
  }
  assert.equal(blockerContext('RS-Hub-Stammdaten: Filestage-Ablage a7ae459b ist leer', { state: 'technisch_blockiert' }).reasonCode, 'master_data_missing');
  // A checked key followed by another gap is no key gap; plain technical text stays technical.
  assert.notEqual(blockerContext('Klaviyo-Schlüssel und Konto geprüft, Feed fehlt').reasonCode, 'master_data_missing');
  const technical = blockerContext('TypeError: cannot read properties of undefined', { state: 'technisch_blockiert' });
  assert.equal(technical.reasonCode, 'technical_blocker'); assert.equal(technical.responsibleRole, 'Technik');
  assert.equal(technical.blockerKind, undefined, 'an untyped state fallback leaves the register its own run classification');
  // The setup branch keeps priority.
  assert.equal(blockerContext(`${SETUP_GAP}; Klaviyo-Schlüssel fehlt`).reasonCode, 'customer_setup_incomplete');
});

test('source changes are technical during preparation and PM work after an answer unless only links changed', () => {
  const preparation = blockerContext(SOURCE_CHANGED, { state: 'technisch_blockiert' });
  assert.equal(preparation.reasonCode, 'preparation_source_changed'); assert.equal(preparation.responsibleRole, 'Technik');
  assert.match(preparation.nextStep, /gespeicherten Vorbereitung abgleichen/);
  const answer = fields => `Die Aufgabenquelle wurde nach der PM-Antwort geändert (${fields}). Die Produktion wurde angehalten.`;
  for (const fields of ['Klaviyo Link', 'Freigabe intern, Freigabe extern']) {
    assert.equal(blockerContext(answer(fields), { state: 'blockiert' }).responsibleRole, 'Technik', fields);
  }
  const briefing = blockerContext(answer('Briefingtext, Klaviyo Link'), { state: 'blockiert' });
  assert.equal(briefing.responsibleRole, 'PM'); assert.match(briefing.nextStep, /neu beauftragen/);
});

test('PM decisions are addressed to the PM; an open review finding stays unassigned', () => {
  for (const text of ['PM-Entscheidung erforderlich: Gutscheincode oder Rabattwert fehlt.',
    'Abnahme offen: Truhe aus Arve: Mail 40.00 CHF → Shop 35.00 CHF; PM entscheidet, ob der Mailwert bleibt oder Figma korrigiert wird',
    'Korrekturauftrag nicht vorbereitet: Kunde für die Ablage-Reparatur nicht eindeutig im RS Hub zugeordnet. Markt im Aufgabentitel eindeutig angeben, z. B. „· Europa“']) {
    const result = blockerContext(text, { state: 'technisch_blockiert' });
    assert.equal(result.reasonCode, 'pm_decision_pending', text); assert.equal(result.responsibleRole, 'PM');
    assert.equal(result.blockerKind, 'waiting_human');
  }
  assert.equal(blockerContext('Mailpreis 1,59 € statt Shoppreis 1,54 €; PM-Entscheidung offen').reasonCode, 'blocker_review_required');
  assert.equal(blockerContext('Rückfrage nicht zugestellt: Fragen-Hub nicht erreichbar', { state: 'technisch_blockiert' }).responsibleRole, 'Technik');
  // Unchanged specific branches.
  assert.equal(blockerContext('Produktfeed fehlt in Klaviyo').reasonCode, 'product_feed_missing');
  assert.equal(blockerContext('Platzhalter im Angebot').reasonCode, 'approved_content_incomplete');
  assert.equal(blockerContext('QA nicht bestanden nach drei Fixrunden').reasonCode, 'quality_review_failed');
});

test('a typed worker owner wins over the text and keeps a more specific result of its own group', () => {
  const pm = blockerContext('Saved acceptance finding', { owner: 'pm' });
  assert.deepEqual([pm.reasonCode, pm.responsibleRole, pm.blockerKind], ['pm_decision_pending', 'PM', 'waiting_human']);
  const data = blockerContext(KEY_NOT_SET, { owner: 'stammdaten' });
  assert.equal(data.reasonCode, 'master_data_missing'); assert.match(data.nextStep, /Klaviyo-Schlüssel/);
  const technical = blockerContext(SETUP_GAP, { owner: 'technik' });
  assert.deepEqual([technical.reasonCode, technical.responsibleRole, technical.blockerKind], ['technical_blocker', 'Technik', 'technical_failure']);
  assert.equal(blockerContext('TypeError', { owner: 'automatisch', state: 'technisch_blockiert' }).blockerKind, 'technical_failure');
  assert.equal(blockerContext('Saved finding', { owner: 'design' }).reasonCode, 'blocker_review_required', 'unknown owners are ignored');
});

test('the displayed cause is a readable short version that fits with role and next step', () => {
  const tasks = [{ id: 't', custom_fields: [] }];
  const long = `${MISSING_CUSTOMER} ${'Zusätzliche Erläuterung zur Kundenakte. '.repeat(6)}`;
  for (const reason of [MISSING_CUSTOMER, long, SOURCE_CHANGED, KEY_NOT_SET, LEEBMANN, 'x'.repeat(900)]) {
    const rows = [{ status: 'blocked', workflow: 'newsletter', url: 'https://app.clickup.com/t/t', blockedReason: reason }];
    applyBlockerContexts(rows, tasks, 1000);
    const text = rows[0].blockedReason;
    assert.ok(text.length <= 500, text);
    assert.ok(text.endsWith(rows[0].nextStep), 'the next step is complete');
    const cause = text.slice('Gesicherter Befund: '.length, text.indexOf(' · Zuständig:'));
    assert.match(cause, /[.!?“”)]$|…$/u, cause);
    assert.doesNotMatch(cause, /90151500229(?!6)|9015150022 /);
  }
  const rows = [{ status: 'blocked', workflow: 'newsletter', blockedReason: SOURCE_CHANGED },
    { status: 'blocked', workflow: 'newsletter', blockedReason: LEEBMANN }];
  applyBlockerContexts(rows, [], 1000);
  assert.match(rows[0].blockedReason, /^Gesicherter Befund: Aufgabenquelle während der Vorbereitung geändert\. Die geänderte Kunden-\/Auftragsbindung muss mit der vorhandenen Arbeit abgeglichen und bestätigt werden\. · Zuständig: Technik/);
  assert.match(rows[1].blockedReason, /^Gesicherter Befund: Der Newsletter „Herbsterwachen“ ist fertig gebaut/);
  assert.doesNotMatch(rows[1].blockedReason, /Ursachen|Endabnahmen|Design-Team/);
  assert.notEqual(rows[1].reasonCode, 'quality_review_failed', 'checked work in the Stand section decides nothing');
  assert.equal(summary('PM-Entscheidung erforderlich: Gutscheincode fehlt.'), 'Gutscheincode fehlt.');
  assert.equal(clip('ein zwei drei vier', 12), 'ein zwei …');
});

test('a worker next step is used only for PM, onboarding or master data owners', () => {
  const steps = '\n\nNächste Schritte:\n• Den Gutscheincode in ClickUp eintragen.\n• Danach Upload neu beauftragen.';
  const pm = [{ status: 'blocked', workflow: 'upload', blockedReason: `PM-Entscheidung erforderlich: Gutscheincode fehlt.${steps}` }];
  applyBlockerContexts(pm, [], 1000);
  assert.equal(pm[0].nextStep, 'Den Gutscheincode in ClickUp eintragen.');
  const technical = [{ status: 'blocked', workflow: 'newsletter', blockedReason: LEEBMANN, blockerOwner: 'automatisch' }];
  applyBlockerContexts(technical, [], 1000);
  assert.equal(technical[0].responsibleRole, 'Technik');
  assert.doesNotMatch(technical[0].nextStep, /Design-Team/);
});

test('typed owners replace only unowned codes, and an open PM question is always a PM decision', () => {
  const rows = [
    { status: 'blocked', workflow: 'upload', blockedReason: KEY_NOT_SET, reasonCode: 'technical_blocker', blockerOwner: 'stammdaten' },
    { status: 'blocked', workflow: 'upload', blockedReason: 'Produktfeed fehlt', reasonCode: 'product_feed_missing', blockerOwner: 'pm' },
    { status: 'blocked', workflow: 'correction', phase: 'PM-Rückfrage offen', blockerReason: 'Welche Module?',
      reasonCode: 'blocker_review_required', responsibleRole: 'Zuständigkeit ungeklärt', blockerSource: 'checkpoint' },
  ];
  applyBlockerContexts(rows, [], 1000);
  assert.deepEqual([rows[0].reasonCode, rows[0].responsibleRole, rows[0].blockerKind], ['master_data_missing', STAMMDATEN_ROLE, 'waiting_human']);
  assert.equal(rows[1].reasonCode, 'product_feed_missing');
  assert.deepEqual([rows[2].reasonCode, rows[2].responsibleRole, rows[2].blockerKind, rows[2].blockerReason],
    ['pm_decision_pending', 'PM', 'waiting_human', 'Welche Module?']);
});

test('a ❓ of a setup gap or missing master data without a bound journal keeps that owner and step', () => {
  const open = (blockerReason, extra) => ({ status: 'blocked', workflow: 'correction', phase: 'PM-Rückfrage offen', blockerReason,
    reasonCode: 'pm_decision_pending', responsibleRole: 'PM', nextStep: 'Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.', ...extra });
  const rows = [open(SETUP_GAP, { blockerOwner: 'onboarding' }), open(SETUP_GAP), open(KEY_NOT_SET, { blockerOwner: 'stammdaten' }),
    open('Welche Module?', { blockerOwner: 'onboarding' }),
    // The worker's PM type, an ordinary question and a season design gate stay PM decisions.
    open(SETUP_GAP, { blockerOwner: 'pm' }), open('Welche Module?'), open('Es gibt keine freigegebene Gestaltung für Black Week.')];
  applyBlockerContexts(rows, [], 1000);
  const shown = row => [row.phase, row.reasonCode, row.responsibleRole];
  assert.deepEqual(shown(rows[0]), ['Blockiert · Kunden-Setup', 'customer_setup_incomplete', 'PM und Design']);
  assert.match(rows[0].nextStep, /neu beauftragen/);
  assert.match(rows[0].blockedReason, /Zuständig: PM und Design .* Nächster Schritt: Designbasis im RS Hub freigeben/);
  assert.deepEqual(shown(rows[1]), ['Blockiert · Kunden-Setup', 'customer_setup_incomplete', 'PM und Design']);
  assert.deepEqual(shown(rows[2]), ['Blockiert · Stammdaten', 'master_data_missing', STAMMDATEN_ROLE]);
  assert.deepEqual(shown(rows[3]), ['Blockiert · Kunden-Setup', 'customer_setup_incomplete', 'PM und Design']);
  for (const row of rows.slice(4)) assert.deepEqual(shown(row), ['PM-Rückfrage offen', 'pm_decision_pending', 'PM']);
});

test('the PM caption distinguishes an empty, an ambiguous and an unread PM field', () => {
  const user = (id, username) => ({ id, username });
  const field = value => ({ id: 't', custom_fields: [{ id: PM_FIELD_ID, type: 'users', value }] });
  const caption = task => {
    const rows = [{ status: 'blocked', workflow: 'upload', url: 'https://app.clickup.com/t/t', blockedReason: KEY_NOT_SET }];
    applyBlockerContexts(rows, task ? [task] : [], 1000);
    return / \((PM[^)]*)\) · Nächster Schritt:/.exec(rows[0].blockedReason)?.[1];
  };
  assert.equal(caption(field([user('1', 'Ben Schulte')])), 'PM: Ben Schulte');
  assert.equal(caption(field([])), 'PM-Feld leer');
  assert.equal(caption(field([user('1', 'Ben Schulte'), user('2', 'John Koci')])), 'PM-Feld nicht eindeutig: Ben Schulte, John Koci');
  assert.equal(caption(null), 'PM nicht zugeordnet');
  // Long names never push the next step out of the 500 characters.
  const long = field([1, 2, 3].map(n => user(String(n), `Sehr langer Benutzername ${n} ${'x'.repeat(70)}`)));
  const rows = [{ status: 'blocked', workflow: 'upload', url: 'https://app.clickup.com/t/t', blockedReason: KEY_NOT_SET }];
  applyBlockerContexts(rows, [long], 1000);
  assert.ok(rows[0].blockedReason.length <= 500); assert.ok(rows[0].blockedReason.endsWith(rows[0].nextStep));
  assert.match(rows[0].blockedReason, /\(PM-Feld nicht eindeutig: Sehr langer Benutzername 1[^)]{0,80} …\) · Nächster Schritt:/);
  assert.deepEqual(pmFieldState(field([user('1', 'A'), user('2', 'B')])), { read: true, names: ['A', 'B'] });
  assert.deepEqual(currentPm(field([user('1', 'A'), user('2', 'B')])), {});
});

// Fehleraudit 26.10.2026 (Till): a Sales finding the worker types itself (owner
// 'sales' or reasonCode sales_shop_unavailable) is a closed business case without
// production, never an open technical error. Untyped Sales rows stay unassigned.
test('a typed Sales finding is a closed business case; untyped Sales rows keep their fallback', () => {
  const sales = blockerContext('Shop nicht öffentlich: Shopify-Passwortseite, kein Sortiment lesbar.', { owner: 'sales' });
  assert.deepEqual([sales.reasonCode, sales.responsibleRole, sales.blockerKind], ['sales_shop_unavailable', 'Sales', 'withdrawn']);
  assert.match(sales.nextStep, /Keine Produktion möglich/);
  // The typed owner wins over technical words of the finding, as for every typed owner.
  assert.equal(blockerContext('Shop antwortet mit HTTP 404', { owner: 'sales', state: 'technisch_blockiert' }).reasonCode, 'sales_shop_unavailable');
  const rows = [
    { id: 'sales:1792846768.952609', workflow: 'sales', status: 'blocked', url: 'https://neona.de/', phase: 'Sales blockiert',
      blockedReason: 'Shop nicht verfügbar: Startseite liefert 404.', blockerOwner: 'sales' },
    { id: 'sales:1792290795.824999', workflow: 'sales', status: 'blocked', url: 'https://dein-flaschengarten.de/', phase: 'Sales blockiert',
      blockedReason: 'Shop nicht verfügbar: Betrieb eingestellt.' },
  ];
  applyBlockerContexts(rows, [], 1000);
  assert.deepEqual([rows[0].reasonCode, rows[0].responsibleRole, rows[0].blockerKind, rows[0].phase],
    ['sales_shop_unavailable', 'Sales', 'withdrawn', 'Abgeschlossen · keine Produktion möglich']);
  assert.match(rows[0].blockedReason, /^Gesicherter Befund: Shop nicht verfügbar: Startseite liefert 404\. · Zuständig: Sales · Nächster Schritt: Keine Produktion möglich/);
  assert.ok(rows[0].blockedReason.endsWith(rows[0].nextStep));
  // Without the worker's type nothing is relaxed: the fallback stays unassigned and without blockerKind.
  assert.deepEqual([rows[1].reasonCode, rows[1].responsibleRole, rows[1].blockerKind, rows[1].phase],
    ['blocker_review_required', 'Zuständigkeit ungeklärt', undefined, 'Sales blockiert']);
});

test('a PM question the worker withdrew is no pending decision but a new commission with the worker step', () => {
  // Fehleraudit 26.10.2026 (Tomishop Black Week 12451cu65b8): the worker withdrew the
  // question after a source change and types the owner pm (src/blocker-owner.js).
  const withdrawn = 'Offene PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert (Mail Link). '
    + 'Nächster Schritt: 🔁 am Beitrag oder den Status „pre-gen“ erneut setzen; der neue Lauf prüft die aktuelle Quelle.';
  const typed = blockerContext(withdrawn, { owner: 'pm' });
  assert.deepEqual([typed.reasonCode, typed.responsibleRole, typed.blockerKind], ['pm_source_changed', 'PM', 'waiting_human']);
  assert.equal(blockerContext(withdrawn, { state: 'unklar' }).reasonCode, 'pm_source_changed');
  const rows = [{ status: 'blocked', workflow: 'newsletter', blockedReason: withdrawn, blockerOwner: 'pm' },
    { status: 'blocked', workflow: 'newsletter', blockedReason: withdrawn, reasonCode: 'blocker_review_required', blockerOwner: 'pm' }];
  applyBlockerContexts(rows, [], 1000);
  for (const row of rows) {
    assert.equal(row.reasonCode, 'pm_source_changed');
    assert.equal(row.nextStep, '🔁 am Beitrag oder den Status „pre-gen“ erneut setzen; der neue Lauf prüft die aktuelle Quelle.');
    assert.match(row.blockedReason, /Nächster Schritt: 🔁 am Beitrag oder den Status „pre-gen“ erneut setzen/);
  }
  // A still open question stays a PM decision.
  const open = [{ status: 'blocked', workflow: 'newsletter', phase: 'PM-Rückfrage offen', blockerReason: 'Welche Module?', blockerOwner: 'pm' }];
  applyBlockerContexts(open, [], 1000);
  assert.equal(open[0].reasonCode, 'pm_decision_pending');
});

test('only the worker\'s own "Nächster Schritt:" names a PM step; quoted withdrawals and this bridge\'s rendering decide nothing', () => {
  // The worker's Slack format (src/fehler.js formatSlackDetail) turns a closing
  // „Sobald …“ of a PM blocker into "Nächster Schritt: Sobald …".
  const pm = [{ status: 'blocked', workflow: 'newsletter', blockerOwner: 'pm',
    blockedReason: 'PM-Entscheidung erforderlich: Welche Module gehören in die Mail? Nächster Schritt: Sobald die Module in ClickUp stehen, kann der Lauf neu gestartet werden.' }];
  applyBlockerContexts(pm, [], 1000);
  assert.equal(pm[0].reasonCode, 'pm_decision_pending');
  assert.equal(pm[0].nextStep, 'Sobald die Module in ClickUp stehen, kann der Lauf neu gestartet werden.');
  // A row read back without its blockerReason carries only this bridge's own
  // rendering: its tail is no worker step, the code's own step applies again.
  const rendered = [
    { status: 'blocked', workflow: 'newsletter',
      blockedReason: 'Gesicherter Befund: Die Modulauswahl fehlt, PM entscheidet. · Zuständig: PM (PM nicht zugeordnet) · Nächster Schritt: Alter Schritt eines früheren Stands.' },
    { status: 'blocked', workflow: 'newsletter',
      blockedReason: 'Gesicherter Befund: Offene PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert (Mail Link). · Zuständig: PM (PM nicht zugeordnet) · Nächster Schritt: Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.' }];
  applyBlockerContexts(rendered, [], 1000);
  assert.deepEqual(rendered.map(row => [row.reasonCode, row.nextStep]), [
    ['pm_decision_pending', 'Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.'],
    ['pm_source_changed', 'Rückfrage ist zurückgezogen: den Startstatus in ClickUp erneut setzen; der neue Lauf prüft die aktuelle Quelle.']]);
  // The withdrawal counts only at the start of the cause, like the worker's
  // technical-repair.js PM_QUESTION_WITHDRAWN; a quoted earlier attempt does not.
  const quoted = blockerContext('Technischer Fehler beim Fortsetzen: Vorlauf meldete „Offene PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert.“',
    { state: 'technisch_blockiert' });
  assert.equal(quoted.reasonCode, 'technical_blocker');
});

test('the worker\'s prefix of a withdrawn PM question is a fixed contract', () => {
  // Contract with the worker: src/pm-question-worker.js withdrawnQuestionRelease writes
  // every such detail with exactly this prefix, src/technical-repair.js
  // PM_QUESTION_WITHDRAWN keeps it out of automatic repair. Changing it needs both repos.
  const PREFIX = 'Offene PM-Rückfrage zurückgezogen: ';
  // The template's variants: own or default cause; 🔁 only while the run can resume;
  // the trigger status, else the generic start status.
  const details = [
    ['Die Aufgabenquelle wurde geändert (Mail Link).', '🔁 am Beitrag oder den Status „pre-gen“ erneut setzen'],
    ['Die Aufgabenquelle wurde geändert.', 'den Status „klaviyo upload“ erneut setzen'],
    ['Die Aufgabenquelle wurde geändert.', 'den Startstatus erneut setzen'],
  ].map(([cause, again]) => `${PREFIX}${cause} Nächster Schritt: ${again}; der neue Lauf prüft die aktuelle Quelle.`);
  for (const detail of details) {
    // The bridge (newsletter-monitor-bridge.mjs) reads this predicate: no open question.
    assert.equal(questionWithdrawn(detail), true, detail);
    assert.equal(questionWithdrawn(`Gesicherter Befund: ${detail}`), true, detail);
    const rows = [{ status: 'blocked', workflow: 'newsletter', blockedReason: detail, blockerOwner: 'pm' },
      { status: 'blocked', workflow: 'newsletter', blockedReason: detail }];
    applyBlockerContexts(rows, [], 1000);
    for (const row of rows) {
      assert.deepEqual([row.reasonCode, row.responsibleRole, row.blockerKind], ['pm_source_changed', 'PM', 'waiting_human'], detail);
      assert.equal(row.nextStep, detail.split('Nächster Schritt: ')[1]);
    }
  }
  // Only this exact prefix at the start of the cause counts.
  for (const other of ['Offene PM-Rückfrage: Welche Module gehören in die Mail?',
    'PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert.',
    'Offene PM-Rückfrage zurückgenommen: Die Aufgabenquelle wurde geändert.',
    'Technischer Fehler beim Fortsetzen: Offene PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert.']) {
    assert.equal(questionWithdrawn(other), false, other);
    assert.notEqual(blockerContext(other, { state: 'unklar' }).reasonCode, 'pm_source_changed', other);
  }
});

// Till, 30.10.2026 (worker V1.2028 src/source-renewal.js, artifex 12451cua901): a design base
// renewed mid-run renews the Pre-Gen like a changed brief. The skill's own stop
// (content-creation produktionsfreigabe.py) carries the same prefix but never the worker's count.
const SOURCE_DETAIL = 'Aufgabenquelle geändert, offene PM-Rückfrage zurückgezogen: Die Aufgabenquelle wurde geändert (Briefingtext). '
  + 'Der Auftrag startet automatisch frisch auf der aktuellen Quelle; der PM muss nichts tun (Quellwechsel 1 von 3).';
const DESIGN_DETAIL = 'Designbasis erneuert: Die freigegebene Library emqmXeFXtnELBhbKwHg4Yz wurde während des Laufs von Version 2414659657472725219 '
  + 'auf 2416280762825511774 gehoben. Der Auftrag startet automatisch auf der neuen Basis neu und übernimmt die fertige Inhaltsarbeit; '
  + 'der PM muss nichts tun (Quellwechsel 2 von 3).';
const SKILL_STOP = 'Designbasis erneuert: Die freigegebene Library emqmXeFXtnELBhbKwHg4Yz wurde während des Laufs von Version 2414659657472725219 '
  + 'auf 2416280762825511774 gehoben (Till, 30.10.2026). Diesen Lauf jetzt mit genau diesem Befund als blockiert beenden: keine PM-Frage, '
  + 'nichts umgehen, nicht mit der alten Version weiterbauen. Der Worker startet den Auftrag automatisch auf der neuen Basis neu und übernimmt die fertige Inhaltsarbeit.';

test('a design base renewed mid-run is a renewal like a changed brief; the skill\'s own stop without the count is none', () => {
  for (const detail of [SOURCE_DETAIL, DESIGN_DETAIL]) {
    // The bridge (applyStoredCheckpoints) reads this predicate: its scheduled start waits.
    assert.equal(sourceRenewal(detail), true, detail);
    assert.equal(sourceRenewal(`Gesicherter Befund: ${detail}`), true, detail);
  }
  assert.deepEqual([designRenewal(DESIGN_DETAIL), designRenewal(`Gesicherter Befund: ${DESIGN_DETAIL}`), designRenewal(SOURCE_DETAIL)], [true, true, false]);
  // A run the worker could not renew (count spent, a Mac before V1.2028) keeps the skill's stop:
  // still a blocker. Like the worker, only at the start of the cause.
  for (const other of [SKILL_STOP, `Technischer Fehler beim Fortsetzen: ${DESIGN_DETAIL}`,
    'Designbasis erneuert (Quellwechsel 1 von 3).', DESIGN_DETAIL.replace('Designbasis erneuert:', 'Designbasis veraltet:')]) {
    assert.equal(sourceRenewal(other), false, other);
    assert.equal(designRenewal(other), false, other);
  }
});

// Word for word with the worker: NEWSLETTER_ROOT names a worker checkout (the release's
// --newsletter-root), else the published main of the usual checkout on a Till Mac. Without
// either (CI) the fixed samples above stay the contract.
const RENEWAL_SOURCE = process.env.NEWSLETTER_ROOT ? path.join(process.env.NEWSLETTER_ROOT, 'src', 'source-renewal.js')
  : 'origin/main:src/source-renewal.js of ~/Documents/AI Newsletter Creation';
function renewalSource() {
  try {
    return process.env.NEWSLETTER_ROOT ? fs.readFileSync(RENEWAL_SOURCE, 'utf8')
      : execFileSync('git', ['-C', path.join(os.homedir(), 'Documents', 'AI Newsletter Creation'), 'show', 'origin/main:src/source-renewal.js'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}
const workerRenewal = renewalSource();
test('the renewal predicates follow the worker\'s src/source-renewal.js', { skip: workerRenewal === null && 'no worker checkout (NEWSLETTER_ROOT)' }, () => {
  const source = workerRenewal;
  const literal = name => {
    const match = new RegExp(`^const ${name} = '([^'\\n]+)';$`, 'm').exec(source);
    assert.ok(match, `${name} in ${RENEWAL_SOURCE}: update this contract with the worker`);
    return match[1];
  };
  const detail = /^const DETAIL = \/(.+)\/;$/m.exec(source);
  assert.ok(detail, `DETAIL in ${RENEWAL_SOURCE}: update this contract with the worker`);
  const renewed = new RegExp(detail[1]), prefix = literal('PREFIX'), design = literal('DESIGN_PREFIX');
  assert.equal(SOURCE_DETAIL.startsWith(prefix) && DESIGN_DETAIL.startsWith(design) && SKILL_STOP.startsWith(design), true);
  // The worker's attemptOf decides a renewal by DETAIL; the bridge decides the same.
  for (const sample of [SOURCE_DETAIL, DESIGN_DETAIL, SKILL_STOP, `${design}Die freigegebene Library x wurde gehoben. (Quellwechsel 3 von 3).`]) {
    assert.equal(sourceRenewal(sample), renewed.test(sample), sample);
    assert.equal(designRenewal(sample), renewed.test(sample) && sample.startsWith(design), sample);
  }
});

// Fehleraudit 29.10.2026 (Zuständigkeit und offene Inhaltsfragen), real ends of 29.10.2026.
test('JuCad: a stored unklar end without a typed owner is the PM with the worker step, never „Zuständigkeit ungeklärt“', () => {
  const jucad = 'Kurzfassung: Für die FR-CH-Fassung fehlt nur noch der Aktions-EK. Die PM-Antwort nennt ausschließlich CHF-Verkaufspreise.\n\n'
    + 'Ursachen:\n1. Aktions-EK in CHF: Offen ist, ob CHF-EK-Werte geliefert werden, der Euro-EK aus dem Master bleibt oder die EK-Zeile entfällt.\n\n'
    + 'Nächste Schritte:\n• PM beantwortet Frage Q3 im Rückfragen-Thread.\n• Danach wird dieselbe Aufgabe fortgesetzt.';
  const context = blockerContext(jucad, { state: 'unklar' });
  assert.deepEqual([context.reasonCode, context.responsibleRole, context.blockerKind], ['pm_decision_pending', 'PM', 'waiting_human']);
  const [row] = applyBlockerContexts([{ status: 'blocked', url: 'https://app.clickup.com/t/12451cu9w7h', blockerReason: jucad, ...context }], []);
  assert.equal(row.nextStep, 'PM beantwortet Frage Q3 im Rückfragen-Thread.');
  // Dynatech 86cbgtpjr keeps its own PM code and step, also as unklar.
  const dynatech = 'Platzhalter „[XX %]“ im freigegebenen Rahmen: Angebotswerte fehlen – Rahmen von Hand berichtigen und 🔁.';
  assert.equal(blockerContext(dynatech, { state: 'unklar' }).reasonCode, 'approved_content_incomplete');
  // Gegenprobe: the same text as an ordinary blocked end stays unowned without a typed owner.
  assert.equal(blockerContext(jucad, { state: 'blockiert' }).reasonCode, 'blocker_review_required');
});

test('LKW-Teile24: an inactive Hub customer and a design basis nobody approved are customer setup, not Technik', () => {
  const lkw = 'Kurzfassung: Der Newsletter wurde nicht gebaut, weil LKW-Teile24 im RS Hub nicht für die Produktion eingerichtet ist.\n\n'
    + 'Ursachen:\n1. Kunde inaktiv: LKW-Teile24 ist im RS Hub als inaktiver Kunde geführt.\n'
    + '2. Designbasis fehlt: Für LKW-Teile24 hat noch niemand eine gemeinsame Designbasis für Newsletter freigegeben.\n\n'
    + 'Nächste Schritte:\n• PM/Team: Kunden im RS Hub aktivieren, falls die Produktion für LKW-Teile24 wieder laufen soll.';
  for (const state of ['blockiert', 'technisch_blockiert']) {
    const context = blockerContext(lkw, { state });
    assert.deepEqual([context.reasonCode, context.responsibleRole], ['customer_setup_incomplete', 'PM und Design'], state);
  }
  // The worker's own start check (worker.js, inactiveCustomer).
  const own = 'Kunden-Setup noch nicht abgeschlossen: Der RS-Hub-Kunde lkw-teile24 („LKW-Teile24“) für ClickUp-Ordner 901514369501 ist inaktiv. '
    + 'Kunden im RS Hub aktivieren und die Designbasis freigeben (Kunden-Onboarding), danach den Auftrag neu beauftragen.';
  assert.equal(blockerContext(own, { owner: 'onboarding' }).responsibleRole, 'PM und Design');
  // The audience of a winback mail is no customer setup.
  const winback = 'Der Winback-Flow für inaktive Kunden hat in Klaviyo keinen Trigger; der Kunde ist seit 180 Tagen inaktiv.';
  assert.equal(blockerContext(winback, { state: 'technisch_blockiert' }).responsibleRole, 'Technik');
});

// Fehleraudit 29.10.2026 (Budoland 12451cu46dj): the PM answered the price question of a
// Hub-mail upload with another value; the upload cannot change approved content and names the
// correction order. The next step is that correction, not another decision in the thread.
test('a PM blocker naming the FileStage correction order shows it as next step', () => {
  const cause = 'Abnahme offen: Produktkarte „Zahnschutz X-Men Beast“: Mail 22,99 €*, PM-Entscheidung 20,95 € (Shoppreis Variante Beast/Senior). Draft unverändert; Änderung über Filestage-Kommentar und revision intern.';
  const rows = [
    { status: 'blocked', workflow: 'upload', blockerOwner: 'pm', blockedReason: cause },
    // Read back with only this bridge's own rendering of an earlier cycle.
    { status: 'blocked', workflow: 'upload', reasonCode: 'pm_decision_pending', responsibleRole: 'PM',
      blockedReason: `Gesicherter Befund: ${cause} · Zuständig: PM (PM: Hannes & Luca) · Nächster Schritt: Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.` },
    // Newer worker runs name the step themselves.
    { status: 'blocked', workflow: 'upload', blockerOwner: 'pm',
      blockedReason: 'Abnahme offen: Produktkarte Beast: Mail 22,99 €*, PM-Entscheidung 20,95 €. Nächster Schritt: Änderung als Kommentar in der FileStage-Review dieser Mail eintragen und `revision intern` setzen; danach aktualisiert `klaviyo upload` den bestehenden Draft.' },
    // An open PM decision without a correction order keeps the decision step.
    { status: 'blocked', workflow: 'upload', blockerOwner: 'pm', blockedReason: 'PM-Entscheidung erforderlich: Mailpreis 22,99 € oder Shoppreis 20,95 €?' },
    // A technical blocker that only mentions the status stays technical.
    { status: 'blocked', workflow: 'upload', blockerOwner: 'technik', blockedReason: 'Upload abgebrochen, FileStage-Review nicht lesbar; revision intern läuft.' },
  ];
  applyBlockerContexts(rows, [], 1000);
  assert.equal(rows[0].responsibleRole, 'PM');
  assert.equal(rows[0].nextStep, CORRECTION_STEP);
  assert.match(rows[0].blockedReason, /· Zuständig: PM \(PM nicht zugeordnet\) · Nächster Schritt: Änderung als Kommentar in der FileStage-Review eintragen und `revision intern` setzen/);
  assert.equal(rows[1].nextStep, CORRECTION_STEP);
  assert.equal(rows[2].nextStep, 'Änderung als Kommentar in der FileStage-Review dieser Mail eintragen und `revision intern` setzen; danach aktualisiert `klaviyo upload` den bestehenden Draft.');
  assert.equal(rows[3].nextStep, 'Entscheidung im Rückfragen-Thread bzw. in ClickUp treffen; danach setzt der Worker fort.');
  assert.equal(rows[4].responsibleRole, 'Technik');
  assert.notEqual(rows[4].nextStep, CORRECTION_STEP);
});

// Fehleraudit 29.10.2026, second round (real stands of Orange, 29.10.2026).
function storedRun(run) {
  const value = { schema: 2, producer: 'mac-worker-6-64d66918', runId: run.run_id, runs: [{ run }] };
  const packed = Buffer.concat([Buffer.from('RSART2\0'), zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)))]).toString('base64');
  return { producer: 'mac-worker-6-64d66918', run_id: run.run_id, task_id: run.task_id, packed, digest: crypto.createHash('sha256').update(packed).digest('hex') };
}

test('DesignToLike: a stored design wait names its wait for PM und Design, with or without its text', () => {
  const base = { run_id: '20261029T174218Z-e509-86cbfx407@1793287445532', task_id: '86cbfx407@1793287445532', state: 'paused',
    paused_since: '2026-10-29T17:42:39.531Z', pause_reason: 'designsystem', pause_step: 'prepare', detail: null };
  // As Orange stored it (no text in the stand): no longer „kein lesbarer Blockergrund“.
  const older = checkpointBlocker(storedRun(base));
  assert.deepEqual([older.reasonCode, older.responsibleRole, older.blockerKind], ['design_approval_pending', 'PM und Design', 'waiting_human']);
  assert.match(older.blockerReason, /^Wartet auf Designsystem und Produktionsfreigabe/);
  assert.match(older.nextStep, /startet danach automatisch/);
  // Since the worker fix the stand carries the wait's own text.
  const text = 'Bestehende Designquelle: Kundenwissen fehlt oder ist nicht live lesbar (Kunden/designtolike/produktion/gestaltung.json): RS Hub: Datei in der Newsletter-Wissensbasis nicht gefunden.';
  const current = checkpointBlocker(storedRun({ ...base, run_id: base.run_id + 'x', pause_detail: text }));
  assert.equal(current.blockerReason, text);
  assert.equal(current.responsibleRole, 'PM und Design');
  // Gegenprobe: another pause without text stays unreadable, never guessed.
  const portal = checkpointBlocker(storedRun({ ...base, run_id: base.run_id + 'y', pause_reason: 'portal' }));
  assert.equal(portal.reasonCode, 'blocker_context_missing');
});

test('Gartenfachmarkt24: a Miro board outside the Hub app\'s team is the PM\'s, with the worker step', () => {
  const miro = 'Kurzfassung: Die Mailinhalte des Flows sind nicht lesbar. Laut Briefing stehen sie ausschließlich im verlinkten Miro-Board, und die Miro-App von RS Hub hat auf dieses Board keinen Datenzugriff (HTTP 403).\n\n'
    + 'Ursachen:\n1. Miro-Zugriff fehlt: Das Board liegt nicht in dem Miro-Team, für das die RS-Hub-App freigegeben ist. Board und Einträge liefern beide „kein Zugriff“.\n'
    + '2. Keine andere Quelle gefunden: In der ClickUp-Aufgabe gibt es keine Kommentare oder Anhänge. In der Flow-Datei des Kunden in Figma, im Kunden-Drive '
    + 'und in den Hub-Kundendaten steht kein Winback- oder Replenishment-Inhalt. Mailanzahl, Rollen und Texte werden nicht erfunden.\n\n'
    + 'Nächste Schritte:\n• Board-Inhaber bzw. Miro-Teamadmin: das Board für die RS-Hub-App freigeben, z. B. in das Team mit der installierten App verschieben oder dort teilen.\n'
    + '• Alternativ trägt der PM die Inhalte aus dem Miro-Board in die ClickUp-Aufgabe ein.';
  const context = blockerContext(miro, { state: 'blockiert' });
  assert.deepEqual([context.reasonCode, context.responsibleRole, context.blockerKind], ['source_access_missing', 'PM', 'waiting_human']);
  // The worker typed it technik before its fix: the stored PM code is no unowned code and stays.
  const [row] = applyBlockerContexts([{ status: 'blocked', url: 'https://app.clickup.com/t/86c91h7y0', blockerOwner: 'technik', blockerReason: miro, ...context }], []);
  assert.equal(row.responsibleRole, 'PM');
  // The real cause is longer than the 500 stored characters: the step behind it is not readable here.
  assert.equal(row.nextStep, 'Miro-Board für das Miro-Team der RS-Hub-App freigeben lassen (Board-Inhaber bzw. Miro-Teamadmin) oder die Inhalte in die ClickUp-Aufgabe übertragen; danach neu beauftragen.');
  // A short cause keeps the worker's own step.
  const short = 'Miro-Zugriff fehlt (HTTP 403). Nächste Schritte: • Board-Inhaber bzw. Miro-Teamadmin: das Board für die RS-Hub-App freigeben. • Alternativ überträgt der PM die Inhalte.';
  const [own] = applyBlockerContexts([{ status: 'blocked', url: 'https://app.clickup.com/t/86c91h7y0', blockerReason: short, ...blockerContext(short, { state: 'blockiert' }) }], []);
  assert.equal(own.nextStep, 'Board-Inhaber bzw. Miro-Teamadmin: das Board für die RS-Hub-App freigeben.');
  assert.equal(blockerContext(miro, { owner: 'pm' }).reasonCode, 'source_access_missing', 'the typed PM keeps the specific code');
  // A Mac's Figma right without Miro stays as before.
  assert.notEqual(blockerContext('Das Figma-Konto dieses Macs darf die Datei nur lesen (HTTP 403).', { state: 'technisch_blockiert' }).reasonCode, 'source_access_missing');
});
