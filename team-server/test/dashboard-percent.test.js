const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(process.env.DASHBOARD_PERCENT_SOURCE || path.join(__dirname, "../public/dashboard.js"), "utf8");
const marker = "  function attentionEntries(";
assert.ok(source.includes(marker));
function element() {
  return {
    children: [], dataset: {}, style: {}, textContent: "",
    append(...children) { this.children.push(...children); },
    setAttribute() {},
  };
}
const context = { window: {}, location: { pathname: "/fleet", search: "" }, URLSearchParams, Intl,
  document: { createElement: element } };
vm.runInNewContext(source.replace(marker,
  "  globalThis.percentUnderTest = { displayPercent, percentText, limitTitle, meter, batteryText, percentTone, " +
  "workerAccountColumn: typeof workerAccountColumn === 'function' ? workerAccountColumn : null }; return;\n" + marker), context);
const { displayPercent, percentText, limitTitle, meter, batteryText, percentTone, workerAccountColumn } = context.percentUnderTest;
const text = node => [node.textContent, ...node.children.map(child => typeof child === "string" ? child : text(child))].join(" ");

test("every integer percentage survives ratio conversion without floating point tails", () => {
  for (let value = 0; value <= 100; value++) {
    assert.equal(percentText(value / 100 * 100), `${value} %`);
    assert.equal(percentText(100 - value / 100 * 100), `${100 - value} %`);
  }
  assert.equal(percentText(56.00000000000001), "56 %");
  assert.equal(percentText(0.1 + 0.2), "0 %");
});

test("unknown and invalid measurements never turn into a real zero or invalid numeric text", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, "56", "", -0.1, 100.1]) {
    assert.equal(displayPercent(value), null);
    assert.equal(percentText(value), "—");
    assert.equal(limitTitle({ percent: value }), "Noch keine Kontingent-Messung");
  }
  assert.equal(percentText(0), "0 %");
  assert.equal(percentText(-0), "0 %");
  assert.equal(percentText(100), "100 %");
});

test("used and available percentages always add up to 100 after display rounding", () => {
  for (let value = 0; value < 100; value += 0.125) {
    const title = limitTitle({ percent: value });
    const [used, available] = [...title.matchAll(/(\d+) %/g)].map(match => Number(match[1]));
    assert.equal(used + available, 100, title);
  }
  assert.equal(limitTitle({ percent: 56.00000000000001 }), "56 % genutzt · 44 % verfügbar");
  assert.equal(limitTitle({ percent: 97.5 }), "98 % genutzt · 2 % verfügbar");
  assert.equal(limitTitle({ percent: 100 }), "100 % genutzt · Limit ausgeschöpft");
  assert.equal(limitTitle({ percent: 56.00000000000001 }, true), "56 % genutzt · Messung veraltet");
});

test("table meters, battery and account cards use the same safe display", () => {
  const limit = { percent: 56.00000000000001 };
  const rendered = meter(limit);
  assert.equal(rendered.children[1].textContent, "56 %");
  assert.equal(rendered.title, "56 % genutzt · 44 % verfügbar");
  assert.equal(batteryText({ batteryPercent: limit.percent })[0], "56 %");
  if (workerAccountColumn) {
    const account = { id: "test", name: "Test", status: "ready", updatedAt: new Date().toISOString(),
      windows: [{ kind: "session", percent: limit.percent }, { kind: "weekly", percent: 6.000000000000001 }] };
    for (const compact of [false, true]) {
      const content = text(workerAccountColumn({}, account, compact));
      assert.match(content, /56 %/);
      assert.match(content, /6 %/);
      assert.doesNotMatch(content, /\d+[.,]\d+\s*%/);
    }
  }
});

test("presentation rounding never changes the measured quota or exhaustion decision", () => {
  const limit = { percent: 99.6 };
  assert.equal(percentText(limit.percent), "100 %");
  assert.equal(percentTone(limit.percent), "warn");
  assert.doesNotMatch(limitTitle(limit), /Limit ausgeschöpft/);
  assert.equal(limit.percent, 99.6);
});
