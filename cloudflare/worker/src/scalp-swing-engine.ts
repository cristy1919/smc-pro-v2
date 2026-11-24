import {analyzeMarketStructure,type Candle,type MarketStructureAnalysis,type Setup} from "./paper-engine.ts";
import {ENGINE_CONFIG,scoreBand,type EngineId,type SetupId} from "./scalp-swing-config.ts";
export type HistoricalTradeEvidence={symbol:string;side:"LONG"|"SHORT";model:string;tradeStyle:"SCALP"|"SWING"|"DAY";status:string;closedAt?:number;realizedR?:number;pnlUsdt?:number;riskUsdt?:number;initialRiskUsdt?:number;audit?:Record<string,unknown>};
export type HistoricalConfidence={status:"CALIBRATED"|"INSUFFICIENT_DATA";confidence:number|null;sampleSize:number;winRate:number|null;averageR:number|null;profitFactor:number|null};
export function calibrateHistoricalConfidence(candidate:{engine:EngineId;symbol:string;setupId:SetupId;side:"LONG"|"SHORT";marketRegime:string;htfAligned:boolean},history:HistoricalTradeEvidence[],asOf=Date.now(),minimumSamples=30):HistoricalConfidence{
 const cohort=(history??[]).filter(t=>{
  if(t.status!=="CLOSED"||!Number.isFinite(t.closedAt)||Number(t.closedAt)>=asOf||t.tradeStyle!==candidate.engine||t.model!==candidate.setupId||t.symbol!==candidate.symbol||t.side!==candidate.side)return false;
  const audit=t.audit??{};
  if(candidate.marketRegime==="UNAVAILABLE"||String(audit.marketRegime??"UNAVAILABLE")!==candidate.marketRegime||Boolean(audit.htfAligned)!==candidate.htfAligned)return false;
  const r=Number.isFinite(t.realizedR)?Number(t.realizedR):Number(t.initialRiskUsdt??t.riskUsdt)>0&&Number.isFinite(t.pnlUsdt)?Number(t.pnlUsdt)/Number(t.initialRiskUsdt??t.riskUsdt):NaN;
  return Number.isFinite(r);
 }).map(t=>Number.isFinite(t.realizedR)?Number(t.realizedR):Number(t.pnlUsdt)/Number(t.initialRiskUsdt??t.riskUsdt));
 const sampleSize=cohort.length;
 if(sampleSize<minimumSamples)return {status:"INSUFFICIENT_DATA",confidence:null,sampleSize,winRate:null,averageR:null,profitFactor:null};
 const wins=cohort.filter(r=>r>0),losses=cohort.filter(r=>r<0),grossWin=wins.reduce((a,b)=>a+b,0),grossLoss=Math.abs(losses.reduce((a,b)=>a+b,0));
 const winRate=wins.length/sampleSize*100,averageR=cohort.reduce((a,b)=>a+b,0)/sampleSize,profi --- TRUNCATED --- 19,307 chars