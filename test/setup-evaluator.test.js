import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScalp, evaluateSwing } from "../src/setup-evaluator.js";

function series(n = 40, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i * step;
    return { timestamp: i + 1, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume: 100 + i, closed: true };
  });
}
const input = {
  symbol: "BTC-USDT",
  timeframes: { "1h": series(), "15m": series(40, 0.2), "5m": series(40, 0.05), "1d": series(40, 2), "4h": series(40, 0.8) }
};

test("Scalp evaluator consumes only 1h/15m/5m and returns a stable list", () => {
  const result = evaluateScalp(input);
  assert.ok(Array.isArray(result));
  assert.ok(result.every(x => x.engine === "scalp" && x.timeframe === "5m"));
});
test("Swing evaluator consumes 1d/4h/1h independently", () => {
  const result = evaluateSwing(input);
  assert.ok(Array.isArray(result));
  assert.ok(result.every(x => x.engine === "swing" && x.timeframe === "1h"));
});
test("candidate confidence remains insufficient without a trade sample history", () => {
  const result = evaluateScalp({ ...input, volumeData: { relativeVolume: 1.4 } });
  assert.ok(result.every(x => x.confidence === "INSUFFICIENT_DATA"));
});
test("missing required timeframe is rejected rather than silently substituted", () => {
  assert.throws(() => evaluateScalp({ symbol: "BTC-USDT", timeframes: { "1h": series(), "15m": series() } }), /MISSING_TIMEFRAME_5m/);
});
test("unavailable optional volume is explicit and not fabricated", () => {
  const result = evaluateSwing(input);
  assert.ok(result.every(x => x.dataStatus.relativeVolume === "UNAVAILABLE"));
});
