export type EngineId = "SCALP" | "SWING";
export type SetupId =
  | "S01_SWEEP_MSS_FVG" | "S02_BREAKER_RETEST" | "S03_BOS_DISPLACEMENT"
  | "S04_RANGE_DEVIATION" | "S05_FAILED_BREAKOUT" | "S06_OB_REACTION"
  | "W01_HTF_OB_REVERSAL" | "W02_SUPPLY_DEMAND_REVERSAL" | "W03_SWEEP_CHOCH"
  | "W04_BREAKER_RETEST" | "W05_RANGE_DEVIATION" | "W06_CRT"
  | "W07_OTE" | "W08_BOS_CONTINUATION";

export type ScoreBand = "RED" | "WAIT" | "WATCH" | "QUALIFIED" | "HIGH_QUALITY";

export const SCORE_BANDS = Object.freeze([
  { min: 0, max: 59, label: "RED" as const },
  { min: 60, max: 69, label: "WAIT" as const },
  { min: 70, max: 79, label: "WATCH" as const },
  { min: 80, max: 89, label: "QUALIFIED" as const },
  { min: 90, max: 100, label: "HIGH_QUALITY" as const }
]);

export const ENGINE_CONFIG = Object.freeze({
  SCALP: Object.freeze({
    id: "SCALP" as const,
    directionTimeframe: "1h",
    zoneTimeframe: "15m",
    setupTimeframe: "5m",
    entryTimeframe: "5m",
    scoreWeights: Object.freeze({ htf: 15, liquidity: 20, marketStructure: 20, zone: 15, entryConfirmation: 20, volume: 10 }),
    setups: Object.freeze([
      "S01_SWEEP_MSS_FVG", "S02_BREAKER_RETEST", "S03_BOS_DISPLACEMENT",
      "S04_RANGE_DEVIATION", "S05_FAILED_BREAKOUT", "S06_OB_REACTION"
    ] as const)
  }),
  SWING: Object.freeze({
    id: "SWING" as const,
    directionTimeframe: "1d",
    zoneTimeframe: "4h",
    setupTimeframe: "1h",
    entryTimeframe: "15m",
    scoreWeights: Object.freeze({ htf: 20, liquidity: 15, marketStructure: 20, zone: 20, entryConfirmation: 15, volume: 10 }),
    setups: Object.freeze([
      "W01_HTF_OB_REVERSAL", "W02_SUPPLY_DEMAND_REVERSAL", "W03_SWEEP_CHOCH",
      "W04_BREAKER_RETEST", "W05_RANGE_DEVIATION", "W06_CRT", "W07_OTE", "W08_BOS_CONTINUATION"
    ] as const)
  })
});

export const RISK_CONFIG = Object.freeze({
  normalRiskPercentOfEquity: 2,
  reducedRiskPercentOfEquity: 1,
  minimumRiskReward: 1,
  standardTargetR: 3.5,
  extendedTargetRequiresHig --- TRUNCATED --- 2,796 chars