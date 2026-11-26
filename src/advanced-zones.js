import { validateCandles } from "./market-data.js";
import { detectPivots, detectStructureEvents } from "./market-structure.js";
const zone = (type, low, high, formedAt, confirmedAt, extra = {}) => ({ type, low: Math.min(low, high), high: Math.max(low, high), formedAt, confirmedAt, status: "ACTIVE", ...extra });
export function detectOrderBlocks(candles, { pivots = detectPivots(candles), events = detectStructureEvents(candles, pivots), lookback = 12 } = {}) {
  validateCandles(candles); const out = [];
  for (const e of events) { if (!["BOS", "CHoCH"].includes(e.type)) continue; const start = Math.max(0, e.index - lookback); let found = -1;
    for (let i = e.index - 1; i >= start; i--) { const c = candles[i], opposing = e.direction === "BULLISH" ? c.close < c.open : c.close > c.open; if (opposing) { found = i; break; } }
    if (found >= 0) { const c = candles[found]; out.push(zone(e.direction === "BULLISH" ? "BULLISH_OB" : "BEARISH_OB", c.low, c.high, found, e.index, { direction: e.direction, trigger: e.type, triggerLevel: e.level })); }
  } return out;
}
export function detectBreakers(candles, orderBlocks) {
  validateCandles(candles); const out = [];
  for (const ob of orderBlocks) { for (let i = ob.confirmedAt + 1; i < candles.length; i++) { const c = candles[i], broken = ob.direction === "BULLISH" ? c.close < ob.low : c.close > ob.high; if (broken) { out.push({ ...ob, type: ob.direction === "BULLISH" ? "BEARISH_BREAKER" : "BULLISH_BREAKER", direction: ob.direction === "BULLISH" ? "BEARISH" : "BULLISH", invalidatedAt: i, confirmedAt: i, status: "ACTIVE" }); break; } } }
  return out;
}
export function detectSupplyDemand(candles, { pivots = detectPivots(candles) } = {}) { validateCandles(candles); return pivots.map(p => { const c = candles[p.index]; return zone(p.type === "HIGH" ? "SUPPLY" : "DEMAND", c.low, c.high, p.index, p.confirmedAt, { pivotPrice: p.price }); }); }
export function detectMitigations(candles, zones) {
  validateCandles(candles);
  return zones.map(z => { let mitigatedAt = null, invalidatedAt = null; for (let i = z.confirmedAt + 1; i < candles.length; i++) { const c = candles[i], overlap = c.high >= z.low && c.low <= z.high; if (!overlap) continue; const invalid = z.direction === "BULLISH" ? c.close < z.low : z.direction === "BEARISH" ? c.close > z.high : false; if (invalid) { invalidatedAt = i; break; } mitigatedAt ??= i; } return { ...z, mitigatedAt, invalidatedAt, status: invalidatedAt !== null ? "INVALIDATED" : mitigatedAt !== null ? "MITIGATED" : z.status }; });
}
export function classifyRangeRegime(candles, { period = 20, maxEfficiency = 0.28, minOverlap = 0.55 } = {}) {
  validateCandles(candles); const rows = candles.slice(-period);
  if (rows.length < Math.min(period, 12)) return { regime: "INSUFFICIENT_DATA", efficiency: null, overlapRatio: null, directionalCloses: null };
  const path = rows.slice(1).reduce((s, c, i) => s + Math.abs(c.close - rows[i].close), 0);
  const efficiency = path > 0 ? Math.abs(rows.at(-1).close - rows[0].close) / path : 0;
  const overlaps = rows.slice(1).map((c, i) => { const p = rows[i], overlap = Math.max(0, Math.min(c.high, p.high) - Math.max(c.low, p.low)); const base = Math.max(1e-12, Math.min(c.high - c.low, p.high - p.low)); return overlap / base; });
  const overlapRatio = overlaps.reduce((s, x) => s + x, 0) / Math.max(1, overlaps.length);
  const up = rows.slice(1).filter((c, i) => c.close > rows[i].close).length, down = rows.slice(1).filter((c, i) => c.close < rows[i].close).length;
  const directionalCloses = Math.max(up, down) / Math.max(1, rows.length - 1);
  const regime = efficiency <= maxEfficiency && overlapRatio >= minOverlap ? "RANGE" : efficiency >= 0.38 && directionalCloses >= 0.62 ? "DIRECTIONAL_ORDERFLOW" : "MIXED";
  return { regime, efficiency: Number(efficiency.toFixed(4)), overlapRatio: Number(overlapRatio.toFixed(4)), directionalCloses: Number(directionalCloses.toFixed(4)) };
}
export function detectRollingRanges(candles, { period = 20 } = {}) {
  validateCandles(candles); if (!Number.isInteger(period) || period < 12) throw new RangeError("period must be >= 12"); const out = [];
  for (let i = period; i < candles.length; i++) { const w = candles.slice(i - period, i), high = Math.max(...w.map(x => x.high)), low = Math.min(...w.map(x => x.low)), regime = classifyRangeRegime(w, { period }); out.push({ index: i, formedAt: i - period, confirmedAt: i - 1, high, low, equilibrium: (high + low) / 2, width: high - low, ...regime }); }
  return out;
}
export function detectRangeDeviations(candles, ranges) {
  validateCandles(candles); const out = [];
  for (const r of ranges) { const c = candles[r.index]; if (!c || (r.regime && r.regime !== "RANGE")) continue;
    if (c.low < r.low && c.close > r.low) out.push({ index: r.index, direction: "BULLISH", type: "RANGE_DEVIATION_REENTRY", level: r.low, confirmedAt: r.index, regime: r.regime ?? "LEGACY_UNCLASSIFIED" });
    if (c.high > r.high && c.close < r.high) out.push({ index: r.index, direction: "BEARISH", type: "RANGE_DEVIATION_REENTRY", level: r.high, confirmedAt: r.index, regime: r.regime ?? "LEGACY_UNCLASSIFIED" });
  } return out;
}
export function detectOTE(candles, pivots, { min = .62, max = .79 } = {}) {
  validateCandles(candles); const highs = pivots.filter(p => p.type === "HIGH"), lows = pivots.filter(p => p.type === "LOW"), out = [];
  for (const h of highs) { const l = lows.filter(x => x.confirmedAt < h.confirmedAt).at(-1); if (!l || h.price <= l.price) continue; out.push({ direction: "BULLISH", low: h.price - (h.price - l.price) * max, high: h.price - (h.price - l.price) * min, formedAt: h.index, confirmedAt: h.confirmedAt, rangeLow: l.price, rangeHigh: h.price, type: "OTE" }); }
  for (const l of lows) { const h = highs.filter(x => x.confirmedAt < l.confirmedAt).at(-1); if (!h || h.price <= l.price) continue; out.push({ direction: "BEARISH", low: l.price + (h.price - l.price) * min, high: l.price + (h.price - l.price) * max, formedAt: l.index, confirmedAt: l.confirmedAt, rangeLow: l.price, rangeHigh: h.price, type: "OTE" }); }
  return out;
}
export function detectCRT(candles) { validateCandles(candles); const out = []; for (let i = 1; i < candles.length; i++) { const prev = candles[i - 1], c = candles[i]; if (c.low < prev.low && c.close > prev.low) out.push({ index: i, direction: "BULLISH", type: "CRT_SWEEP_RECLAIM", referenceHigh: prev.high, referenceLow: prev.low, confirmedAt: i }); if (c.high > prev.high && c.close < prev.high) out.push({ index: i, direction: "BEARISH", type: "CRT_SWEEP_RECLAIM", referenceHigh: prev.high, referenceLow: prev.low, confirmedAt: i }); } return out; }
export const detectRangeRegime = classifyRangeRegime;
