import { validateCandles } from "./market-data.js";

/**
 * Pivots become observable only at confirmedAt (after rightBars candles close).
 * Consumers must never use index as the availability time.
 */
export function detectPivots(candles, { leftBars = 2, rightBars = 2 } = {}) {
  validateCandles(candles);
  if (!Number.isInteger(leftBars) || !Number.isInteger(rightBars) || leftBars < 1 || rightBars < 1) {
    throw new RangeError("Invalid pivot window");
  }
  const out = [];
  for (let i = leftBars; i + rightBars < candles.length; i++) {
    const c = candles[i];
    const before = candles.slice(i - leftBars, i);
    const after = candles.slice(i + 1, i + rightBars + 1);
    if (before.every(x => c.high >= x.high) && after.every(x => c.high > x.high)) {
      out.push({ type: "HIGH", index: i, confirmedAt: i + rightBars, price: c.high, timestamp: c.timestamp });
    }
    if (before.every(x => c.low <= x.low) && after.every(x => c.low < x.low)) {
      out.push({ type: "LOW", index: i, confirmedAt: i + rightBars, price: c.low, timestamp: c.timestamp });
    }
  }
  return out.sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);
}

export function classifyStructure(pivots) {
  const last = { HIGH: null, LOW: null };
  return pivots.map(p => {
    if (!["HIGH", "LOW"].includes(p.type) || !Number.isFinite(p.price)) throw new TypeError("Invalid pivot");
    const previous = last[p.type];
    const label = previous === null
      ? (p.type === "HIGH" ? "H" : "L")
      : p.type === "HIGH"
        ? (p.price > previous ? "HH" : p.price < previous ? "LH" : "EQH")
        : (p.price > previous ? "HL" : p.price < previous ? "LL" : "EQL");
    last[p.type] = p.price;
    return { ...p, label };
  });
}

function displacement(candle, direction, { minBodyRatio = 0.55, minCloseLocation = 0.7 } = {}) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const closeLocation = (candle.close - candle.low) / range;
  return bodyRatio >= minBodyRatio && (direction === "BULLISH"
    ? candle.close > candle.open && closeLocation >= minCloseLocation
    : candle.close < candle.open && closeLocation <= 1 - minCloseLocation);
}

/**
 * Structure breaks are evaluated only against pivots already confirmed by that candle.
 * BOS/CHoCH is close-confirmed; MSB/MSS are displacement-qualified annotations.
 */
export function detectStructureEvents(candles, pivots, options = {}) {
  validateCandles(candles);
  if (!Array.isArray(pivots)) throw new TypeError("Pivots must be an array");
  const byConfirmation = new Map();
  for (const p of pivots) {
    if (!Number.isInteger(p.confirmedAt) || p.confirmedAt < 0 || p.confirmedAt >= candles.length) continue;
    const list = byConfirmation.get(p.confirmedAt) ?? [];
    list.push(p);
    byConfirmation.set(p.confirmedAt, list);
  }
  let high = null, low = null, trend = "UNDEFINED";
  const broken = new Set(), events = [];
  for (let i = 0; i < candles.length; i++) {
    for (const p of byConfirmation.get(i) ?? []) {
      if (p.type === "HIGH") high = p;
      if (p.type === "LOW") low = p;
    }
    if (i === 0) continue;
    const previous = candles[i - 1].close, current = candles[i];
    const up = high && !broken.has(high.index) && previous <= high.price && current.close > high.price;
    const down = low && !broken.has(low.index) && previous >= low.price && current.close < low.price;
    if (Boolean(up) === Boolean(down)) continue;
    const pivot = up ? high : low;
    const direction = up ? "BULLISH" : "BEARISH";
    broken.add(pivot.index);
    const reversal = (trend === "BULLISH" && direction === "BEARISH") ||
      (trend === "BEARISH" && direction === "BULLISH");
    const hasDisplacement = displacement(current, direction, options);
    events.push({
      index: i,
      timestamp: current.timestamp,
      type: reversal ? "CHoCH" : "BOS",
      direction,
      level: pivot.price,
      pivotIndex: pivot.index,
      pivotConfirmedAt: pivot.confirmedAt,
      trendBefore: trend,
      displacement: hasDisplacement,
      msb: hasDisplacement && !reversal,
      mss: hasDisplacement && reversal
    });
    trend = direction;
    if (up) high = null;
    else low = null;
  }
  return events;
}
