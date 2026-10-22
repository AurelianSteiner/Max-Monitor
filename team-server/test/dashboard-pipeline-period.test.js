const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the dashboard's actual date filter without initializing the DOM.
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
function dashboard(search = '') {
  const context = { window: {}, location: { pathname: '/fleet', search }, URLSearchParams, Intl };
  vm.runInNewContext(source.replace(marker,
    '  globalThis.periodUnderTest = { tasksInPeriod, pipelinePeriod, queuePeriod }; return;\n' + marker), context);
  return context.periodUnderTest;
}
const { tasksInPeriod } = dashboard();
const ids = (items, now) => Array.from(tasksInPeriod(items, 'today', Date.parse(now)), item => item.id);
const task = (id, updatedAt, extra = {}) => ({ id, updatedAt, status: 'queued', ...extra });

test('pipeline starts with today while ordinary queue navigation retains the full queue', () => {
  assert.equal(dashboard().pipelinePeriod, 'today');
  assert.equal(dashboard().queuePeriod, 'all');
  assert.equal(dashboard('?pipeline-period=all&queue-period=today').pipelinePeriod, 'all');
  assert.equal(dashboard('?pipeline-period=all&queue-period=today').queuePeriod, 'today');
  assert.equal(dashboard('?pipeline-period=invalid&queue-period=invalid').pipelinePeriod, 'today');
});

test('today uses Berlin midnight, excludes yesterday and tomorrow, and accepts offset timestamps', () => {
  const items = [task('yesterday', '2026-10-13T21:59:59.999Z'),
    task('midnight', '2026-10-13T22:00:00Z'), task('day', '2026-10-14T12:00:00+02:00'),
    task('end', '2026-10-14T21:59:59.999Z'), task('tomorrow', '2026-10-14T22:00:00Z')];
  assert.deepEqual(ids(items, '2026-10-14T12:00:00Z'), ['midnight', 'day', 'end']);
  assert.deepEqual(ids(items, '2026-10-14T22:00:00Z'), ['tomorrow']);
});

test('calendar days correctly span the 23-hour and 25-hour daylight saving transitions', () => {
  for (const [now, start, end] of [
    ['2026-03-29T12:00:00Z', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'],
    ['2026-10-25T12:00:00Z', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z'],
  ]) {
    const items = [task('before', new Date(Date.parse(start) - 1).toISOString()),
      task('start', start), task('last', new Date(Date.parse(end) - 1).toISOString()), task('after', end)];
    assert.deepEqual(ids(items, now), ['start', 'last']);
  }
});

test('manual completion belongs to its completion day, even when the source timestamp is older', () => {
  const items = [task('finished-today', '2026-10-12T12:00:00Z',
    { status: 'completed', completedAt: '2026-10-14T08:00:00Z' }),
  task('finished-yesterday', '2026-10-14T09:00:00Z',
    { status: 'completed', completedAt: '2026-10-13T08:00:00Z' }),
  task('automated-today', '2026-10-14T08:00:00Z', { status: 'completed' }),
  task('reopened', '2026-10-14T10:00:00Z', { completedAt: '2026-10-12T08:00:00Z' })];
  assert.deepEqual(ids(items, '2026-10-14T12:00:00Z'), ['finished-today', 'automated-today', 'reopened']);
});

test('undated or invalid tasks are excluded from today and retained in overall statistics', () => {
  const items = [task('old', '2026-10-01T12:00:00Z'), task('missing'), task('invalid', 'invalid')];
  assert.deepEqual(ids(items, '2026-10-14T12:00:00Z'), []);
  assert.equal(tasksInPeriod(items, 'all', Date.parse('2026-10-14T12:00:00Z')), items);
});
