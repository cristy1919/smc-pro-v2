import test from "node:test";
import assert from "node:assert/strict";
import { detectMarketRegimeTimeline, regimeAtTimestamp, combineMarketRegimes } from "../src/market-regime.js";

function candlesFromCloses(closes, step = 60000) {
  return closes.map((close, i) => ({
    timestamp: (i + 1) * step,
    open: close * 0.999,
    high: close * 1.006,
    low: close * 0.994,
    close,
    volume: 100 + (i % 7),
    closed: true
  }));
}

test("market regime timeline only exposes confirmed pivots and completed-candle events", () => {
  const closes = Array.from({ length: 160 }, (_, i) =>
    100 + i * 0.12 + Math.sin(i * 0.7) * (2 + i * 0.006)
  );
  const result = detectMarketRegimeTimeline(candlesFromCloses(closes));
  assert.equal(result.timeline.length, closes.length);
  assert.ok(result.pivots.every(p => p.confirmedAt > p.index));
  assert.ok(result.timeline.every(x => ["BULL", "BEAR", "SIDEWAYS", "TRANSITION", "UNCERTAIN"].includes(x.regime)));
  assert.ok(result.timeline.every(x => x.confidence >= 0 && x.confidence <= 1));
});

test("regime history is causal: appending future candles cannot rewrite earlier classifications", () => {
  const closes = Array.from({ length: 180 }, (_, i) =>
    100 + Math.sin(i * 0.53) * 3 + (i < 90 ? i * 0.04 : (180 - i) * 0.06)
  );
  const rows = candlesFromCloses(closes);
  const cut = 120;
  const prefix = detectMarketRegimeTimeline(rows.slice(0, cut)).timeline;
  const full = detectMarketRegimeTimeline(rows).timeline.slice(0, cut);
  assert.deepEqual(full, prefix);
});

test("regimeAtTimestamp returns the latest already-known closed-candle state", () => {
  const result = detectMarketRegimeTimeline(candlesFromCloses(Array.from({ length: 80 }, (_, i) => 50 + Math.sin(i) * 2)));
  const row = regimeAtTimestamp(result, result.timeline[30].timestamp + 60000, { candleDurationMs: 60000 });
  assert.equal(row.timestamp, result.timeline[30].timestamp);
  assert.equal(regimeAtTimestamp(result, result.timeline[30].timestamp + 1, { candleDurationMs: 60000 }), null);
  assert.equal(regimeAtTimestamp(result, 0), null);
});

test("macro and pair disagreement is retained instead of forcing a BTC-aligned direction", () => {
  const result = combineMarketRegimes({
    macro: { regime: "BULL", confidence: 0.9 },
    pair: { regime: "BEAR", confidence: 0.8 },
    execution: { regime: "BEAR", confidence: 0.7 }
  });
  assert.equal(result.conflict, true);
  assert.equal(result.compositeRegime, "MIXED");
  assert.equal(result.pairRegime, "BEAR");
  assert.equal(result.confidence, 0.7);
});
