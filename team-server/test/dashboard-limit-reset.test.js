const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.DASHBOARD_RESET_SOURCE || path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl,
  document: { createElement: () => ({}) } };
vm.runInNewContext(source.replace(marker,
  '  globalThis.resetUnderTest = limitReset; return;\n' + marker), context);
const reset = context.resetUnderTest;

test('both windows show their own compact reset at every utilization', () => {
  for (const percent of [0, 1, 84, 85, 100, null]) {
    assert.equal(reset({ percent, resetsAt: '2030-10-21T12:30:00Z' }).textContent, 'Reset Mo 21.10. 14:30');
    assert.equal(reset({ percent, resetsAt: '2030-10-26T14:00:00Z' }).textContent, 'Reset Sa 26.10. 16:00');
  }
});

test('an elapsed reset retains its date and time until a new measurement arrives', () => {
  const note = reset({ percent: 100, resetsAt: '2020-01-06T13:30:00Z' });
  assert.equal(note.textContent, 'Reset Mo 06.01. 14:30');
  assert.match(note.title, /Neue Messung ausstehend/);
});

test('missing or invalid reset timestamps remain explicitly unknown', () => {
  for (const limit of [null, undefined, {}, { percent: 0 }, { percent: 100, resetsAt: 'invalid' }]) {
    assert.equal(reset(limit).textContent, 'Reset unbekannt');
  }
});

test('reset dates use Berlin local time on either side of the daylight saving change', () => {
  assert.equal(reset({ resetsAt: '2030-10-26T22:30:00Z' }).textContent, 'Reset So 27.10. 00:30');
  assert.equal(reset({ resetsAt: '2030-10-27T23:30:00Z' }).textContent, 'Reset Mo 28.10. 00:30');
});

test('stale measurements keep their reset visible with a freshness note', () => {
  const note = reset({ percent: 20, resetsAt: '2030-10-21T12:30:00Z' }, true);
  assert.equal(note.textContent, 'Reset Mo 21.10. 14:30');
  assert.match(note.title, /Messung veraltet/);
});
