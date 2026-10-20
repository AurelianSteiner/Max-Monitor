import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { blockerContext, checkpointBlocker, currentPm, pmFieldState, applyBlockerContexts, summary, clip, PM_FIELD_ID, STAMMDATEN_ROLE } from './blocker-context.mjs';
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
  assert.deepEqual(pmFieldState(field([user('1', 'A'), user('2', 'B')])), { read: true, names: ['A', 'B'] });
  assert.deepEqual(currentPm(field([user('1', 'A'), user('2', 'B')])), {});
});
