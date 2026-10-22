'use strict';
(() => {
  const model = window.MaxMonitorPlanningModel, $ = id => document.getElementById(id);
  let data = null, mode = 'current', period = 'day', mix = null, edited = false, connected = false;
  const number = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
  function draw(changed) {
    const cap = model.capacity(connected ? data?.planning?.evidence : null, mode, period);
    const message = !connected ? 'Verbinde den Team-Server.' : !cap.available ? 'Limits oder Verbrauchswerte werden aktualisiert…'
      : cap.skipped ? `${cap.skipped} ${cap.skipped === 1 ? 'Account' : 'Accounts'} ohne aktuelle Limits nicht eingerechnet.` : '';
    $('planning-message').textContent = message;
    $('planning-message').hidden = !message;
    if (cap.available) mix = !mix || !edited ? model.initial(cap) : model.balance(cap, mix, changed || 'upload');
    for (const kind of model.KINDS) {
      const value = cap.available ? mix[kind] : 0;
      const maximum = model.maximum(cap, kind, kind === 'newsletter' ? undefined : { ...mix, correction: 0, upload: 0 });
      const slider = $(`planning-${kind}`), count = $(`planning-${kind}-count`);
      slider.max = String(maximum); slider.value = String(value); slider.disabled = !cap.available;
      slider.style.setProperty('--progress', `${maximum ? value / maximum * 100 : 0}%`);
      slider.setAttribute('aria-valuetext', `${number.format(value)} ${kind === 'newsletter' ? 'Newsletter' : kind === 'correction' ? 'Korrekturen' : 'Uploads'} pro ${period === 'day' ? 'Tag' : 'Woche'}`);
      count.max = String(maximum); count.value = cap.available ? String(value) : ''; count.disabled = !cap.available;
    }
    const used = model.usage(cap, mix || { newsletter: 0, correction: 0, upload: 0 });
    $('planning-utilization').textContent = cap.available ? `${number.format(used.percent)} % eingeplant` : '—';
    $('planning-meter').setAttribute('aria-valuenow', String(Math.round(used.percent)));
    for (const kind of model.KINDS) $(`planning-share-${kind}`).style.width = `${used.shares[kind]}%`;
    for (const button of document.querySelectorAll('[data-planning-mode]')) button.setAttribute('aria-pressed', String(button.dataset.planningMode === mode));
    for (const button of document.querySelectorAll('[data-planning-period]')) button.setAttribute('aria-pressed', String(button.dataset.planningPeriod === period));
  }
  for (const kind of model.KINDS) for (const suffix of ['', '-count']) {
    $(`planning-${kind}${suffix}`).addEventListener('input', event => {
      if (event.target.value === '' || !Number.isFinite(event.target.valueAsNumber)) return;
      mix[kind] = event.target.valueAsNumber; edited = true; draw(kind);
    });
    $(`planning-${kind}${suffix}`).addEventListener('change', () => draw(kind));
  }
  document.querySelectorAll('[data-planning-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.planningMode; draw(); }));
  document.querySelectorAll('[data-planning-period]').forEach(button => button.addEventListener('click', () => { period = button.dataset.planningPeriod; draw(); }));
  window.MaxMonitorPlanning = {
    update(value) { data = value; connected = true; draw(); },
    invalidate() { connected = false; draw(); },
    reset() { data = null; connected = false; mix = null; edited = false; mode = 'current'; period = 'day'; draw(); }
  };
  draw();
})();
