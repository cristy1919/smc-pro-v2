export const SCORE_WEIGHTS = Object.freeze({ swing: { btcContext: 20, dominance: 10, liquidity: 15, structure: 20, zone: 15, entry: 10, volume: 10 } });
const REQUIRED_FILTERS = ["validStop", "rrAtLeastOne", "liquid", "candlesValid", "directionConsistent"];
export function scoreSetup(engine, factors, hardFilters = {}) {
  const w = SCORE_WEIGHTS[engine];
  if (!w) throw new Error(engine === "scalp" ? "SCALP_ENGINE_REMOVED" : "Unknown engine");
  for (const k of Object.keys(w)) if (factors[k] !== null && factors[k] !== undefined && (!Number.isFinite(factors[k]) || factors[k] < 0 || factors[k] > 100)) throw new RangeError("Invalid factor: " + k);
  const available = Object.keys(w).filter(k => Number.isFinite(factors[k]));
  const totalWeight = available.reduce((s, k) => s + w[k], 0);
  if (!totalWeight) return { score: 0, band: "INSUFFICIENT_DATA", confidence: "INSUFFICIENT_DATA", factorCoveragePct: 0 };
  const score = Math.round(available.reduce((s, k) => s + factors[k] * w[k], 0) / totalWeight);
  const rejected = REQUIRED_FILTERS.some(k => hardFilters[k] !== true);
  const band = rejected ? "REJECTED" : score < 60 ? "RED" : score < 65 ? "WAIT" : score < 70 ? "WATCH" : score < 84 ? "QUALIFIED" : "HIGH_QUALITY";
  return { score, band, confidence: "INSUFFICIENT_DATA", factorCoveragePct: Math.round(totalWeight) };
}
export function calibrateConfidence(trades, { minimumSample = 30 } = {}) {
  const valid = trades.filter(t => Number.isFinite(t.netPnl));
  if (valid.length < minimumSample) return { confidence: "INSUFFICIENT_DATA", sampleSize: valid.length, winRate: null, profitFactor: null };
  const wins = valid.filter(t => t.netPnl > 0), losses = valid.filter(t => t.netPnl < 0), grossWin = wins.reduce((s, t) => s + t.netPnl, 0), grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0), winRate = wins.length / valid.length, pf = grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  return { confidence: pf >= 1.5 && winRate >= .5 ? "HIGH" : pf >= 1.15 ? "MEDIUM" : "LOW", sampleSize: valid.length, winRate, profitFactor: pf };
}
