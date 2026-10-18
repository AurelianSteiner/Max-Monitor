const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));

function dashboard() {
  let now = Date.parse('2026-10-18T22:22:00Z');
  class Clock extends Date { static now() { return now; } }
  const elements = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, dataset: {}, textContent: '' });
    return elements.get(id);
  };
  const calls = { refresh: 0, start: 0, streamAbort: 0, fetchAbort: 0 };
  const context = {
    window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: { hidden: false, getElementById: element, addEventListener: (name, callback) => documentEvents.set(name, callback) },
    location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl, Date: Clock,
    clearTimeout() {}, calls,
  };
  vm.runInNewContext(source.replace(marker, `
    refresh = () => { calls.refresh++; };
    startLive = () => { calls.start++; };
    globalThis.audit = {
      syncStatus, resumeLive, watchLiveEvents,
      state(age = 0, options = {}) {
        snapshot = {}; snapshotReceivedAt = Date.now() - age;
        credentials = options.connected === false ? null : {teamId: 'test', token: 'test'};
        busy = Boolean(options.busy); streamConnected = true; refreshQueued = false; lastResumeAt = -Infinity;
        query = 'Halloween'; workerFilter = 'mac-1'; view = 'queue';
        fetchController = {abort() { calls.fetchAbort++; }};
        streamController = {abort() { calls.streamAbort++; }};
      },
      selection() { return {query, workerFilter, view, refreshQueued}; }
    }; return;
` + marker), context);
  return { ...context.audit, calls, element, windowEvents, documentEvents, document: context.document,
    advance(ms) { now += ms; } };
}

test('an open event stream never labels a six-hour-old snapshot Live', () => {
  const d = dashboard();
  d.state(6 * 3600000); d.syncStatus();
  assert.equal(d.element('sync-status').dataset.state, 'error');
  assert.equal(d.element('sync-status').textContent, 'Stand veraltet · 18:22');
  d.state(90000); d.syncStatus();
  assert.equal(d.element('sync-status').dataset.state, 'live');
  d.state(90001); d.syncStatus();
  assert.equal(d.element('sync-status').dataset.state, 'error');
});

test('focus and native reactivation read fresh data and keep the current filters and tab', () => {
  const d = dashboard();
  d.state(6 * 3600000); d.watchLiveEvents();
  d.windowEvents.get('max-monitor-resume')();
  assert.equal(d.calls.refresh, 1);
  assert.equal(d.calls.streamAbort, 1);
  assert.equal(d.calls.start, 1);
  assert.equal(d.selection().query, 'Halloween');
  assert.equal(d.selection().workerFilter, 'mac-1');
  assert.equal(d.selection().view, 'queue');
  d.windowEvents.get('focus')();
  d.windowEvents.get('pageshow')();
  assert.equal(d.calls.refresh, 1, 'coincident WebKit/native events share one read');
  d.advance(1000); d.windowEvents.get('focus')();
  assert.equal(d.calls.refresh, 2);
});

test('resume queues a fresh read behind a busy request and cancels only an obsolete one', () => {
  for (const age of [1000, 6 * 3600000]) {
    const d = dashboard(); d.state(age, { busy: true }); d.resumeLive();
    assert.equal(d.calls.refresh, 0);
    assert.equal(d.selection().refreshQueued, true);
    assert.equal(d.calls.fetchAbort, age > 90000 ? 1 : 0);
    assert.equal(d.calls.start, 1);
  }
});

test('hidden or disconnected viewers do not start resume reads; becoming visible does', () => {
  const d = dashboard(); d.state(); d.watchLiveEvents(); d.document.hidden = true;
  d.windowEvents.get('max-monitor-resume')();
  assert.equal(d.calls.refresh, 0);
  d.documentEvents.get('visibilitychange')();
  assert.equal(d.calls.streamAbort, 1);
  d.document.hidden = false; d.documentEvents.get('visibilitychange')();
  assert.equal(d.calls.refresh, 1);
  d.state(0, { connected: false }); d.resumeLive();
  assert.equal(d.calls.refresh, 1);
});
