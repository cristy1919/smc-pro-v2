export const SCORE_WEIGHTS = Object.freeze({
  scalp: Object.freeze({ htf: 15, liquidity: 20, structure: 20, zone: 15, entry: 20, volume: 10 }),
  swing: Object.freeze({ htf: 20, liquidity: 15, structure: 20, zone: 20, entry: 15, volume: 10 })
});
const REQUIRED_FILTERS = ["validStop", "rrAtLeastOne", "rrAtMostFour", "liquid", "candlesValid", "directionConsistent"];
export function scoreSetup(engine, factors, hardFilters = {}) {
  const weights = SCORE_WEIGHTS[engine];
  if (!weights) throw new Error("Unknown engine: " + engine);
  for (const key of Object.keys(weights)) {
    const value = factors?.[key];
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
      throw new RangeError("Invalid factor: " + key);
    }
  }
  const keys = Object.keys(weights);
  const factorCoveragePct = keys.reduce((sum, key) => sum + (Number.isFinite(factors?.[key]) ? weights[key] : 0), 0);
  // Fixed 100-point denominator: unavailable factors contribute zero instead of inflating the remaining factors.
  const score = Math.round(keys.reduce((sum, key) => sum + (Number.isFinite(factors?.[key]) ? factors[key] * weights[key] : 0), 0) / 100);
  const supplied = Object.keys(hardFilters).length > 0;
  const rejected = supplied && REQUIRED_FILTERS.some(key => hardFilters[key] !== true);
  const band = rejected ? "REJECTED" : score < 60 ? "RED" : score < 65 ? "WAIT" : score < 70 ? "WATCH" : score < 84 ? "QUALIFIED" : "HIGH_QUALITY";
  return { score, band, confidence: "INSUFFICIENT_DATA", factorCoveragePct };
}
export function calibrateConfidence(trades, { minimumSample = 30 } = {}) {
  const valid = trades.filter(t => Number.isFinite(t.netPnl));
  if (valid.length < minimumSample) return { confidence: "INSUFFICIENT_DATA", sampleSize: valid.length, winRate: null, profitFactor: null };
  const wins = valid.filter(t => t.netPnl > 0), losses = valid.filter(t => t.netPnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0), grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const winRate = wins.length / valid.length, pf = grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const confidence = pf >= 1.5 && winRate >= .5 ? "HIGH" : pf >= 1.15 ? "MEDIUM" : "LOW";
  return { confidence, sampleSize: valid.length, winRate, profitFactor: pf };
}
