export const ENGINE_CONFIG = Object.freeze({ swing: { bias: "1d", structure: "4h", allowed: ["1d", "4h"], setupTimeframes: ["1d", "4h"] } });
export const RISK_CONFIG = Object.freeze({ riskUnitFraction: 0.02, reducedRiskFractionOfR: 0.5, maxOpenPositions: 10, minRewardRisk: 1, normalTargetR: 3.5, highTargetRequiresExtraConfirmation: true, minLeverage: 20, maxLeverage: 50 });
export const DASHBOARD_TABS = Object.freeze(["Market Overview", "Açık İşlemler", "Swing Scanner", "Positions", "Statistics", "Candidates (İşlem Adayları)", "Trade History", "Diagnostics", "Grafik"]);
export const SETUP_SCORE_MINIMUM = 70;
export const MIN_QUOTE_VOLUME_24H_USDT = 5000000;
export const MIN_RELATIVE_VOLUME = 0.8;
export const MAX_SPREAD_PCT = 0.15;
const ALLOWED = new Set(["4h", "1d", "1w"]);
export function assertSupportedTimeframe(tf) {
  if (tf === "1m" || tf === "3m" || tf === "5m" || tf === "15m" || tf === "1h") throw new Error("Forbidden setup timeframe: " + tf);
  if (!ALLOWED.has(tf)) throw new Error("Unsupported timeframe: " + tf);
  return true;
}
export function calculateRiskUnitUsd(initialVstEquity) {
  if (!Number.isFinite(initialVstEquity) || initialVstEquity <= 0) throw new RangeError("A valid BingX VST equity is required to initialize 1R");
  return initialVstEquity * RISK_CONFIG.riskUnitFraction;
}
