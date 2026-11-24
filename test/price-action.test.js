import test from "node:test";
import assert from "node:assert/strict";
import { detectPivots, classifyStructure, detectStructureEvents } from "../src/market-structure.js";
import {
  detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps, detectOrderBlocks,
  detectBreakerBlocks, detectMitigationBlocks, detectRange, detectRangeDeviations, detectOTE, detectCRT
} from "../src/zones.js";

const candle = (open, high, low, close, timestamp, volume = 100) => ({ open, high, low, close, timestamp, volume, closed: true });

test("pivots are unavailable until right-side candles close", () => {
  const rows = [candle(1,2,0,1,1), candle(2,5,1,4,2), candle(2,3,1,2,3), candle(2,4,1,3,4)];
  const pivots = detectPivots(rows, { leftBars: 1, rightBars: 1 });
  assert.ok(pivots.some(p => p.type === "HIGH" && p.index === 1 && p.confirmedAt === 2));
  assert.ok(!pivots.some(p => p.confirmedAt < p.index + 1));
});

test("structure break cannot occur before pivot confirmation", () => {
  const rows = [
    candle(1,2,0,1,1), candle(2,5,1,4,2), candle(2,3,1,2,3),
    candle(2,4,1,3,4), candle(3,6,2,5.5,5)
  ];
  const pivots = [{ type: "HIGH", index: 1, confirmedAt: 2, price: 5 }];
  const events = detectStructureEvents(rows, pivots);
  assert.equal(events.length, 1);
  assert.equal(events[0].index, 4);
  assert.equal(events[0].type, "BOS");
  assert.equal(events[0].msb, true);
});

test("structure labels distinguish HH, LH, HL and LL", () => {
  const pivots = [
    { type: "HIGH", price: 10 }, { type: "HIGH", price: 12 },
    { type: "LOW", price: 5 }, { type: "LOW", price: 4 }
  ];
  assert.deepEqual(classifyStructure(pivots).map(x => x.label), ["H", "HH", "L", "LL"]);
});

test("FVG is identified and classified after mitigation/fill", () => {
  const rows = [
    candle(8,10,6,9,1), candle(10,12,9,11,2), candle(12,14,11,13,3),
    candle(13,14,10.5,11,4), candle(11,12,9.5,10,5)
  ];
  const gaps = detectFairValueGaps(rows);
  assert.equal(gaps[0].type, "BULLISH_FVG");
  assert.equal(gaps[0].status, "FILLED");
});

test("liquidity sweep search starts after the pool is confirmed", () => {
  const rows = [
    candle(8,10,7,9,1), candle(9,10,8,9,2), candle(9,9.5,8,9,3),
    candle(9,11,8,9.5,4), candle(9,10.5,8,9,5), candle(9,11,8.5,9.5,6)
  ];
  const pools = detectLiquidityPools([
    { type: "HIGH", index: 0, confirmedAt: 2, price: 10 },
    { type: "HIGH", index: 1, confirmedAt: 3, price: 10.001 }
  ], { tolerance: 0.001, minTouches: 2 });
  assert.equal(pools.length, 1);
  const sweeps = detectLiquiditySweeps(rows, pools);
  assert.equal(sweeps[0].index, 3);
});

test("order blocks, mitigation and breaker states are derived from confirmed events", () => {
  const rows = [
    candle(8,10,7,9,1), candle(10,11,8,9,2), candle(9,13,8.5,12,3),
    candle(12,12.5,7,8,4), candle(8,10,7.5,9,5), candle(9,10,8,9.5,6)
  ];
  const blocks = detectOrderBlocks(rows, [{ index: 2, direction: "BULLISH" }], { lookback: 3 });
  assert.equal(blocks[0].type, "BULLISH_OB");
  assert.equal(blocks[0].originIndex, 1);
  assert.equal(blocks[0].status, "INVALIDATED");
  assert.equal(detectMitigationBlocks(rows, blocks).length, 0);
  assert.equal(detectBreakerBlocks(rows, blocks).length, 1);
});

test("range deviation requires wick outside and close back inside", () => {
  const rows = [
    candle(7,10,5,8,1), candle(8,9.5,5.5,8,2), candle(8,9,6,8,3),
    candle(8,11,7,9.5,4)
  ];
  const range = detectRange(rows.slice(0,3), { lookback: 3, maxWidthPct: 1 });
  assert.ok(range);
  assert.equal(detectRangeDeviations(rows, { ...range, endIndex: 2 })[0].direction, "BEARISH");
});

test("OTE bands use 62-79 percent retracement", () => {
  const ote = detectOTE({ direction: "BULLISH", startPrice: 100, endPrice: 200 });
  assert.equal(Math.round(ote.low), 121);
  assert.equal(Math.round(ote.high), 138);
});

test("CRT detects sweep and close back inside previous candle range", () => {
  const rows = [candle(7,10,5,8,1), candle(8,11,6,9,2)];
  assert.equal(detectCRT(rows)[0].direction, "BEARISH");
});
