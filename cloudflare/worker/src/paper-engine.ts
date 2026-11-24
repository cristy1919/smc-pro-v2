import type { ActivitySnapshot, ActivityRankingSummary, RankedActivitySnapshot } from "./activity-ranking";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number; quoteVolume?: number; takerBuyVolume?: number; takerBuyQuoteVolume?: number };
export type StrategyModel = string;
export type TradeStyle = "SWING" | "SCALP" | "DAY";
export type Setup = {
  symbol: string; side: "LONG" | "SHORT"; model: StrategyModel; tradeStyle: TradeStyle; entryTimeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d"; setupTimeframe?: "5m" | "15m" | "1h" | "2h" | "4h" | "1d"; setupCandleTime?: number; score: number;
  scoreBreakdown: Record<string, number>; entry: number; stopLoss: number; takeProfit: number;
  confirmations?:string[]; audit?:Record<string,unknown>; executionDecisionCode?:string; executionDecisionAt?:string; executionDecisionReason?:string;
  riskReward: number; confidence: number|null; confidenceStatus?:"CALIBRATED"|"INSUFFICIENT_DATA"; confidenceSampleSize?:number; confidenceWinRate?:number|null; confidenceAverageR?:number|null; confidenceProfitFactor?:number|null; reason: string; candleTime: number; status: "READY" | "WATCH" | "WAIT" | "OPENED" | "REJECTED" | "EXPIRED"; setupPoints?:number; setupPointsMax?:number; opposingSetupPoints?:number;
  tp1?: number; tp2?: number; tp3?: number; tp4?: number; rangeEntry?: number; rangeHigh?: number; rangeLow?: number;
  primaryTrend?: "LONG" | "SHORT" | "NEUTRAL"; marketPhase?: "TREND_CONTINUATION" | "COUNTERTREND_CORRECTION" | "TRANSITION"; correctionDirection?: "LONG" | "SHORT" | "NEUTRAL";
  riskMultiplier?: number;
  killZoneActive?: boolean;
  oteTop?: number; oteBottom?: number; oteMid?: number; zoneTop?:number; zoneBottom?:number; fvgTop?:number; fvgBottom?:number; setupSourceTimeframe?:"15m"|"1h"|"2h"|"4h"|"1d"; btcContextStatus:"ALIGNED"|"OPPOSING"|"MIXED"|"UNAVAILABLE";
};
export type ModelTelemetryCount = { evaluations:number; setupCandidates:number; rejections:Record<strin --- TRUNCATED --- 62,287 chars