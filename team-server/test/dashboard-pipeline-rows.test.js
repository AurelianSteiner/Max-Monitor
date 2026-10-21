const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the overview's real pipeline grouping without initializing the DOM.
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker, '  globalThis.pipelineRows = pipelineRows; return;\n' + marker), context);
const task = (workflow, status, extra = {}) => ({ id: `${workflow}-${Math.random()}`, workflow, status, ...extra });
const count = (row, stage) => row.counts.get(stage);

test('content kinds of one workflow share a single pipeline row', () => {
  const rows = context.pipelineRows([
    task('newsletter', 'blocked', { contentKind: 'flow' }),
    task('newsletter', 'completed', { contentKind: 'flow' }),
    task('newsletter', 'blocked', { contentKind: 'newsletter' }),
    task('newsletter', 'clarification', { contentKind: 'newsletter' }),
    task('upload', 'completed', { contentKind: 'flow' }),
    task('upload', 'queued', { contentKind: 'newsletter', workerId: 'mac-1' }),
  ]);
  assert.deepEqual(Array.from(rows, row => row.name), ['Pre-Gen', 'Klaviyo-Upload']);
  const [pregen, upload] = rows;
  assert.equal(pregen.value, 'newsletter');
  assert.equal(count(pregen, 'blocked'), 2);
  assert.equal(count(pregen, 'clarification'), 1);
  assert.equal(count(pregen, 'completed'), 1);
  assert.equal(pregen.open, 3);
  assert.deepEqual(Object.fromEntries(pregen.kinds), { Flows: 1, Newsletter: 2 });
  assert.equal(count(upload, 'queued'), 1);
  assert.equal(upload.open, 1);
});

test('rows follow Pre-Gen, Upload, Korrektur, Übersetzung and failures count as blocked', () => {
  const rows = context.pipelineRows([
    task('sales', 'queued'),
    task('translation', 'running', { contentKind: 'newsletter' }),
    task('correction', 'failed'),
    task('correction', 'blocked'),
    task('upload', 'completed', { contentKind: 'flow' }),
    task('newsletter', 'running', { contentKind: 'popup' }),
  ]);
  assert.deepEqual(Array.from(rows, row => row.value), ['newsletter', 'upload', 'correction', 'translation', 'sales']);
  const correction = rows[2];
  assert.equal(count(correction, 'blocked'), 2);
  assert.equal(correction.counts.has('failed'), false);
  assert.equal(correction.open, 2);
  assert.equal(correction.kinds.size, 0);
});
