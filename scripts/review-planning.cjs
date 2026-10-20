// Real-browser acceptance against an isolated real relay with synthetic evidence.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/review-planning.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createFleetStore } = require('../team-server/fleet');
const { KINDS } = require('../team-server/public/planning-model');
const output = path.resolve(process.argv[2] || 'build/planning-review');

(async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-browser-'));
  const teamId = 'PLANDEMO', token = 'isolated-planning-review', now = Date.now(), at = new Date(now).toISOString();
  let browser, server;
  fs.mkdirSync(output, { recursive: true });
  try {
    const store = createFleetStore(folder), team = path.join(folder, teamId), publicDir = path.join(folder, 'public');
    const ids = ['macbook-1', 'macbook-2', 'newsletter-mac-141b2976'];
    const members = [], workers = {}, fleet = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], member = { id, name: id, role: 'member', macWorker: true, token: 'review-worker-' + i };
      members.push(member);
      store.heartbeat(teamId, { role: 'member', member }, { deviceId: `610be10e-8a00-4e00-b000-00000000000${i + 1}`, workerId: id, name: id, reportedAt: at, limits: [] });
      const metric = n => ({ n: 12, mean: n, sd: n / 5 });
      const costs = Object.fromEntries(KINDS.map((k, index) => [k, { five_hour_pp: metric([10.5, 6.5, 3.2, 6, 20][index]),
        weekly_pp: metric([1.5, 1, .5, 1, 3][index]), duration_seconds: metric([3600, 1800, 900, 1800, 7200][index]) }]));
      workers[id] = { account: 'account-' + i, costs, windows: { five_hour: { used: 10, at: now / 1000, reset: now / 1000 + 14400 },
        seven_day: { used: 35, at: now / 1000, reset: now / 1000 + 86400 * 6 } } };
      fleet.push({ worker_id: id, seen_at: at, annahme: true, occupied_tasks: 0, max_tasks: 2,
        plaetze: { newsletter: 2, korrektur: 2, klaviyo: 2, translation: 2 } });
    }
    fs.writeFileSync(path.join(team, 'members.json'), JSON.stringify(members));
    store.updateQueue(teamId, { source: { name: 'Browser acceptance fixture', lastSuccessAt: at }, tasks: [
      { id: 'queued-newsletter', title: 'Test-Newsletter', workflow: 'newsletter', status: 'queued', tags: ['pre gen · wartet'] },
      { id: 'pm-wait', title: 'Freigabe offen', workflow: 'correction', status: 'clarification', tags: [] }
    ] });
    fs.mkdirSync(publicDir);
    const summary = { schema: 2, generated_at: at, by_kind: KINDS.map(k => ({key:k, closed: 12, ...structuredClone(workers[ids[0]].costs[k])})), closed: 100, settings: [], accounts: [], by_account_kind: [],
      scheduling: { schema: 1, generated_at: at, workers, routing: { available: true, fleet, jobs: [] } } };
    const publish = () => fs.writeFileSync(path.join(publicDir, teamId + '.json'), JSON.stringify(summary));
    const newsletter = summary.by_kind.find(row => row.key === 'newsletter');
    const original = structuredClone(summary.by_kind);
    publish();
    process.env.DATA_DIR = folder; process.env.TEAM_TOKEN = token; process.env.QUOTA_PUBLIC_DIR = publicDir;
    ({ server } = require('../team-server/server')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, timeout: 15000 });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ teamId, token }) => { window.__MAX_MONITOR__ = { teamId, token }; }, { teamId, token });
    await page.goto(origin + '/fleet?view=usage&usage-tab=planning', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Number(document.querySelector('#planning-newsletter-count').value) > 0);
    const current = Number(await page.locator('#planning-newsletter-count').inputValue());
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '0');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '0');
    assert.equal(await page.locator('#usage-planning [type="range"]').count(), 3);
    assert.equal(await page.locator('#usage-planning button').count(), 4);
    assert.equal(await page.locator('#usage-planning details, #usage-planning select, #planning-export, #planning-save').count(), 0);
    newsletter.five_hour_pp.mean = 8; newsletter.weekly_pp.mean = 1; publish();
    await page.evaluate(() => window.MaxMonitorConsumption.refresh());
    assert.equal(await page.locator('#planning-newsletter-count').inputValue(), '27');
    assert.ok(Number(await page.locator('#planning-newsletter-count').inputValue()) > current);
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '0');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '0');
    await page.getByRole('tab', { name: 'Verbrauch', exact: true }).click();
    const consumption = page.locator('#consumption-body tr').filter({ has: page.getByRole('rowheader', { name: 'Pre-Gen', exact: true }) });
    assert.match(await consumption.locator('td').nth(1).innerText(), /8,0/);
    assert.match(await consumption.locator('td').nth(2).innerText(), /1,0/);
    assert.equal(await page.locator('#consumption-totals').innerText(), '36 abgeschlossen');
    assert.equal(await page.getByRole('heading', { name: 'Durchschnitt der letzten 5 Tage', exact: true }).count(), 1);
    await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).click();
    summary.by_kind = structuredClone(original); publish();
    await page.evaluate(() => window.MaxMonitorConsumption.refresh());
    assert.equal(Number(await page.locator('#planning-newsletter-count').inputValue()), current);
    await page.getByRole('button', { name: 'Alles bei 0 %', exact: true }).click();
    assert.ok(Number(await page.locator('#planning-newsletter-count').inputValue()) > current);
    await page.getByRole('button', { name: 'Pro Woche', exact: true }).click();
    assert.equal(await page.locator('#planning-newsletter-count').inputValue(), '200');
    await page.locator('#planning-newsletter-count').fill('100');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '100');
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '100');
    await page.locator('#planning-upload-count').fill('50');
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '125');
    summary.by_kind[0].five_hour_pp.mean = 8; summary.by_kind[0].weekly_pp.mean = 1; publish();
    await page.evaluate(() => window.MaxMonitorConsumption.refresh());
    assert.equal(await page.locator('#planning-newsletter-count').inputValue(), '100');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '50');
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '175');
    summary.by_kind = structuredClone(original); publish();
    await page.evaluate(() => window.MaxMonitorConsumption.refresh());
    assert.equal(await page.locator('#planning-correction-count').inputValue(), '125');
    await page.locator('#planning-correction-count').fill('150');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '0');
    await page.getByRole('slider', { name: 'Uploads', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#planning-upload-count').inputValue(), '1');
    await page.route('**/consumption', route => route.abort());
    // The regular refresh is in the shared toolbar; planning has no extra controls.
    await page.locator('#refresh').click();
    await page.locator('#planning-message').filter({ hasText: 'Verbinde' }).waitFor();
    assert.equal(await page.locator('#planning-newsletter-count').inputValue(), '');
    assert.equal(await page.locator('#planning-newsletter').isDisabled(), true);
    await page.unroute('**/consumption'); await page.locator('#refresh').click();
    await page.waitForFunction(() => !document.querySelector('#planning-newsletter').disabled);
    await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Nächste Aufgabe', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).click();
    await page.locator('#planning-newsletter-count').fill('100');
    await page.getByRole('heading', { name: 'Kapazität verteilen', exact: true }).click();
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: 'Alles bei 0 %', exact: true }).hover();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `planning-${width}.png`), fullPage: true });
      await page.getByRole('tab', { name: 'Verbrauch', exact: true }).click();
      await page.screenshot({ path: path.join(output, `consumption-${width}.png`), fullPage: true });
      await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal page overflow at ${width}`);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'review.json'), JSON.stringify({ passed: true, viewports: ['1440x900', '1024x768', '390x844'],
      checks: ['two switches', 'three sliders', 'current/full', 'day/week', 'shared live averages', 'capacity rises after optimization', 'selected mix recalibrates after average change', 'five-day consumption count', 'upload follows newsletter', 'correction rebalance', 'upload rebalance', 'keyboard', 'connection recovery', 'responsive', 'no console errors'], errors }, null, 2));
    console.log('Browser acceptance passed:', output);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
