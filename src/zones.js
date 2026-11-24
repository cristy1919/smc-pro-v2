import { validateCandles } from "./market-data.js";

export function detectFairValueGaps(candles) {
  validateCandles(candles);
  const out = [];
  for (let i = 2; i < candles.length; i++) {
    const left = candles[i - 2], right = candles[i];
    let gap = null;
    if (left.high < right.low) gap = { type: "BULLISH_FVG", low: left.high, high: right.low };
    else if (left.low > right.high) gap = { type: "BEARISH_FVG", low: right.high, high: left.low };
    if (!gap) continue;
    let status = "ACTIVE", mitigatedAt = null, filledAt = null;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];
      const touched = gap.type === "BULLISH_FVG" ? c.low <= gap.high : c.high >= gap.low;
      const filled = gap.type === "BULLISH_FVG" ? c.low <= gap.low : c.high >= gap.high;
      if (touched && mitigatedAt === null) mitigatedAt = j;
      if (filled) { filledAt = j; status = "FILLED"; break; }
      if (touched) status = "MITIGATED";
    }
    out.push({ ...gap, formedAt: i, status, mitigatedAt, filledAt });
  }
  return out;
}

export function detectLiquidityPools(pivots, { tolerance = 0.0015, minTouches = 2 } = {}) {
  if (!Array.isArray(pivots) || !(tolerance > 0) || !Number.isInteger(minTouches) || minTouches < 2) {
    throw new RangeError("Invalid liquidity-pool parameters");
  }
  const out = [];
  for (const pivotType of ["HIGH", "LOW"]) {
    const groups = [];
    for (const p of pivots.filter(x => x.type === pivotType)) {
      if (!Number.isFinite(p.price) || p.price <= 0) continue;
      let group = groups.find(g => Math.abs(g.mean - p.price) / p.price <= tolerance);
      if (!group) { group = { mean: p.price, points: [] }; groups.push(group); }
      group.points.push(p);
      group.mean = group.points.reduce((sum, x) => sum + x.price, 0) / group.points.length;
    }
    for (const g of groups.filter(x => x.points.length >= minTouches)) {
      const last = g.points.reduce((a, b) => (b.confirmedAt ?? b.index) > (a.confirmedAt ?? a.index) ? b : a);
      out.push({
        type: pivotType === "HIGH" ? "BUY_SIDE_LIQUIDITY" : "SELL_SIDE_LIQUIDITY",
        level: g.mean,
        touches: g.points.length,
        lastIndex: last.index,
        confirmedAt: last.confirmedAt ?? last.index
      });
    }
  }
  return out;
}

export function detectLiquiditySweeps(candles, pools) {
  validateCandles(candles);
  const out = [];
  for (const pool of pools) {
    const start = Math.max(0, Number.isInteger(pool.confirmedAt) ? pool.confirmedAt + 1 : pool.lastIndex + 1);
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      const swept = pool.type === "BUY_SIDE_LIQUIDITY"
        ? c.high > pool.level && c.close < pool.level
        : c.low < pool.level && c.close > pool.level;
      if (swept) {
        out.push({ ...pool, index: i, timestamp: c.timestamp, direction: pool.type === "BUY_SIDE_LIQUIDITY" ? "BEARISH" : "BULLISH" });
        break;
      }
    }
  }
  return out;
}

export function detectOrderBlocks(candles, structureEvents, { lookback = 8 } = {}) {
  validateCandles(candles);
  if (!Number.isInteger(lookback) || lookback < 1) throw new RangeError("Invalid order-block lookback");
  const out = [];
  for (const event of structureEvents) {
    const i = event.index;
    if (!Number.isInteger(i) || i < 1 || i >= candles.length) continue;
    const opposite = event.direction === "BULLISH" ? c => c.close < c.open : c => c.close > c.open;
    let origin = -1;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      if (opposite(candles[j])) { origin = j; break; }
    }
    if (origin < 0) continue;
    const c = candles[origin];
    let invalidatedAt = null;
    for (let j = i + 1; j < candles.length; j++) {
      if (event.direction === "BULLISH" ? candles[j].close < c.low : candles[j].close > c.high) {
        invalidatedAt = j; break;
      }
    }
    out.push({
      type: event.direction === "BULLISH" ? "BULLISH_OB" : "BEARISH_OB",
      direction: event.direction,
      low: c.low,
      high: c.high,
      originIndex: origin,
      formedAt: i,
      invalidatedAt,
      status: invalidatedAt === null ? "ACTIVE" : "INVALIDATED"
    });
  }
  return out;
}

export function detectMitigationBlocks(candles, orderBlocks) {
  validateCandles(candles);
  return orderBlocks.flatMap(block => {
    if (block.status !== "ACTIVE") return [];
    for (let i = block.formedAt + 1; i < candles.length; i++) {
      const c = candles[i];
      if (c.low <= block.high && c.high >= block.low) {
        return [{ ...block, type: block.direction === "BULLISH" ? "BULLISH_MITIGATION" : "BEARISH_MITIGATION", mitigatedAt: i }];
      }
    }
    return [];
  });
}

export function detectBreakerBlocks(candles, orderBlocks) {
  validateCandles(candles);
  const out = [];
  for (const block of orderBlocks.filter(x => x.status === "INVALIDATED" && Number.isInteger(x.invalidatedAt))) {
    for (let i = block.invalidatedAt + 1; i < candles.length; i++) {
      const c = candles[i];
      const retest = block.direction === "BULLISH"
        ? c.high >= block.low && c.close < block.low
        : c.low <= block.high && c.close > block.high;
      if (retest) {
        out.push({ ...block, type: block.direction === "BULLISH" ? "BEARISH_BREAKER" : "BULLISH_BREAKER", direction: block.direction === "BULLISH" ? "BEARISH" : "BULLISH", retestAt: i });
        break;
      }
    }
  }
  return out;
}

export function detectSupplyDemandZones(orderBlocks) {
  return orderBlocks.map(block => ({
    ...block,
    type: block.direction === "BULLISH" ? "DEMAND" : "SUPPLY"
  }));
}

export function detectRange(candles, { lookback = 20, maxWidthPct = 0.08 } = {}) {
  validateCandles(candles);
  if (!Number.isInteger(lookback) || lookback < 3 || !(maxWidthPct > 0)) throw new RangeError("Invalid range parameters");
  if (candles.length < lookback) return null;
  const window = candles.slice(-lookback);
  const high = Math.max(...window.map(c => c.high));
  const low = Math.min(...window.map(c => c.low));
  const equilibrium = (high + low) / 2;
  const widthPct = (high - low) / equilibrium;
  if (widthPct > maxWidthPct) return null;
  return { high, low, equilibrium, widthPct, startIndex: candles.length - lookback, endIndex: candles.length - 1 };
}

export function detectRangeDeviations(candles, range) {
  validateCandles(candles);
  if (!range || !Number.isFinite(range.high) || !Number.isFinite(range.low)) return [];
  const out = [];
  for (let i = Math.max(0, range.endIndex + 1); i < candles.length; i++) {
    const c = candles[i];
    if (c.high > range.high && c.close < range.high) out.push({ index: i, direction: "BEARISH", side: "ABOVE_RANGE_REENTRY", sweptLevel: range.high });
    else if (c.low < range.low && c.close > range.low) out.push({ index: i, direction: "BULLISH", side: "BELOW_RANGE_REENTRY", sweptLevel: range.low });
  }
  return out;
}

export function detectOTE(impulse) {
  if (!impulse || !["BULLISH", "BEARISH"].includes(impulse.direction) ||
      !Number.isFinite(impulse.startPrice) || !Number.isFinite(impulse.endPrice) ||
      impulse.startPrice <= 0 || impulse.endPrice <= 0 || impulse.startPrice === impulse.endPrice) return null;
  const distance = Math.abs(impulse.endPrice - impulse.startPrice);
  if (impulse.direction === "BULLISH") {
    return { low: impulse.endPrice - distance * 0.79, high: impulse.endPrice - distance * 0.62, direction: "BULLISH", type: "OTE" };
  }
  return { low: impulse.endPrice + distance * 0.62, high: impulse.endPrice + distance * 0.79, direction: "BEARISH", type: "OTE" };
}

export function detectCRT(candles) {
  validateCandles(candles);
  if (candles.length < 2) return [];
  const previous = candles.at(-2), current = candles.at(-1);
  if (current.high > previous.high && current.close < previous.high && current.close > previous.low) {
    return [{ index: candles.length - 1, direction: "BEARISH", type: "CRT_HIGH_SWEEP_REENTRY", sweptLevel: previous.high }];
  }
  if (current.low < previous.low && current.close > previous.low && current.close < previous.high) {
    return [{ index: candles.length - 1, direction: "BULLISH", type: "CRT_LOW_SWEEP_REENTRY", sweptLevel: previous.low }];
  }
  return [];
}
