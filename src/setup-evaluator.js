import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";
import { detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps } from "./zones.js";
import { detectOrderBlocks, detectBreakers, detectSupplyDemand, detectRollingRanges, detectRangeDeviations, detectOTE as detectOTEZones, detectCRT, detectMitigations } from "./advanced-zones.js";
import { validateCandles } from "./market-data.js";

const WEIGHTS = {
  scalp: { htf: 15, liquidity: 20, structure: 20, zone: 15, entry: 20, volume: 10 },
  swing: { htf: 20, liquidity: 15, structure: 20, zone: 20, entry: 15, volume: 10 }
};
const SETUP_IDS = {
  scalp: { sweep: "S01_SWEEP_MSS_FVG", breaker: "S02_BREAKER_RETEST", bos: "S03_BOS_DISPLACEMENT", range: "S04_RANGE_DEVIATION", failed: "S05_FAILED_BREAKOUT", ob: "S06_OB_REACTION" },
  swing: { ob: "W01_HTF_OB_REVERSAL", supply: "W02_SUPPLY_DEMAND_REVERSAL", sweep: "W03_SWEEP_CHOCH", breaker: "W04_BREAKER_RETEST", range: "W05_RANGE_DEVIATION", crt: "W06_CRT", ote: "W07_OTE", bos: "W08_BOS_CONTINUATION" }
};

function latest(list, predicate = () => true) {
  return [...list].filter(predicate).sort((a, b) => b.index - a.index)[0] ?? null;
}
function directionOf(event) { return event?.direction ?? "NEUTRAL"; }
function candleDirection(c) { return c.close > c.open ? "BULLISH" : c.close < c.open ? "BEARISH" : "NEUTRAL"; }
function recentExtreme(candles, direction, lookback = 12) {
  const rows = candles.slice(-lookback);
  return direction === "BULLISH" ? Math.min(...rows.map(x => x.low)) : Math.max(...rows.map(x => x.high));
}
function candleQuality(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  const body = Math.abs(c.close - c.open) / range;
  const closePos = (c.close - c.low) / range;
  return Math.round(Math.min(100, body * 65 + (c.close > c.open ? closePos : 1 - closePos) * 35));
}
function structure(candles) {
  const pivots = classifyStructure(detectPivots(candles));
  const events = detectStructureEvents(candles, pivots);
  return { pivots, events, lastEvent: events.at(-1) ?? null };
}
function features(candles) {
  const s = structure(candles);
  const pools = detectLiquidityPools(s.pivots);
  const sweeps = detectLiquiditySweeps(candles, pools);
  const fvgs = detectFairValueGaps(candles).map(z => {
    const direction = z.type.startsWith("BULLISH") ? "BULLISH" : "BEARISH";
    let mitigatedAt = null, filledAt = null;
    for (let i = z.formedAt + 1; i < candles.length; i++) {
      const candle = candles[i];
      const touched = direction === "BULLISH" ? candle.low <= z.high : candle.high >= z.low;
      if (!touched) continue;
      mitigatedAt ??= i;
      const filled = direction === "BULLISH" ? candle.low <= z.low : candle.high >= z.high;
      if (filled) { filledAt = i; break; }
    }
    return { ...z, direction, mitigatedAt, filledAt, status: filledAt !== null ? "FILLED" : mitigatedAt !== null ? "MITIGATED" : "ACTIVE" };
  });
  const rawObs = detectOrderBlocks(candles, { pivots: s.pivots, events: s.events });
  const obs = detectMitigations(candles, rawObs);
  const breakers = detectBreakers(candles, rawObs);
  const supplyDemand = detectSupplyDemand(candles, { pivots: s.pivots });
  const ranges = detectRollingRanges(candles);
  const deviations = detectRangeDeviations(candles, ranges);
  const otes = detectOTEZones(candles, s.pivots);
  const crt = detectCRT(candles);
  return { ...s, pools, sweeps, fvgs, obs, breakers, supplyDemand, ranges, deviations, otes, crt };
}
function zoneAtPrice(zones, price, direction) {
  return zones.find(z => (z.direction ?? (String(z.type).startsWith("BULLISH") ? "BULLISH" : String(z.type).startsWith("BEARISH") ? "BEARISH" : null)) === direction && price >= z.low && price <= z.high) ?? null;
}
function makeCandidate({ engine, symbol, direction, setupId, entryCandles, htf, middle, entryFeatures, evidence, zone, volumeData }) {
  const last = entryCandles.at(-1);
  const entry = last.close;
  const stop = recentExtreme(entryCandles.slice(0, -1), direction, 12);
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || risk <= 0 ||
      (direction === "BULLISH" && stop >= entry) || (direction === "BEARISH" && stop <= entry)) return null;
  const target = direction === "BULLISH" ? entry + risk * 3.5 : entry - risk * 3.5;
  const rr = Math.abs(target - entry) / risk;
  const htfDirection = directionOf(htf.lastEvent);
  const midDirection = directionOf(middle.lastEvent);
  const htfScore = htfDirection === direction ? 100 : htfDirection === "NEUTRAL" ? 50 : 20;
  const liquidityScore = evidence.some(x => /SWEEP|RANGE|CRT/.test(x)) ? 100 : 35;
  const structureScore = entryFeatures.lastEvent?.direction === direction ? (entryFeatures.lastEvent.displacement ? 100 : 75) : midDirection === direction ? 65 : 35;
  const zoneScore = zone ? 100 : 45;
  const entryScore = candleDirection(last) === direction ? candleQuality(last) : 20;
  const volumeAvailable = Number.isFinite(volumeData?.relativeVolume) && volumeData.relativeVolume >= 0;
  const volumeScore = volumeAvailable ? Math.max(0, Math.min(100, 50 + (volumeData.relativeVolume - 1) * 35)) : null;
  const weights = WEIGHTS[engine];
  const factors = { htf: htfScore, liquidity: liquidityScore, structure: structureScore, zone: zoneScore, entry: entryScore, volume: volumeScore };
  const availableWeight = Object.entries(weights).reduce((sum, [key, weight]) => sum + (factors[key] === null ? 0 : weight), 0);
  const score = Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + (factors[key] === null ? 0 : factors[key] * weight), 0) / availableWeight);
  const hardFilters = { validStop: risk > 0, minimumRR: rr >= 1, direction: direction !== "NEUTRAL", candle: last.closed === true };
  const rejected = Object.values(hardFilters).some(x => !x);
  const band = rejected ? "REJECTED" : score < 60 ? "RED" : score < 70 ? "WAIT" : score < 80 ? "WATCH" : score < 90 ? "QUALIFIED" : "HIGH_QUALITY";
  const reasons = [
    setupId, `HTF_${htfDirection}`, `STRUCTURE_${midDirection}`,
    ...evidence, zone ? `ZONE_${zone.type}` : "ZONE_NOT_CONFIRMED",
    volumeAvailable ? "RELATIVE_VOLUME_AVAILABLE" : "RELATIVE_VOLUME_UNAVAILABLE"
  ];
  return {
    id: [engine, symbol, setupId, last.timestamp].join(":"),
    engine, symbol, direction, setupId, state: rejected ? "REJECTED" : score >= 80 ? "QUALIFIED" : "WATCH",
    timeframe: engine === "scalp" ? "5m" : "1h",
    entry, stop, target, zoneBounds: zone ? { low: zone.low, high: zone.high, type: zone.type } : null, rewardRisk: Number(rr.toFixed(2)), score, band,
    entryConfirmation: { status: "PENDING", maxWaitBars: 6, method: zone ? "ZONE_RETEST_CLOSE" : "CLOSE_CONFIRMATION" },
    confidence: "INSUFFICIENT_DATA", factors, factorCoveragePct: Math.round(availableWeight),
    hardFilters, evidence: reasons, createdAt: last.timestamp,
    dataStatus: { relativeVolume: volumeAvailable ? "AVAILABLE" : "UNAVAILABLE" }
  };
}
function validateInput(input, engine) {
  if (!input || typeof input.symbol !== "string" || !input.symbol.trim()) throw new TypeError("symbol is required");
  const required = engine === "scalp" ? ["1h", "15m", "5m"] : ["1d", "4h", "1h"];
  for (const tf of required) {
    if (!Array.isArray(input.timeframes?.[tf])) throw new Error("MISSING_TIMEFRAME_" + tf);
    validateCandles(input.timeframes[tf]);
    if (input.timeframes[tf].length < 25) throw new Error(`INSUFFICIENT_CANDLES_${tf}`);
  }
  return required.map(tf => input.timeframes[tf]);
}
function evaluate(input, engine) {
  const [higherCandles, middleCandles, entryCandles] = validateInput(input, engine);
  const htf = features(higherCandles), middle = features(middleCandles), entryF = features(entryCandles);
  const price = entryCandles.at(-1).close;
  const recentSweep = latest(entryF.sweeps, x => x.index >= entryCandles.length - 4);
  const recentDeviation = latest(entryF.deviations, x => x.index >= entryCandles.length - 3);
  const recentCrt = latest(entryF.crt, x => x.index === entryCandles.length - 1);
  const triggerEvent = latest(entryF.events, x => x.index >= entryCandles.length - 4);
  const direction = recentSweep?.direction ?? recentDeviation?.direction ?? recentCrt?.direction ?? triggerEvent?.direction ?? candleDirection(entryCandles.at(-1));
  if (direction === "NEUTRAL") return [];
  const candidates = [];
  const sweep = recentSweep?.direction === direction ? recentSweep : null;
  const displacementEvent = latest(entryF.events, x => x.direction === direction && x.displacement && x.index >= entryCandles.length - 4);
  const fvg = zoneAtPrice(entryF.fvgs.filter(x => x.status !== "FILLED"), price, direction);
  const breaker = entryF.breakers.find(x => x.direction === direction && price >= x.low && price <= x.high);
  const ob = entryF.obs.find(x => x.direction === direction && x.status !== "INVALIDATED" && price >= x.low && price <= x.high);
  const deviation = recentDeviation?.direction === direction ? recentDeviation : null;
  const crt = recentCrt?.direction === direction ? recentCrt : null;
  const midOb = middle.obs.find(x => x.direction === direction && x.status === "ACTIVE" && price >= x.low && price <= x.high);
  const midSupplyDemand = middle.supplyDemand.find(x => (direction === "BULLISH" ? x.type === "DEMAND" : x.type === "SUPPLY") && price >= x.low && price <= x.high);
  const ote = middle.otes.find(x => x.direction === direction && price >= x.low && price <= x.high);
  const inOte = Boolean(ote);
  const add = (key, evidence, zone = null) => {
    const item = makeCandidate({ engine, symbol: input.symbol, direction, setupId: SETUP_IDS[engine][key], entryCandles, htf, middle, entryFeatures: entryF, evidence, zone, volumeData: input.volumeData });
    if (item) candidates.push(item);
  };
  if (sweep && displacementEvent && triggerEvent?.direction === direction && triggerEvent?.type === "CHoCH" && triggerEvent?.mss === true && fvg) add("sweep", ["LIQUIDITY_SWEEP", "DISPLACEMENT_MSS", "FVG_RETEST"], fvg);
  if (breaker) add("breaker", ["BREAKER_RETEST"], breaker);
  if (displacementEvent && triggerEvent?.direction === direction && triggerEvent?.type === "BOS" && triggerEvent?.displacement === true) add("bos", ["BOS_CLOSE", "DISPLACEMENT"]);
  if (deviation) {
    const candleRange = entryCandles.at(-1).high - entryCandles.at(-1).low;
    const rangeZone = { low: deviation.level - candleRange * 0.25, high: deviation.level + candleRange * 0.25, type: "RANGE_REENTRY" };
    add("range", ["RANGE_DEVIATION_REENTRY"], rangeZone);
  }
  if (engine === "scalp") {
    if (sweep && triggerEvent?.direction === direction && triggerEvent.type === "CHoCH" && triggerEvent.mss === true) add("failed", ["FAILED_BREAKOUT", "SWEEP", "CHOCH"]);
    if (ob) add("ob", ["OB_REACTION"], ob);
  } else {
    if (midOb) add("ob", ["HTF_OB_REVERSAL"], midOb);
    if (midSupplyDemand) add("supply", ["SUPPLY_DEMAND_REACTION"], midSupplyDemand);
    if (sweep && triggerEvent?.direction === direction && triggerEvent.type === "CHoCH" && triggerEvent.mss === true) add("sweep", ["LIQUIDITY_SWEEP", "CHOCH"]);
    if (crt) add("crt", ["CRT_SWEEP_REENTRY"]);
    if (inOte) add("ote", ["OTE_RETRACE"], ote);
    if (displacementEvent && triggerEvent?.direction === direction && triggerEvent.type === "BOS" && triggerEvent.displacement === true) add("bos", ["BOS_CONTINUATION", "DISPLACEMENT"]);
  }
  const unique = new Map();
  for (const item of candidates) if (!unique.has(item.setupId)) unique.set(item.setupId, item);
  return [...unique.values()].sort((a, b) => b.score - a.score);
}
export function evaluateScalp(input) { return evaluate(input, "scalp"); }
export function evaluateSwing(input) { return evaluate(input, "swing"); }
