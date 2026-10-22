const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(process.env.DASHBOARD_ACCOUNT_SOURCE || path.join(__dirname, "../public/dashboard.js"), "utf8");
const marker = "  function attentionEntries(";
assert.ok(source.includes(marker));
const context = { window: {}, location: { pathname: "/fleet", search: "" }, URLSearchParams, Intl,
  document: { createElement: () => ({}) } };
vm.runInNewContext(source.replace(marker,
  "  globalThis.identityUnderTest = machineAccountIdentity; globalThis.figmaUnderTest = machineFigmaIdentity; return;\n" + marker), context);
const identity = context.identityUnderTest;
const machine = (account) => ({ monitoringAccountId: "bound", accounts: [{ accountId: "bound", ...account }] });

test("Claude identity prefers login email over a renamed account", () => {
  const result = identity(machine({ email: "worker@example.com", name: "Production" }));
  assert.equal(result.text, "Claude · worker@example.com");
  assert.match(result.title, /Bezeichnung: Production/);
});

test("older Macs can identify the login when their account name is an email", () => {
  assert.equal(identity(machine({ name: " old@example.com " })).text, "Claude · old@example.com");
  assert.equal(identity(machine({ name: "Production" })).text, "Claude · E-Mail nicht gemeldet");
});

test("an unbound Mac never borrows an email from another account", () => {
  assert.equal(identity({ monitoringAccountId: "missing", accounts: [{ accountId: "other", email: "private@example.com" }] }).text,
    "Claude · kein Account verbunden");
  assert.equal(identity({ accounts: [{ accountId: "other", name: "private@example.com" }] }).text,
    "Claude · kein Account verbunden");
});

test("Figma identity stays independent of Claude and missing evidence remains unknown", () => {
  assert.equal(context.figmaUnderTest(machine({ email: "claude@example.com" })).text, "Figma · noch nicht gemeldet");
  const result = context.figmaUnderTest({ figmaAccount: { email: "figma@example.com", observedAt: "2026-10-20T10:00:00Z" } });
  assert.equal(result.text, "Figma · figma@example.com");
  assert.match(result.title, /Zuletzt vom Figma-Werkzeug auf diesem Mac/);
  const live = context.figmaUnderTest({ figmaAccount: { email: "figma@example.com", observedAt: "2026-10-20T10:00:00Z", source: "mcp-whoami" } });
  assert.match(live.title, /Direkt über die Figma-Verbindung dieses Macs bestätigt/);
});
