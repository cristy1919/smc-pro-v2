export type ActivityCandle = { time:number; high:number; low:number; close:number; quoteVolume?:number; volume?:number };
export type ActivityQuote = { bidPrice?:number|null; askPrice?:number|null; quoteVolume24h?:number|null };
export type ActivitySnapshot = {
  symbol:string; measuredAt:string; nPct:number; expansion7d30d:number;
  quoteVolume24h:number|null; average30dQuoteVolume:number|null;
  volumeExpansion24h30d:number|null; spreadPct:number|null;
};
export type RankedActivitySnapshot = ActivitySnapshot & {
  nPctPercentile:number; expansionPercentile:number; quoteVolumePercentile:number|null;
  volumeExpansionPercentile:number|null; spreadQualityPercentile:number|null; activityPercentile:number;
  liquidityPercentile:number|null; liquidityStatus:"GOOD"|"ACCEPTABLE"|"POOR"|"UNVERIFIED";
  priorityScore:number; priorityTier:"HIGH"|"NORMAL"|"LOW"|"UNVERIFIED";
  coveragePct:number; coverageReady:boolean; pairEligible:boolean; pairReason:"READY"|"LOW_RELATIVE_ACTIVITY"|"LOW_QUOTE_VOLUME"|"WIDE_SPREAD"; eligible:boolean;
  tier:"TOP_20"|"MIDDLE_60"|"BOTTOM_20";
  reason:"READY"|"UNIVERSE_COVERAGE_INCOMPLETE"|"LOW_RELATIVE_ACTIVITY"|"LOW_QUOTE_VOLUME"|"WIDE_SPREAD";
};
export type ActivityRankingSummary = {
  measuredAt:string; universeSize:number; coveredSymbols:number; coveragePct:number;
  minimumCoveragePct:number; minimumPriorityCoveragePct:number; minimumActivityPercentile:number; priorityReady:boolean; ready:boolean;
  eligibleSymbols:number; lowActivitySymbols:number; lowQuoteVolumeSymbols:number; wideSpreadSymbols:number;
  spreadDataAvailable:boolean; averageVolumeDataAvailable:boolean;
};
const MINIMUM_CANDLES=31,MAX_SNAPSHOT_AGE_MS=36*60*60*1000;
export const ACTIVITY_MINIMUM_COVERAGE_PCT=90,ACTIVITY_PRIORITY_MINIMUM_COVERAGE_PCT=25,ACTIVITY_MINIMUM_PERCENTILE=20;
function average(values:number[]):number{return values.length?values.reduce((a,b)=>a+b,0)/values.length:NaN}
function percentileRank(value:number,population:number[]):number{
  if(!population.length||!Number.isFinite(value))return 0;
  let below=0,equal=0;
  for(co --- TRUNCATED --- 11,852 chars