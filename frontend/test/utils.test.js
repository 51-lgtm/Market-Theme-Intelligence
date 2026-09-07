import test from "node:test";
import assert from "node:assert/strict";
import {
  number,
  fmt,
  pct,
  readLegacyPositions,
  closeSeries,
  safeLink,
  shadowEligible,
} from "../src/utils.js";
test("missing and non-finite market values never become zero", () => {
  for (const v of [null, undefined, "", "0", false, NaN, Infinity]) {
    assert.equal(number(v), null);
    assert.equal(fmt(v), "—");
    assert.equal(pct(v), "—");
  }
  assert.equal(fmt(0), "0.00");
});
test("legacy import keeps valid holdings only and never imports synthetic market price", () => {
  const storage = {
    getItem: (key) => {
      assert.equal(key, "uscmd_ultra_v3");
      return JSON.stringify({
        positions: [
          { ticker: "JMIA", shares: 25, avgCost: 4.1, price: 200, stopPx: 3.8 },
          { ticker: "<script>", shares: 2, avgCost: 3 },
          { ticker: "NVDA", shares: -1, avgCost: 50 },
          { ticker: "MU", shares: 5, avgCost: null },
        ],
      });
    },
  };
  assert.deepEqual(readLegacyPositions(storage), [
    { ticker: "JMIA", shares: 25, average_cost: 4.1, stop: 3.8 },
  ]);
});
test("chart rejects missing close instead of drawing a zero price", () => {
  assert.deepEqual(
    closeSeries([
      { date: "x", close: 100 },
      { date: "y", close: null },
      { date: "z", close: 0 },
      { close: "123" },
    ]),
    [{ date: "x", close: 100, volume: null }],
  );
});
test("evidence URLs reject executable schemes", () => {
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("data:text/html,test"), null);
  assert.equal(safeLink("https://www.sec.gov/x"), "https://www.sec.gov/x");
});
test("Shadow button requires stored decision and explicit no-execution contract", () => {
  assert.equal(
    shadowEligible({ id: "x", action: "BUY", should_execute: false }),
    true,
  );
  for (const d of [
    { action: "BUY", should_execute: false },
    { id: "x", action: "BUY", should_execute: true },
    { id: "x", action: "BUY" },
    { id: "x", action: "TRIM", should_execute: false },
  ])
    assert.equal(shadowEligible(d), false);
  assert.equal(shadowEligible({id:"x", action:"SELL", should_execute:false}),true);
});
