const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/dashboard.js"), "utf8");
const marker = "  function attentionEntries(";
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: "/fleet", search: "" }, URLSearchParams, Intl };
vm.runInNewContext(source.replace(marker,
  "  globalThis.countUnderTest = claudeAccountCount; return;\n" + marker), context);
const count = context.countUnderTest;
const bound = (provider = "claude") => ({ monitoringAccountId: "monitor", accounts: [{ accountId: "monitor", provider }] });
const pool = () => ({ accounts: [{ id: "primary", name: "Claude 1" }, { id: "account-2", name: "Claude 2" }] });

test("two worker accounts replace rather than add to the separate monitoring login", () => {
  assert.equal(count([{ ...bound(), claudeAccounts: pool() }, bound()]), 3);
});

test("local slot IDs and generic labels on different Macs are counted independently", () => {
  assert.equal(count([{ claudeAccounts: pool() }, { claudeAccounts: pool() }]), 4);
});

test("only explicitly bound Claude monitoring accounts provide the single-account fallback", () => {
  assert.equal(count([{}, bound("codex"), { ...bound(), monitoringAccountId: "missing" },
    { accounts: bound().accounts }, { ...bound(), claudeAccounts: { accounts: [] } }]), 1);
  assert.equal(count([]), 0);
});

test("limit exhaustion, stale usage and offline Macs do not remove configured accounts", () => {
  const accounts = pool();
  accounts.accounts[0] = { ...accounts.accounts[0], status: "limited", stale: true };
  accounts.accounts[1] = { ...accounts.accounts[1], status: "error" };
  assert.equal(count([{ status: "offline", claudeAccounts: accounts }, { ...bound(), status: "offline" }]), 3);
});
