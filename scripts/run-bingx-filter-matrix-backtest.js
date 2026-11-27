import { writeFile } from "node:fs/promises";
import { BingXPublicKlineProvider, fetchEngineDataset, INTERVAL_MS } from "../src/bingx-market-data.js";
import { SCALP_ENGINE_AVAILABLE, evaluateScalp, evaluateSwing } from "../src/setup-evaluator.js";
import { advanceEntryConfirmation } from "../src/entry-confirmation.js";
import { RISK_CONFIG } from "../src/config.js";
import { calculateRelativeVolume } from "../src/market-data.js";
import { selectCryptoPerpetualUniverse } from "../src/backtest-universe.js";
import { calculateExcursionsR } from "../src/excursions.js";

const BASE_URL = "https://open-api.bingx.com";
const DAY = 86400000;
const TARGET_SYMBOLS = 20;
const WINDOW_DAYS = 30;
const SEGMENT_DAYS = 30;
const FEE_RATE = Number(process.env.FEE_RATE ?? 0.0005);
const SLIPPAGE_RATE = Number(process.env.SLIPPAGE_RATE ?? 0.0002);
const MAX_COST_TO_RISK = 0.20;
const MIN_STOP_DISTANCE_PCT = 0.007;
const SETUPS = {
  scalp: ["S01_SWEEP_MSS_FVG","S02_BREAKER_RETEST","S03_BOS_DISPLACEMENT","S04_RANGE_DEVIATION","S05_FAILED_BREAKOUT","S06_OB_REACTION"],
  swing: ["W01_HTF_OB_REVERSAL","W02_SUPPLY_DEMAND_REVERSAL","W03_SWEEP_CHOCH","W04_BREAKER_RETEST","W05_RANGE_DEVIATION","W06_CRT","W07_OTE","W08_BOS_CONTINUATION"]
};
const DIRECTIONS = ["BULLISH","BEARISH"];
const ENGINES = [
  { name:"scalp", evaluate:evaluateScalp, entryTimeframes:["5m"] },
  { name:"swing", evaluate:evaluateSwing, entryTimeframes:["15m","1h"] }
];
const ALL_MODEL_KEYS = ENGINES.flatMap(engine =>
  engine.entryTimeframes.flatMap(tf =>
    SETUPS[engine.name].flatMap(setupId =>
      DIRECTIONS.map(direction => modelKey(engine.name,tf,setupId,direction))
    )
  )
);

if (!Number.isInteger(TARGET_SYMBOLS) || TARGET_SYMBOLS < 1 || TARGET_SYMBOLS > 100) throw new Error("TARGET_SYMBOLS must be 1..100");
if (WINDOW_DAYS !== 30) throw new Error("WINDOW_DAYS is fixed at 30 for this research run");
if (!Number.isFinite(FEE_RATE) || FEE_RATE < 0 || !Number.isFinite(SLIPPAGE_RATE) || SLIPPAGE_RATE < 0) throw new Error("INVALID_COST_ASSUMPTIONS");

// Fail before any BingX market-data requests if the independent Scalp evaluator is not wired.
// A matrix report that silently skips every Scalp signal would be misleading.
if (!SCALP_ENGINE_AVAILABLE) {
  throw new Error("BACKTEST_BLOCKED_SCALP_EVALUATOR_UNAVAILABLE: restore and test the independent Scalp evaluator before running the combined matrix");
}

async function publicData(path) {
  const response = await fetch(new URL(path, BASE_URL));
  if (!response.ok) throw new Error("BINGX_HTTP_" + response.status + "_" + path);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error("BINGX_API_" + payload.code + ":" + (payload.msg || path));
  return payload.data;
}
async function selectTopSymbols() {
  const [contracts,tickers] = await Promise.all([
    publicData("/openApi/swap/v2/quote/contracts"),
    publicData("/openApi/swap/v2/quote/ticker")
  ]);
  return selectCryptoPerpetualUniverse(contracts,tickers,TARGET_SYMBOLS);
}
function modelKey(engine,timeframe,setupId,direction) {
  return [engine,timeframe,setupId,direction].join("|");
}
const FILTER_VARIANTS = [
  {id:"F0_BASELINE",label:"Baseline",minRelativeVolume:null,minScore:70,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F1_RVOL50",label:"Relative volume >= 50",minRelativeVolume:50,minScore:70,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F2_RVOL60",label:"Relative volume >= 60",minRelativeVolume:60,minScore:70,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F3_RVOL70",label:"Relative volume >= 70",minRelativeVolume:70,minScore:70,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F4_SCORE80",label:"Score >= 80",minRelativeVolume:null,minScore:80,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F5_COST10",label:"Projected cost / risk <= 0.10R",minRelativeVolume:null,minScore:70,maxCostR:0.10,regimeAwareContinuation:false},
  {id:"F6_RVOL60_SCORE75",label:"Relative volume >= 60 and score >= 75",minRelativeVolume:60,minScore:75,maxCostR:0.20,regimeAwareContinuation:false},
  {id:"F7_REGIME_CONTINUATION",label:"Trend alignment for continuation setups only",minRelativeVolume:null,minScore:70,maxCostR:0.20,regimeAwareContinuation:true},
  {id:"F8_RVOL60_SCORE75_COST15",label:"RVOL >= 60, score >= 75, cost <= 0.15R",minRelativeVolume:60,minScore:75,maxCostR:0.15,regimeAwareContinuation:false},
  {id:"F9_RVOL60_SCORE80_COST10",label:"RVOL >= 60, score >= 80, cost <= 0.10R",minRelativeVolume:60,minScore:80,maxCostR:0.10,regimeAwareContinuation:false}
];
const CONTINUATION_SETUPS = new Set(["S03_BOS_DISPLACEMENT","W08_BOS_CONTINUATION"]);
function passesSignalFilter(candidate,variant,relativeVolume,regime) {
  if(variant.minRelativeVolume!==null && (!Number.isFinite(relativeVolume)||relativeVolume<variant.minRelativeVolume))return false;
  if(candidate.score<variant.minScore)return false;
  if(variant.regimeAwareContinuation && CONTINUATION_SETUPS.has(candidate.setupId)) {
    const aligned=candidate.direction==="BULLISH"?String(regime).startsWith("UPTREND"):String(regime).startsWith("DOWNTREND");
    if(!aligned)return false;
  }
  return true;
}
function emptyCounter() {
  return { signals:0,qualifiedSignals:0,belowScore:0,hardFilterRejected:0,filterRejected:0,entryConfirmationFailed:0,costRejected:0,executed:0 };
}
function summarize(trades) {
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<=0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  const totalR=trades.reduce((s,t)=>s+t.netR,0);
  let equity=1,peak=1,maxDrawdown=0;
  for (const t of [...trades].sort((a,b)=>a.entryAt-b.entryAt)) {
    equity*=1+t.netR*RISK_CONFIG.riskUnitFraction;
    peak=Math.max(peak,equity);
    maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);
  }
  const mean=(arr)=>arr.length?arr.reduce((s,x)=>s+x,0)/arr.length:0;
  return {
    trades:trades.length,wins:wins.length,losses:losses.length,
    winRate:trades.length?wins.length/trades.length:0,
    profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?null:0,
    totalNetR:totalR,expectancyR:trades.length?totalR/trades.length:0,
    maxDrawdownPct:maxDrawdown*100,
    averageMAER:mean(trades.map(t=>t.maeR)),averageMFER:mean(trades.map(t=>t.mfeR)),
    averageCostR:mean(trades.map(t=>t.estimatedCostR)),
    totalCostR:trades.reduce((s,t)=>s+t.estimatedCostR,0),
    endingNormalizedEquityIndex:Number(equity.toFixed(6)),
    confidence:trades.length<30?"INSUFFICIENT_DATA":"SAMPLE_AVAILABLE"
  };
}
function groupBy(trades,keyFn) {
  const groups=new Map();
  for (const t of trades) {
    const key=keyFn(t);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(t);
  }
  return [...groups.entries()].map(([key,rows])=>({key,...summarize(rows)})).sort((a,b)=>b.totalNetR-a.totalNetR);
}
function evidenceTag(t,prefix) {
  return (t.evidence||[]).find(x=>x.startsWith(prefix)) || prefix+"UNKNOWN";
}
function buildBreakdowns(trades) {
  return {
    byDirection:groupBy(trades,t=>t.direction),
    bySetup:groupBy(trades,t=>t.setupId),
    byExitReason:groupBy(trades,t=>t.exitReason),
    byHTFBias:groupBy(trades,t=>evidenceTag(t,"HTF_")),
    byStructure:groupBy(trades,t=>evidenceTag(t,"STRUCTURE_")),
    byZone:groupBy(trades,t=>t.zoneBounds?.type||"NO_ZONE"),
    byTechnicalCombination:groupBy(trades,t=>(t.evidence||[]).join("+")||"NO_EVIDENCE"),
    byScoreBand:groupBy(trades,t=>t.score>=84?"84-100":t.score>=70?"70-83":t.score>=65?"65-69":t.score>=60?"60-64":"0-59"),
    byPair:groupBy(trades,t=>t.symbol),
    byRegime:groupBy(trades,t=>t.regime||"UNAVAILABLE")
  };
}
function classifyModel(metrics,segmentMetrics) {
  if (metrics.trades < 30) return "INSUFFICIENT_SAMPLE";
  const profitableSegments=segmentMetrics.filter(x=>x.trades>=5 && x.expectancyR>0 && x.profitFactor!==null && x.profitFactor>1).length;
  if (metrics.expectancyR>0 && metrics.profitFactor>=1.5 && metrics.maxDrawdownPct<=15 && profitableSegments>=2) return "KEEP_CANDIDATE";
  if (metrics.expectancyR<0 && metrics.profitFactor<1 && segmentMetrics.filter(x=>x.trades>=5 && x.expectancyR<0 && x.profitFactor<1).length>=2) return "ELIMINATION_CANDIDATE";
  if (metrics.expectancyR>0 && metrics.profitFactor>1) return "FILTER_OR_RETEST";
  return "RETEST_OR_REDESIGN";
}
function regimeAt(timeframes, timestamp) {
  const rows=timeframes["1h"]||[];
  let i=rows.length-1;
  while(i>=0 && rows[i].timestamp+INTERVAL_MS["1h"]>timestamp)i--;
  if(i<25)return "UNAVAILABLE";
  const window=rows.slice(Math.max(0,i-23),i+1);
  const first=window[0].close,last=window.at(-1).close;
  const change=first>0?(last-first)/first:0;
  const ranges=window.map(c=>(c.high-c.low)/Math.max(c.close,Number.EPSILON));
  const vol=ranges.reduce((s,x)=>s+x,0)/ranges.length;
  if(Math.abs(change)<0.006)return vol>0.012?"RANGE_HIGH_VOL":"RANGE_LOW_VOL";
  return change>0?(vol>0.012?"UPTREND_HIGH_VOL":"UPTREND_LOW_VOL"):(vol>0.012?"DOWNTREND_HIGH_VOL":"DOWNTREND_LOW_VOL");
}
function candleSlice(timeframes,endTime) {
  return Object.fromEntries(Object.entries(timeframes).map(([tf,rows])=>[
    tf,rows.filter(c=>c.timestamp+INTERVAL_MS[tf]<=endTime)
  ]));
}

// One chronological evaluator pass per symbol/engine/entry timeframe. Each setup+direction
// has an independent trade stream so one candidate cannot hide another setup's result.
function runStrategyMatrix({engine,symbol,timeframes,evaluate,entryTimeframe,startTime,endTime,fundingRates,filterVariant}) {
  const entryRows=timeframes[entryTimeframe];
  const holdBars=Math.ceil(30*DAY/INTERVAL_MS[entryTimeframe]);
  const pointers=Object.fromEntries(Object.keys(timeframes).map(tf=>[tf,-1]));
  const tradesByModel=new Map(),counters=new Map(),lastExitByModel=new Map(),seenByModel=new Map();
  let skipped=0;
  const getCounter=(key)=>{if(!counters.has(key))counters.set(key,emptyCounter());return counters.get(key);};
  for(let i=30;i<entryRows.length-1;i++) {
    const signal=entryRows[i],asOf=signal.timestamp+INTERVAL_MS[entryTimeframe];\n    const relativeVolume=calculateRelativeVolume(entryRows,i);
    if(signal.timestamp<startTime || signal.timestamp>=endTime)continue;
    for(const [tf,rows] of Object.entries(timeframes)) {
      let p=pointers[tf];
      while(p+1<rows.length && rows[p+1].timestamp+INTERVAL_MS[tf]<=asOf)p++;
      pointers[tf]=p;
    }
    const sliced={};
    for(const [tf,rows] of Object.entries(timeframes))sliced[tf]=rows.slice(Math.max(0,pointers[tf]-399),pointers[tf]+1);
    if(Object.values(sliced).some(rows=>rows.length<25)){skipped++;continue;}
    let candidates;
    try{candidates=evaluate({symbol,timeframes:sliced,entryTimeframe,historicalBacktest:true,volumeData:{relativeVolume}});}
    catch {skipped++;continue;}
    for(const candidate of candidates) {
      const key=modelKey(engine,entryTimeframe,candidate.setupId,candidate.direction);
      const counter=getCounter(key);
      counter.signals++;
      if(!candidate.hardFilters?.validStop || !candidate.hardFilters?.minimumRR || candidate.direction==="NEUTRAL") {
        counter.hardFilterRejected++;continue;
      }
      if(candidate.state!=="QUALIFIED" || candidate.score<70) {counter.belowScore++;continue;}
      counter.qualifiedSignals++;
      const signalRegime=regimeAt(sliced,signal.timestamp);
      if(!passesSignalFilter(candidate,filterVariant,relativeVolume,signalRegime)){counter.filterRejected++;continue;}
      if(signal.timestamp <= (lastExitByModel.get(key)??-Infinity))continue;
      let seen=seenByModel.get(key);
      if(!seen){seen=new Set();seenByModel.set(key,seen);}
      if(seen.has(candidate.id))continue;
      seen.add(candidate.id);
      const future=entryRows.slice(i+1,i+1+6).filter(c=>c.timestamp<endTime);
      const confirmation=advanceEntryConfirmation(candidate,future,{maxWaitBars:6});
      if(confirmation.status!=="CONFIRMED"){counter.entryConfirmationFailed++;continue;}
      const entry=confirmation.entry,stop=candidate.stop,risk=Math.abs(entry-stop);
      if(!(risk>0)||(candidate.direction==="BULLISH"&&stop>=entry)||(candidate.direction==="BEARISH"&&stop<=entry)){counter.hardFilterRejected++;continue;}
      const stopDistancePct=risk/entry,projectedCostR=2*(FEE_RATE+SLIPPAGE_RATE)*entry/risk;
      if(stopDistancePct<MIN_STOP_DISTANCE_PCT || projectedCostR>Math.min(MAX_COST_TO_RISK,filterVariant.maxCostR)){counter.costRejected++;continue;}
      const sign=candidate.direction==="BULLISH"?1:-1,target=entry+sign*risk*3.5,tp1=entry+sign*risk;
      const after=entryRows.filter(c=>c.timestamp>confirmation.confirmedAt && c.timestamp<endTime).slice(0,holdBars);
      if(!after.length){skipped++;continue;}
      let exit=after.at(-1).close,exitAt=after.at(-1).timestamp;
      let exitReason=after.length===holdBars?"MAX_OBSERVATION_HORIZON":"SEGMENT_END";
      let tp1Hit=false,tp1At=null,realizedGrossR=0,remainingFraction=1;
      for(const c of after) {
        const stopLevel=tp1Hit?entry:stop;
        const stopHit=candidate.direction==="BULLISH"?c.low<=stopLevel:c.high>=stopLevel;
        const tp1Touched=candidate.direction==="BULLISH"?c.high>=tp1:c.low<=tp1;
        const targetHit=candidate.direction==="BULLISH"?c.high>=target:c.low<=target;
        if(stopHit) {
          exit=stopLevel;exitAt=c.timestamp;exitReason=tp1Hit?"BREAKEVEN_STOP":"STOP";
          if(tp1Hit)realizedGrossR+=remainingFraction*sign*(exit-entry)/risk;
          else realizedGrossR=sign*(exit-entry)/risk;
          remainingFraction=0;break;
        }
        if(!tp1Hit && tp1Touched) {
          tp1Hit=true;tp1At=c.timestamp;realizedGrossR+=0.5;remainingFraction=0.5;
          if(targetHit){exit=target;exitAt=c.timestamp;exitReason="TARGET_AFTER_TP1";realizedGrossR+=1.75;remainingFraction=0;break;}
          continue;
        }
        if(tp1Hit && targetHit){exit=target;exitAt=c.timestamp;exitReason="TARGET";realizedGrossR+=remainingFraction*3.5;remainingFraction=0;break;}
      }
      if(remainingFraction>0)realizedGrossR+=remainingFraction*sign*(exit-entry)/risk;
      const observed=after.filter(c=>c.timestamp<=exitAt);
      const favorable=observed.reduce((v,c)=>Math.max(v,candidate.direction==="BULLISH"?c.high-entry:entry-c.low),0);
      const adverse=observed.reduce((v,c)=>Math.max(v,candidate.direction==="BULLISH"?entry-c.low:c.high-entry),0);
      const exitTurnover=tp1Hit?0.5*tp1+0.5*exit:exit;
      const feeSlippageR=(FEE_RATE+SLIPPAGE_RATE)*(entry+exitTurnover)/risk;
      const settlements=fundingRates.filter(x=>x.fundingTime>confirmation.confirmedAt && x.fundingTime<=exitAt);
      const fundingR=settlements.reduce((sum,x)=>sum+x.fundingRate*sign*(tp1At&&x.fundingTime>tp1At?0.5:1),0)*entry/risk;
      const costR=feeSlippageR+fundingR,netR=realizedGrossR-costR;
      const evidence=candidate.evidence||[];
      const {maeR,mfeR}=calculateExcursionsR({adverseMove:adverse,favorableMove:favorable,risk});
      const trade={
        symbol,engine,setupId:candidate.setupId,direction:candidate.direction,timeframe:entryTimeframe,
        score:candidate.score,band:candidate.band,factors:candidate.factors||{},factorCoveragePct:candidate.factorCoveragePct,
        evidence,technicalCombination:evidence.join("+"),htfBias:evidenceTag({evidence},"HTF_"),
        structureContext:evidenceTag({evidence},"STRUCTURE_"),zoneType:candidate.zoneBounds?.type||"NO_ZONE",
        zoneBounds:candidate.zoneBounds||null,rewardRisk:candidate.rewardRisk,
        signalAt:signal.timestamp,entryAt:confirmation.confirmedAt,entry,stop,tp1,tp1At,tp1Hit,
        stopMovedToBreakeven:tp1Hit,target,exit,exitAt,exitReason,grossR:realizedGrossR,
        estimatedCostR:costR,feeSlippageR,fundingR,fundingSettlements:settlements.length,
        stopDistancePct,projectedCostR,relativeVolume,maeR,mfeR,netR,
        regime:regimeAt(sliced,signal.timestamp)
      };
      if(!tradesByModel.has(key))tradesByModel.set(key,[]);
      tradesByModel.get(key).push(trade);
      counter.executed++;
      lastExitByModel.set(key,exitAt);
    }
  }
  return {tradesByModel,counters,skipped};
}
function lossDiagnostics(trades) {
  const losing=trades.filter(t=>t.netR<=0);
  return {
    byExitReason:groupBy(losing,t=>t.exitReason),
    byHTFBias:groupBy(losing,t=>t.htfBias),
    byStructure:groupBy(losing,t=>t.structureContext),
    byZone:groupBy(losing,t=>t.zoneType),
    byTechnicalCombination:groupBy(losing,t=>t.technicalCombination),
    highCostLosses:losing.filter(t=>t.estimatedCostR>=Math.abs(t.grossR)*0.5).length,
    highAdverseExcursionLosses:losing.filter(t=>t.maeR>=0.8).length
  };
}

const endTime=Date.now();
const startTime=endTime-WINDOW_DAYS*DAY;
const provider=new BingXPublicKlineProvider({minRequestIntervalMs:1050});
const universe=await selectTopSymbols();
if(universe.length!==TARGET_SYMBOLS)throw new Error("INCOMPLETE_SYMBOL_UNIVERSE");
const selectedPairs=universe;
const datasets=new Map(),dataFailures=[];
for(let i=0;i<selectedPairs.length;i++) {
  const pair=selectedPairs[i];
  process.stdout.write("FETCH "+(i+1)+"/"+TARGET_SYMBOLS+" "+pair.symbol+"\n");
  try {
    // One shared candle fetch per symbol/timeframe; both engines consume the same immutable slices.
    const sharedData=await fetchEngineDataset({provider,symbol:pair.symbol,engine:"combined",startTime,endTime});
    const scalpData=sharedData;
    const swingData=sharedData;
    const fundingRates=await provider.getFundingRates({symbol:pair.symbol,startTime,endTime,limit:100});
    if(!fundingRates.length)throw new Error("PUBLIC_HISTORICAL_FUNDING_DATA_MISSING");
    datasets.set(pair.symbol,{pair,scalpData,swingData,fundingRates});
  } catch(error) {
    dataFailures.push({symbol:pair.symbol,stage:"DATA_FETCH",error:String(error?.message||error)});
  }
}
if(datasets.size!==TARGET_SYMBOLS)throw new Error("DATASET_COLLECTION_INCOMPLETE "+datasets.size+"/"+TARGET_SYMBOLS+" "+JSON.stringify(dataFailures));

const segmentReports=[];
const allTradesByModel=new Map(),allCounters=new Map();
const compositeKey=(variantId,key)=>variantId+"::"+key;
for (const variant of FILTER_VARIANTS) for (const key of ALL_MODEL_KEYS) {
  allTradesByModel.set(compositeKey(variant.id,key),[]);
  allCounters.set(compositeKey(variant.id,key),emptyCounter());
}
for(let segmentIndex=0;segmentIndex<WINDOW_DAYS/SEGMENT_DAYS;segmentIndex++) {
  const segmentStart=startTime+segmentIndex*SEGMENT_DAYS*DAY;
  const segmentEnd=segmentStart+SEGMENT_DAYS*DAY;
  const segmentTradesByModel=new Map(),segmentCounters=new Map();
  for (const variant of FILTER_VARIANTS) for (const key of ALL_MODEL_KEYS) {
    segmentTradesByModel.set(compositeKey(variant.id,key),[]);
    segmentCounters.set(compositeKey(variant.id,key),emptyCounter());
  }
  process.stdout.write("SEGMENT "+(segmentIndex+1)+"/"+(WINDOW_DAYS/SEGMENT_DAYS)+"\n");
  for(const [symbol,data] of datasets) {
    for(const engine of ENGINES) {
      const source=engine.name==="scalp"?data.scalpData:data.swingData;
      for(const entryTimeframe of engine.entryTimeframes) {
        const sliced=candleSlice(source,segmentEnd);
        for(const variant of FILTER_VARIANTS) {
          const result=runStrategyMatrix({
            engine:engine.name,symbol,timeframes:sliced,evaluate:engine.evaluate,
            entryTimeframe,startTime:segmentStart,endTime:segmentEnd,fundingRates:data.fundingRates,filterVariant:variant
          });
          for(const [key,rows] of result.tradesByModel) {
            const ck=compositeKey(variant.id,key);
            if(!segmentTradesByModel.has(ck))segmentTradesByModel.set(ck,[]);
            segmentTradesByModel.get(ck).push(...rows);
            if(!allTradesByModel.has(ck))allTradesByModel.set(ck,[]);
            allTradesByModel.get(ck).push(...rows);
          }
          for(const [key,counter] of result.counters) {
            const ck=compositeKey(variant.id,key);
            const current=segmentCounters.get(ck)||emptyCounter();
            for(const field of Object.keys(current))current[field]+=counter[field]||0;
            segmentCounters.set(ck,current);
            const total=allCounters.get(ck)||emptyCounter();
            for(const field of Object.keys(total))total[field]+=counter[field]||0;
            allCounters.set(ck,total);
          }
        }
        process.stdout.write("  "+symbol+" "+engine.name+" "+entryTimeframe+" all filter variants complete\n");
      }
    }
  }
  const modelKeys=new Set([...segmentTradesByModel.keys(),...segmentCounters.keys()]);
  const models=[];
  for(const composite of modelKeys) {
    const [variantId,key]=composite.split("::");
    const [engine,timeframe,setupId,direction]=key.split("|");
    const trades=segmentTradesByModel.get(key)||[];
    models.push({
      variantId,engine,timeframe,setupId,direction,metrics:summarize(trades),
      counters:segmentCounters.get(key)||emptyCounter(),
      breakdowns:buildBreakdowns(trades),lossDiagnostics:lossDiagnostics(trades),trades
    });
  }
  segmentReports.push({
    segment:segmentIndex+1,start:new Date(segmentStart).toISOString(),end:new Date(segmentEnd).toISOString(),
    models:models.sort((a,b)=>a.engine.localeCompare(b.engine)||a.timeframe.localeCompare(b.timeframe)||a.setupId.localeCompare(b.setupId)||a.direction.localeCompare(b.direction))
  });
}
const finalModels=[];
const allKeys=new Set([...allTradesByModel.keys(),...allCounters.keys()]);
for(const key of allKeys) {
  const [variantId,model]=key.split("::");
  const [engine,timeframe,setupId,direction]=model.split("|");
  const trades=allTradesByModel.get(key)||[];
  const segmentMetrics=segmentReports.map(s=>{
    const found=s.models.find(m=>m.variantId===variantId && modelKey(m.engine,m.timeframe,m.setupId,m.direction)===model);
    return found?.metrics||summarize([]);
  });
  const metrics=summarize(trades);
  finalModels.push({
    variantId,engine,timeframe,setupId,direction,metrics,
    decision:classifyModel(metrics,segmentMetrics),
    segmentMetrics,counters:allCounters.get(key)||emptyCounter(),
    breakdowns:buildBreakdowns(trades),lossDiagnostics:lossDiagnostics(trades),trades
  });
}
finalModels.sort((a,b)=>a.engine.localeCompare(b.engine)||a.timeframe.localeCompare(b.timeframe)||a.setupId.localeCompare(b.setupId)||a.direction.localeCompare(b.direction));
const output={
  metadata:{
    generatedAt:new Date().toISOString(),exchange:"BingX USDT-M perpetual public market data",\n    filterVariants:FILTER_VARIANTS,filterExecution:"Each filter variant is evaluated at signal qualification and maintains independent seen-candidate, cooldown, and position state. Market candles/funding are fetched once and shared across variants.",
    requestedPairs:TARGET_SYMBOLS,completedPairs:datasets.size,windowDays:WINDOW_DAYS,segmentDays:SEGMENT_DAYS,segments:segmentReports.length,universeSelection:"Top 20 eligible crypto USDT-M perpetuals by current 24h quote volume, with BTC-USDT included; present-day selection bias applies",
    engineCoverage:{scalp:{setups:SETUPS.scalp,entryTimeframes:["5m"],contextTimeframes:["1h","15m"]},swing:{setups:SETUPS.swing,entryTimeframes:["15m","1h"],contextTimeframes:["1d","4h","1h"]}},
    testedDirections:DIRECTIONS,
    costs:{feeRatePerSide:FEE_RATE,slippageRatePerSide:SLIPPAGE_RATE,maxCostToRisk:MAX_COST_TO_RISK,minStopDistancePct:MIN_STOP_DISTANCE_PCT,funding:"historical BingX settlement records only"},
    riskUnitFraction:RISK_CONFIG.riskUnitFraction,
    candidatePolicy:"Only candidates with QUALIFIED state, score >= 70, valid stop and minimum RR are eligible; entry confirmation required.",
    simulation:"Each setup+direction+entry timeframe is simulated as an independent stream. This isolates model edge; these streams are NOT a combined portfolio and overlapping trades across models/pairs are not netted.",
    walkForward:"Chronological, non-overlapping 30-day segments. Each segment is reported separately; no filters are learned from the same segment and no future segment data is used to alter earlier trades.",
    limitations:[
      "No historical order-book depth or time-varying spread; actual spread and market impact are unavailable from the OHLCV source.",
      "No historical leverage tiers or liquidation simulation; isolated margin/liquidation risk is not inferred.",
      "Funding is applied only from returned historical settlement records; missing funding causes the pair dataset to fail rather than using an estimate.",
      "Each segment is force-closed at its boundary; SEGMENT_END is reported separately.",
      "Stop-first assumption when stop and target are touched in the same candle.",
      "Normalized equity index is not an actual VST/USDT account return.",
      "Technical-context groupings are descriptive; sparse groups must not be used as standalone filters.",
      "This run ranks and diagnoses strategies; it does not delete or enable strategies in the PAPER runner."
    ]
  },
  universe:selectedPairs.map(x=>({symbol:x.symbol,quoteVolume24h:x.quoteVolume,observedSpreadPct:x.spreadPct})),
  dataFailures,
  segmentReports,
  finalModels,
  summary:{
    modelsTested:finalModels.length,
    byFilterVariant:FILTER_VARIANTS.map(v=>({variantId:v.id,label:v.label,models:finalModels.filter(m=>m.variantId===v.id).length,executedTrades:finalModels.filter(m=>m.variantId===v.id).reduce((n,m)=>n+m.metrics.trades,0),keepCandidates:finalModels.filter(m=>m.variantId===v.id&&m.decision==="KEEP_CANDIDATE").length,insufficientSample:finalModels.filter(m=>m.variantId===v.id&&m.decision==="INSUFFICIENT_SAMPLE").length})),
    keepCandidates:finalModels.filter(x=>x.decision==="KEEP_CANDIDATE").length,
    eliminationCandidates:finalModels.filter(x=>x.decision==="ELIMINATION_CANDIDATE").length,
    insufficientSample:finalModels.filter(x=>x.decision==="INSUFFICIENT_SAMPLE").length,
    retestOrRedesign:finalModels.filter(x=>["FILTER_OR_RETEST","RETEST_OR_REDESIGN"].includes(x.decision)).length
  }
};
await writeFile("bingx-strategy-matrix-20-pairs-30d-report.json",JSON.stringify(output,null,2)+"\n",{encoding:"utf8"});
process.stdout.write(JSON.stringify({
  metadata:output.metadata,summary:output.summary,
  models:finalModels.map(({engine,timeframe,setupId,direction,metrics,decision,counters})=>({engine,timeframe,setupId,direction,metrics,decision,counters}))
},null,2)+"\n");
