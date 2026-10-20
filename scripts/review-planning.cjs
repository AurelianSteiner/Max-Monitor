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
    const summary = { schema: 2, generated_at: at, by_kind: [], closed: 100, settings: [], accounts: [], by_account_kind: [],
      scheduling: { schema: 1, generated_at: at, workers, routing: { available: true, fleet, jobs: [] } } };
    fs.writeFileSync(path.join(publicDir, teamId + '.json'), JSON.stringify(summary));
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
    await page.locator('#planning-verdict h3').filter({ hasText: 'passt ins Modell' }).waitFor();
    const baseMaximum = Number((await page.locator('#planning-maximum').innerText()).replace(/\D/g, ''));
    assert.ok(baseMaximum > 0);
    await page.screenshot({ path: path.join(output, 'planning-1440-before.png'), fullPage: true });
    await page.locator('[name="newsletters"]').fill('500');
    await page.locator('#planning-verdict h3').filter({ hasText: 'übersteigt' }).waitFor();
    await page.locator('[name="newsletters"]').fill('-1');
    await page.locator('#planning-validation').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#planning-maximum').innerText(), '—');
    await page.locator('#planning-discard').click();
    await page.locator('#planning-verdict h3').filter({ hasText: 'passt ins Modell' }).waitFor();
    await page.locator('#planning-expansion summary').click();
    await page.locator('[name="extraMacs"]').fill('2');
    await page.locator('[name="extraAccounts"]').fill('2');
    await page.locator('#planning-comparison').waitFor({ state: 'visible' });
    await page.waitForFunction(base => Number(document.querySelector('#planning-maximum').textContent.replace(/\D/g, '')) > base, baseMaximum);
    const saved = page.waitForResponse(r => r.url().endsWith('/planning') && r.request().method() === 'PATCH');
    await page.locator('#planning-save').click(); assert.equal((await saved).status(), 200);
    await page.locator('#planning-status').filter({ hasText: 'gespeichert.' }).waitFor();
    const call = async (route, method = 'GET', body) => {
      const response = await fetch(origin + '/v1/teams/' + teamId + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const current = (await call('/consumption')).body.planning;
    assert.equal(current.revision, 1); assert.equal(current.config.extraAccounts, 2);
    await call('/planning', 'PATCH', { revision: 1, config: { ...current.config, newsletters: 11 } });
    await page.locator('[name="newsletters"]').fill('12');
    await page.locator('#planning-save').click();
    await page.locator('#planning-status').filter({ hasText: 'inzwischen geändert' }).waitFor();
    await page.locator('#planning-discard').click();
    await page.waitForFunction(() => document.querySelector('[name="newsletters"]').value === '11');
    const downloadPromise = page.waitForEvent('download'); await page.locator('#planning-export').click();
    const download = await downloadPromise; await download.saveAs(path.join(output, 'plan.csv'));
    assert.match(fs.readFileSync(path.join(output, 'plan.csv'), 'utf8'), /Eindeutige Accounts/);
    await page.route('**/consumption', route => route.abort());
    await page.locator('#consumption-retry').click();
    await page.locator('#planning-verdict h3').filter({ hasText: 'Keine aktuelle Datenbasis' }).waitFor();
    assert.equal(await page.locator('#planning-maximum').innerText(), '—');
    await page.unroute('**/consumption'); await page.locator('#consumption-retry').click();
    await page.locator('#planning-verdict h3').filter({ hasText: 'passt ins Modell' }).waitFor();
    await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Nächste Aufgabe', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Planbarkeit', exact: true }).click();
    // Review expanded controls and saved selected state at all required widths.
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#usage-planning-tab').hover();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `planning-${width}-after.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal page overflow at ${width}`);
    }
    await page.locator('.planning-results details summary').click();
    await page.locator('.planning-method summary').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'planning-390-evidence.png'), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'review.json'), JSON.stringify({ passed: true, viewports: ['1440x900', '1024x768', '390x844'], baseMaximum,
      checks: ['mixed workload', 'overload', 'validation', 'expansion', 'persisted readback', 'revision conflict', 'discard refresh', 'CSV', 'connection loss', 'recovery', 'keyboard tabs', 'responsive overflow', 'details', 'console'], errors }, null, 2));
    console.log('Browser acceptance passed:', output);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
