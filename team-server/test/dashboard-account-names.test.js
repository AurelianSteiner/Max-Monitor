const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const marker = '  function attentionEntries(';
const context = { window: {}, location: { pathname: '/fleet', search: '' }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker, '  globalThis.identity = claudeAccountIdentity; globalThis.machineIdentity = machineAccountIdentity; return;\n' + marker), context);

test('account names use the complete email prefix and ignore arbitrary aliases', () => {
  for (const email of ['till2@ruegamer-steiner.de', ' First.Last+team@example.test ']) {
    assert.equal(context.identity({email, name:'Claude 1'}).name, email.trim().split('@')[0]);
  }
  assert.equal(context.identity({name:'till3@example.test'}).name, 'till3');
  assert.equal(context.identity({name:'Claude 1'}).name, 'E-Mail nicht hinterlegt');
});
test('single accounts keep full email in the tooltip and never borrow an unbound identity', () => {
  const account = {accountId:'a',name:'Claude 1',email:'till2@example.test'};
  const result = context.machineIdentity({monitoringAccountId:'a',accounts:[account]});
  assert.equal(result.text, 'Claude · till2');
  assert.match(result.title, /till2@example.test/);
  assert.equal(context.machineIdentity({monitoringAccountId:'b',accounts:[account]}).text, 'Claude · kein Account verbunden');
});
