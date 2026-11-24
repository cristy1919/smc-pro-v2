
/** Minimum rolling 24-hour quote turnover for swing candidates, measured in USDT. */
export const MINIMUM_24H_QUOTE_VOLUME_USDT = 500_000;
export type QuoteVolumeAssessment = {
  status: "pass" | "low-volume" | "insufficient-data";
  quoteVolume24hUsdt: number | null;
  observedHours: number;
};
/**
 * Prefer BingX's exact quote-asset volume ([7] in v3 kline arrays). If it is
 * absent, estimate USDT turnover from base-asset volume × close. Missing data
 * is reported separately rather than fabricated.
 */
export function assess24hQuoteVolume(
  candles: Array<{close:number;volume?:number;quoteVolume?:number}>
): QuoteVolumeAssessment {
  if (!Array.isArray(candles) || candles.length < 24) {
    return {status:"insufficient-data",quoteVolume24hUsdt:null,observedHours:0};
  }
  const window=candles.slice(-24);
  const observed=window.map(c=>{
    if(!Number.isFinite(c.close)||c.close<=0)return null;
    if(c.quoteVolume!=null&&Number.isFinite(Number(c.quoteVolume))&&Number(c.quoteVolume)>=0)return Number(c.quoteVolume);
    if(c.volume!=null&&Number.isFinite(Number(c.volume))&&Number(c.volume)>=0)return Number(c.volume)*c.close;
    return null;
  }).filter((value):value is number=>value!==null);
  if(observed.length<18) return {status:"insufficient-data",quoteVolume24hUsdt:null,observedHours:observed.length};
  const quoteVolume24hUsdt=observed.reduce((sum,value)=>sum+value,0);
  return {
    status:quoteVolume24hUsdt<MINIMUM_24H_QUOTE_VOLUME_USDT?"low-volume":"pass",
    quoteVolume24hUsdt,
    observedHours:observed.length
  };
}

export type ScannerQuotaLevel = "normal" | "watch" | "reduced" | "critical";

// Per-symbol closed-candle windows used by the paper scanner. Higher timeframes
// are derived from 1H where possible; 1D is fetched directly to retain macro history.
export const PAPER_CANDLE_LIMITS = { fifteenMinute: 576, oneHour: 1000, oneDay: 90 } as const;

/**
 * A symbol is a complete swing scan only when every setup/entry timeframe has
 * enough closed candles. 15m is optional because the active strategy matrix
 * enters on --- TRUNCATED --- 16,493 chars