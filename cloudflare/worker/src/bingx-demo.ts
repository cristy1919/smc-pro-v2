// Normal VST positions use 20x–50x; reduced-risk setups may use 10x–50x.
// Stop-loss risk is capped at 1R (2% equity), separately from used margin.
export const MIN_LEVERAGE = 20;
// Move down only within the user's permitted leverage band when BingX rejects a tier.
export function nextLowerBingXLeverage(current:number,minimumLeverage=MIN_LEVERAGE):number|null {
  const floor=Math.max(1,Math.floor(minimumLeverage));
  if(!Number.isFinite(current)||current<=floor)return null;
  return Math.max(floor,Math.floor(current/2));
}

export type BingXDemoSetup = {
  symbol: string;
  side: "LONG" | "SHORT";
  model: string;
  tradeStyle?: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3?: number;
  tp4?: number;
  candleTime: number;
  setupCandleTime?: number;
  score: number;
  maxHoldHours?: number;
  /** True only after the strategy's closed-candle entry confirmation has passed. */
  entryConfirmed?: boolean;
  setupTimeframe?: string;
  entryTimeframe?: string;
  setupReason?: string;
  confirmations?: string[];
  scoreBreakdown?: Record<string, number>;
  riskReward?: number;
  /** Strategy tier multiplier: 1.0 normal risk, 0.5 reduced-risk countertrend. */
  riskMultiplier?: number;
  /** Immutable 1R amount captured from the initial BingX VST equity snapshot. */
  fixedRiskUnitUsdt?: number;
  audit?: unknown;
};

export type BingXDemoBalance = {
  asset: string;
  balance: number;
  equity: number;
  unrealizedProfit: number;
  realisedProfit: number | null;
  availableMargin: number;
  usedMargin: number;
  freezedMargin: number;
};

export type BingXDemoPosition = {
  symbol: string;
  positionId?: string;
  positionSide: "LONG" | "SHORT" | "BOTH";
  isolated?: boolean;
  marginType?: string;
  positionAmt: string;
  availableAmt?: string;
  unrealizedProfit: string;
  realisedProfit?: string;
  initialMargin: string;
  liquidationPrice: number;
  avgPrice: string;
  markPrice?: string | number;
  leverage: number;
  positionValue?: string;
  currency?: string;
};

export type BingXDemoO --- TRUNCATED --- 109,532 chars