'use strict';
(() => {
  const model = window.MaxMonitorPlanningModel, $ = id => document.getElementById(id);
  const form = $('planning-form');
  const names = { newsletter: 'Newsletter', correction: 'Korrekturen', upload: 'Uploads', translation: 'Übersetzungen', sales: 'Sales' };
  const numbers = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const dates = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
  const bottlenecks = { five_hour: '5-Stunden-Kontingent', seven_day: 'Wochenkontingent', time: 'Arbeitszeit', slots: 'parallele Mac-Plätze', evidence: 'Messbasis', Messbasis: 'Messbasis' };
  let data = null, request = null, config = structuredClone(model.DEFAULTS), revision = 0;
  let dirty = false, saving = false, epoch = 0, result = null, timer = null, connected = false;
  function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; }
  function status(text, error = false) { $('planning-status').textContent = text; $('planning-status').dataset.error = String(error); }
  function markDirty() { dirty = true; $('planning-discard').hidden = false; status('Persönlicher Entwurf · noch nicht im Team gespeichert'); }
  function showFields() {
    for (const input of form.querySelectorAll('[name]')) {
      if (!Object.hasOwn(config, input.name)) continue;
      if (input.type === 'checkbox') input.checked = config[input.name]; else input.value = config[input.name];
    }
    $('planning-save').hidden = !data?.canManage;
    $('planning-save').disabled = saving;
    $('planning-discard').hidden = !dirty;
  }
  function references() {
    const select = $('planning-reference');
    const workers = data?.planning?.evidence?.scheduling?.workers || {};
    const names = data?.planning?.evidence?.names || {};
    select.replaceChildren(el('option', '', 'Referenz wählen…')); select.firstChild.value = '';
    for (const id of Object.keys(workers).sort((a, b) => (names[a] || a).localeCompare(names[b] || b, 'de'))) {
      const option = el('option', '', names[id] || id); option.value = id; select.append(option);
    }
    if (!config.referenceWorker && Object.keys(workers).length) {
      config.referenceWorker = Object.keys(workers).sort((a, b) => Object.values(workers[b].costs || {}).reduce((n, c) => n + (c.weekly_pp?.n || 0), 0)
        - Object.values(workers[a].costs || {}).reduce((n, c) => n + (c.weekly_pp?.n || 0), 0))[0];
    }
    select.value = config.referenceWorker;
  }
  function drawEvidence() {
    const root = $('planning-evidence'); root.replaceChildren();
    const worker = config.referenceWorker, quota = data?.planning?.evidence?.scheduling?.workers?.[worker];
    const accountCosts = model.costsFor(quota, {}, false);
    if (!quota) { root.append(el('p', 'planning-note', 'Wähle zuerst einen Referenz-Mac.')); return; }
    const table = el('table');
    const head = el('thead'), hr = el('tr');
    ['Aufgabenart', 'Minuten', '5 h · Punkte', 'Woche · Punkte'].forEach(t => hr.append(el('th', '', t))); head.append(hr); table.append(head);
    const body = el('tbody');
    for (const kind of model.KINDS) {
      const tr = el('tr'), title = el('th', '', names[kind]); title.scope = 'row';
      title.append(el('small', '', `${accountCosts[kind].n} auswertbar${accountCosts[kind].n < 5 ? ' · Annahme nötig' : ''}`)); tr.append(title);
      for (const [key, label] of [['minutes', 'Minuten'], ['fiveHour', '5 h · Punkte'], ['weekly', 'Woche · Punkte']]) {
        const td = el('td'), input = el('input'); td.dataset.label = label;
        input.type = 'number'; input.min = '.01'; input.max = key === 'minutes' ? '1440' : '100'; input.step = 'any';
        input.inputMode = 'decimal'; input.autocomplete = 'off';
        input.setAttribute('aria-label', `${names[kind]}: ${label} für den Referenz-Account`);
        const metric = accountCosts[kind][key]; input.placeholder = metric ? numbers.format(metric) : 'Fehlt';
        input.value = config.overrides[worker]?.[kind]?.[key] ?? '';
        input.dataset.kind = kind; input.dataset.metric = key;
        td.append(input); tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); root.append(table);
  }
  function draw() {
    clearTimeout(timer);
    $('planning-validation').hidden = true;
    if (!model.validConfig(config)) {
      resetResults();
      $('planning-validation').textContent = 'Prüfe die markierten Eingaben. Arbeitsbeginn plus Stunden darf höchstens 24 sein; neue Claude-Pläne brauchen mindestens ebenso viele neue Macs.';
      $('planning-validation').hidden = false;
      for (const input of form.querySelectorAll('input[type="number"]')) input.setAttribute('aria-invalid', String(!input.validity.valid));
      $('planning-save').disabled = true; $('planning-export').disabled = true;
      $('planning-verdict').dataset.tone = 'unknown';
      $('planning-verdict').replaceChildren(el('h3', '', 'Eingaben prüfen'), el('p', '', 'Die letzte Berechnung gilt nicht für diese Eingaben.'));
      return;
    }
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
    $('planning-save').disabled = saving;
    const source = connected ? data?.planning?.evidence : null;
    if (!source) { resetResults(); return; }
    const baseline = model.evaluate(source, config), expanded = config.extraMacs ? model.evaluate(source, config, true) : null;
    result = { baseline, expanded, config: structuredClone(config), calculatedAt: new Date().toISOString() };
    const current = expanded || baseline, requested = current.requested;
    $('planning-mix').textContent = `${numbers.format(requested.newsletter)} Newsletter + ${numbers.format(requested.correction)} Korrekturen + ${numbers.format(requested.upload)} Uploads`;
    const warnings = [];
    if (!connected || !current.sourceFresh) warnings.push('Verbrauchs- oder Mac-Meldungen sind veraltet. Aktualisiere die Verbrauchswerte.');
    if (config.includeQueue && !source.backlogFresh) warnings.push('Die Queue ist nicht aktuell. Bestehende Arbeit kann unvollständig sein.');
    if (current.missing.length) warnings.push(`Messwerte oder eigene Annahmen fehlen für: ${current.missing.map(k => names[k]).join(', ')}.`);
    if (source.unsupportedBacklog && config.includeQueue) warnings.push(`${source.unsupportedBacklog} bestehende Aufgaben haben keine planbare Aufgabenart.`);
    if (current.missingReference) warnings.push('Wähle einen aktuell gemeldeten Referenz-Mac für den Ausbau.');
    if (!current.machines) warnings.push('Noch keine Macs mit auswertbarer Account-Zuordnung und Platzlimits.');
    if (current.accountsCount > current.calibratedAccounts) warnings.push(`${current.calibratedAccounts} von ${current.accountsCount} Accounts haben eine vollständige Messbasis für diesen Mix. Unvollständige Accounts tragen nur zu belegten Aufgabenarten bei.`);
    if (current.manual || config.extraMacs) warnings.push('Dieses Szenario enthält eigene Annahmen. Zusätzliche Macs und Pläne sind simuliert.');
    const paused = source?.scheduling?.routing?.fleet?.filter(m => m.annahme !== true).length || 0;
    if (config.startMode === 'cycle' && paused) warnings.push(`Der volle Zukunftszyklus plant auch mit ${paused} derzeit pausierten Macs. Für die tatsächliche Produktion muss ihre Annahme wieder möglich sein.`);
    $('planning-warning').hidden = !warnings.length;
    $('planning-warning').replaceChildren(...warnings.map(w => el('p', '', w)));
    const ready = current.ready;
    $('planning-verdict').dataset.tone = !ready ? 'unknown' : current.fits ? 'good' : 'warn';
    $('planning-verdict').replaceChildren(el('h3', '', !ready ? 'Planung noch unvollständig' : current.fits ? 'Dein Mix passt ins Modell' : 'Dein Mix übersteigt die Kapazität'),
      el('p', '', !ready ? 'Ergänze die Messbasis oder prüfe die Hinweise. Die Werte darunter sind eine Teilrechnung.'
        : current.fits ? 'Bestehende Arbeit, Folgeschritte und Reserve sind berücksichtigt.' : `Voraussichtlicher Engpass: ${bottlenecks[current.bottleneck]}. Reduziere die Menge oder prüfe ein Ausbau-Szenario.`));
    $('planning-maximum').textContent = ready ? `${current.limited ? '≥ ' : '≈ '}${numbers.format(current.maximum)}` : '—';
    $('planning-package-detail').textContent = `je ${numbers.format(config.correctionsPerNewsletter)} Korrekturen + ${numbers.format(config.uploadsPerNewsletter)} Uploads · weitere Aufgaben bereits abgezogen`;
    const workdays = current.daily.filter(d => d.hours > 0).length;
    $('planning-per-day').textContent = ready ? `≈ ${numbers.format(current.maximum / Math.max(1, workdays))} Pakete / Betriebstag` : 'Tagesmenge noch offen';
    $('planning-utilization').textContent = `${numbers.format(current.utilization * 100)} % simulierte Mac-Auslastung · bis ${numbers.format(current.quotaPeak)} % Wochenkontingent je Account`;
    $('planning-fleet').textContent = `${current.machines} Macs · ${current.accountsCount} eindeutige Claude-Accounts`;
    $('planning-comparison').hidden = !expanded;
    if (expanded) {
      $('planning-comparison').replaceChildren(el('strong', '', `Bestand ${baseline.ready ? '≈ ' + numbers.format(baseline.maximum) : '—'} → Ausbau ${expanded.ready ? '≈ ' + numbers.format(expanded.maximum) : '—'} Pakete`),
        el('span', 'planning-note', `${config.extraMacs} zusätzliche Macs · ${config.extraAccounts} neue Pläne · 5 h ${numbers.format(config.fiveHourFactor)} × / Woche ${numbers.format(config.weeklyFactor)} × Referenz`));
    }
    $('planning-calendar-label').textContent = config.startMode === 'cycle' ? `${config.horizon === 1 ? 'Nächster Betriebstag' : 'Ab morgen'} · volle Budgets` : 'Ab jetzt · verbleibende Budgets';
    const timeline = $('planning-timeline'); timeline.replaceChildren();
    for (const day of current.daily) {
      const column = el('div', 'planning-day'), plot = el('div', 'planning-day-plot');
      const total = Object.values(day.completed).reduce((a, b) => a + b, 0);
      const utilization = day.capacityHours ? Math.min(1, day.busyHours / day.capacityHours) : 0;
      const bar = el('div', 'planning-day-bar'); bar.style.height = `${utilization * 100}%`;
      for (const kind of model.KINDS) if (day.completed[kind]) {
        const part = el('span', kind); part.style.flex = String(day.kindHours[kind]); bar.append(part);
      }
      plot.append(bar); const date = dates.format(new Date(day.date + 'T12:00:00Z'));
      column.title = `${date}: ${Object.entries(day.completed).filter(([, n]) => n).map(([k, n]) => `${n} ${names[k]}`).join(', ') || 'Keine Aufgaben'} · ${numbers.format(utilization * 100)} % Mac-Auslastung`;
      column.setAttribute('aria-label', column.title);
      column.append(el('span', 'planning-day-count', total ? numbers.format(total) : '—'), plot, el('span', 'planning-day-label', date), el('span', 'planning-day-hours', day.hours ? `${numbers.format(utilization * 100)} %` : 'frei'));
      timeline.append(column);
    }
    $('planning-remaining').replaceChildren(...['newsletter', 'correction', 'upload'].map(k => {
      const item = el('div'); item.append(el('strong', '', ready && current.fits ? `+ ${numbers.format(current.remaining[k])}` : '—'), el('span', '', k === 'newsletter' ? 'Newsletter ohne Folgeschritte' : names[k])); return item;
    }));
    const excluded = current.excluded.map(w => `${source.names[w.worker] || w.worker}: ${w.reason}`);
    $('planning-excluded').textContent = `${excluded.length ? 'Nicht eingerechnet: ' + excluded.join(' · ') + '. ' : ''}${source.deferred || 0} pausierte, blockierte oder manuelle Aufgaben außerhalb der Queue-Reserve.`;
    $('planning-export').disabled = !ready;
  }
  function resetResults() {
    result = null; $('planning-export').disabled = true;
    $('planning-verdict').dataset.tone = 'unknown';
    $('planning-verdict').replaceChildren(el('h3', '', 'Keine aktuelle Datenbasis'), el('p', '', 'Verbinde den Team-Server und aktualisiere die Verbrauchswerte.'));
    $('planning-maximum').textContent = '—'; $('planning-timeline').replaceChildren(); $('planning-remaining').replaceChildren();
    $('planning-package-detail').textContent = ''; $('planning-per-day').textContent = '—'; $('planning-utilization').textContent = '—'; $('planning-fleet').textContent = '—';
    $('planning-comparison').hidden = true;
  }
  form.addEventListener('input', event => {
    const input = event.target;
    if (input.dataset.kind) {
      const worker = config.referenceWorker, kind = input.dataset.kind, key = input.dataset.metric;
      config.overrides[worker] ??= {}; config.overrides[worker][kind] ??= {};
      if (input.value === '') delete config.overrides[worker][kind][key]; else config.overrides[worker][kind][key] = input.valueAsNumber;
    } else if (Object.hasOwn(config, input.name)) {
      config[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' || ['horizon', 'workdays'].includes(input.name) ? Number(input.value) : input.value;
      if (input.name === 'referenceWorker') drawEvidence();
    } else return;
    markDirty(); clearTimeout(timer); timer = setTimeout(draw, 180);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); clearTimeout(timer); draw();
    if (!request || saving || !data?.canManage || !model.validConfig(config)) return;
    const attempt = epoch, savedConfig = structuredClone(config), expectedRevision = revision;
    saving = true; $('planning-save').disabled = true; status('Teamplanung wird gespeichert…');
    try {
      const response = await request('/planning', 'PATCH', { revision: expectedRevision, config: savedConfig });
      if (attempt !== epoch) return;
      data.planning = { ...data.planning, ...response.planning }; revision = response.planning.revision;
      dirty = JSON.stringify(config) !== JSON.stringify(savedConfig); status(dirty ? 'Teamplanung gespeichert · neuere Eingaben bleiben im Entwurf' : 'Teamplanung gespeichert.');
    } catch (error) { if (attempt === epoch) status(error.message, true); }
    finally { if (attempt === epoch) { saving = false; showFields(); } }
  });
  $('planning-discard').addEventListener('click', () => {
    config = structuredClone(data?.planning?.config || model.DEFAULTS); revision = data?.planning?.revision || 0; dirty = false;
    status('Entwurf verworfen.'); references(); showFields(); drawEvidence(); draw();
    window.MaxMonitorConsumption?.refresh();
  });
  $('planning-export').addEventListener('click', () => {
    if (!result) return;
    const current = result.expanded || result.baseline;
    const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
    const rows = [['Max Monitor · Kapazitätsmodell', result.calculatedAt], ['Modus', config.startMode], ['Reserve %', config.reserve],
      ['Newsletter-Pakete im Modell', current.maximum], ['Korrekturen je Newsletter', config.correctionsPerNewsletter], ['Uploads je Newsletter', config.uploadsPerNewsletter],
      ['Macs', current.machines], ['Eindeutige Accounts', current.accountsCount], ['Eigene Annahmen', current.manual || config.extraMacs > 0],
      ['5-h-Kapazitätsfaktor', config.fiveHourFactor], ['Wochen-Kapazitätsfaktor', config.weeklyFactor],
      ['Datum', 'Newsletter', 'Korrekturen', 'Uploads', 'Übersetzungen', 'Sales', 'Mac-Auslastung %'],
      ...current.daily.map(d => [d.date, ...model.KINDS.map(k => d.completed[k]), d.capacityHours ? Math.round(d.busyHours / d.capacityHours * 100) : 0])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(quote).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = el('a'); link.href = url; link.download = 'max-monitor-planbarkeit.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.MaxMonitorPlanning = {
    update(value, fetcher) {
      data = value; request = fetcher; connected = true;
      if (!dirty && !saving) { config = structuredClone(value?.planning?.config || model.DEFAULTS); revision = value?.planning?.revision || 0; references(); showFields(); drawEvidence(); }
      draw();
    },
    invalidate() { connected = false; resetResults(); },
    reset() { epoch++; clearTimeout(timer); data = null; request = null; dirty = false; saving = false; connected = false;
      config = structuredClone(model.DEFAULTS); revision = 0; status(''); references(); showFields(); drawEvidence(); resetResults(); $('planning-warning').hidden = true; }
  };
  showFields();
})();
