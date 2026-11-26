import { RISK_CONFIG } from "./config.js";
import { advanceEntryConfirmation } from "./entry-confirmation.js";

const DAY=86400000;
const TF_MS={"5m":300000,"15m":900000,"1h":3600000,"4h":14400000,"1d":86400000};
const finite=Number.isFinite;
function assertCandles(rows,name){
  if(!Array.isArray(rows)||rows.length<30)throw new Error("INSUFFICIENT_BACKTEST_DATA_"+name);
  let prev=-Infinity;
  for(const c of rows){
    for(const k of ["timestamp","open","high","low","close","volume"])if(!finite(c[k]))throw new Error("INVALID_CANDLE_"+name);
    if(c.timestamp<=prev||c.closed!==true)throw new Error("NON_CHRONOLOGICAL_OR_OPEN_CANDLE_"+name);
    prev=c.timestamp;
  }
}
function summarize(engine,symbol,days,trades,initialEquity,skipped){
  const wins=trades.filter(t=>t.netR>0),losses=trades.filter(t=>t.netR<=0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=initialEquity,peak=equity,maxDrawdown=0;
  for(const t of trades){equity*=1+t.netR*RISK_CONFIG.riskUnitFraction;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);}
  const totalR=trades.reduce((s,t)=>s+t.netR,0);
  return {engine,symbol,periodDays:days,initialEquity,endingEquity:Number(equity.toFixed(4)),trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?wins.length/trades.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin?Infinity:0,expectancyR:trades.length?totalR/trades.length:0,totalR,maxDrawdownPct:maxDrawdown*100,skipped,feesIncluded:true,confidence:trades.length<30?"INSUFFICIENT_DATA":"SAMPLE_AVAILABLE"};
}
export function runHistoricalBacktest({engine,symbol,timeframes,evaluate,periodDays=[30,60,90],initialEquity,feeRate=0.0005,slippageRate=0.0002,fundingRate=0,fundingRates=[],maxHoldBars=500,maxWaitBars=6,entryTimeframe}){
  if(!["scalp","swing"].includes(engine))throw new Error("INVALID_ENGINE");
  if(typeof evaluate!=="function")throw new TypeError("evaluate callback is required");
  if(!finite(initialEquity)||initialEquity<=0)throw new RangeError("VERIFIED_INITIAL_EQUITY_REQUIRED");
  const entryTf=engine==="scalp"?"5m":(entryTimeframe??"15m");
  if(engine==="swing"&&!["15m","1h"].includes(entryTf))throw new Error("UNSUPPORTED_SWING_ENTRY_TIMEFRAME");
  const entryRows=timeframes?.[entryTf];
  for(const [tf,rows] of Object.entries(timeframes??{})){if(!TF_MS[tf])throw new Error("UNSUPPORTED_BACKTEST_TIMEFRAME_"+tf);assertCandles(rows,tf);}
  if(!entryRows)throw new Error("MISSING_ENTRY_TIMEFRAME_"+entryTf);
  for(const tf of engine==="scalp"?["1h","15m","5m"]:["1d","4h","1h",entryTf])if(!timeframes[tf])throw new Error("MISSING_TIMEFRAME_"+tf);
  if(!Number.isInteger(maxHoldBars)||maxHoldBars<1)throw new RangeError("INVALID_MAX_HOLD_BARS");
  const reports=[];
  for(const days of periodDays){
    if(![30,60,90].includes(days))throw new Error("PERIOD_MUST_BE_30_60_OR_90_DAYS");
    const cutoff=entryRows.at(-1).timestamp-days*DAY;
    if(entryRows[0].timestamp>cutoff)throw new Error("INSUFFICIENT_PERIOD_HISTORY_"+days+"D");
    const pointers=Object.fromEntries(Object.keys(timeframes).map(tf=>[tf,-1]));
    const trades=[],seen=new Set();let skipped=0,lastExit=-Infinity;
    for(let i=30;i<entryRows.length-1;i++){
      const signal=entryRows[i],asOf=signal.timestamp+TF_MS[entryTf];
      for(const [tf,rows] of Object.entries(timeframes)){
        let p=pointers[tf];
        while(p+1<rows.length&&rows[p+1].timestamp+TF_MS[tf]<=asOf)p++;
        pointers[tf]=p;
      }
      if(signal.timestamp<cutoff||signal.timestamp<=lastExit)continue;
      const sliced={};
      for(const [tf,rows] of Object.entries(timeframes))sliced[tf]=rows.slice(Math.max(0,pointers[tf]-399),pointers[tf]+1);
      if(Object.values(sliced).some(rows=>rows.length<25)){skipped++;continue;}
      let candidates;
      try{candidates=evaluate({symbol,timeframes:sliced,entryTimeframe:entryTf});}catch{skipped++;continue;}
      const candidate=candidates.find(c=>c.state==="QUALIFIED"&&c.score>=80&&c.hardFilters?.validStop&&c.hardFilters?.minimumRR);
      if(!candidate||seen.has(candidate.id))continue;
      seen.add(candidate.id);
      const future=entryRows.slice(i+1,i+1+maxWaitBars);
      const confirmation=advanceEntryConfirmation(candidate,future,{maxWaitBars});
      if(confirmation.status!=="CONFIRMED"){skipped++;continue;}
      const entry=confirmation.entry,stop=candidate.stop,risk=Math.abs(entry-stop);
      if(!(risk>0)||(candidate.direction==="BULLISH"&&stop>=entry)||(candidate.direction==="BEARISH"&&stop<=entry)){skipped++;continue;}
      const target=candidate.direction==="BULLISH"?entry+risk*3.5:entry-risk*3.5;
      const after=entryRows.filter(c=>c.timestamp>confirmation.confirmedAt).slice(0,maxHoldBars);
      if(!after.length){skipped++;continue;}
      let exit=after.at(-1).close,exitAt=after.at(-1).timestamp,exitReason="DATA_END";
      for(const c of after){
        const stopHit=candidate.direction==="BULLISH"?c.low<=stop:c.high>=stop;
        const targetHit=candidate.direction==="BULLISH"?c.high>=target:c.low<=target;
        if(stopHit){exit=stop;exitAt=c.timestamp;exitReason="STOP";break;}
        if(targetHit){exit=target;exitAt=c.timestamp;exitReason="TARGET";break;}
      }
      const grossR=(candidate.direction==="BULLISH"?exit-entry:entry-exit)/risk;
      const feeSlippageR=(2*feeRate+2*slippageRate)*entry/risk;
      const settlements=Array.isArray(fundingRates)?fundingRates.filter(x=>x.fundingTime>confirmation.confirmedAt&&x.fundingTime<=exitAt):[];
      const fundingR=settlements.length?settlements.reduce((sum,x)=>sum+x.fundingRate*(candidate.direction==="BULLISH"?1:-1),0)*entry/risk:fundingRate*(candidate.direction==="BULLISH"?1:-1)*entry/risk;
      const costR=feeSlippageR+fundingR;
      const netR=grossR-costR;
      trades.push({candidateId:candidate.id,setupId:candidate.setupId,direction:candidate.direction,signalAt:signal.timestamp,entryAt:confirmation.confirmedAt,entry,stop,target,exit,exitAt,exitReason,grossR,estimatedCostR:costR,feeSlippageR,fundingR,fundingSettlements:settlements.length,netR});
      lastExit=exitAt;
    }
    reports.push({summary:summarize(engine,symbol,days,trades,initialEquity,skipped),trades});
  }
  return {engine,symbol,periods:reports.map(r=>r.summary),tradesByPeriod:Object.fromEntries(reports.map(r=>[r.summary.periodDays,r.trades])),assumptions:{riskPerTrade:RISK_CONFIG.riskUnitFraction,compounding:"CURRENT_EQUITY",feeRate,slippageRate,fundingMode:fundingRates.length?"HISTORICAL_SETTLEMENTS":"FLAT_RATE_FALLBACK",fundingRateFallback:fundingRate,stopFirstWhenStopAndTargetSameCandle:true,maxWaitBars,maxHoldBars,entryTimeframe:entryTf,entryTimeframeComparison:engine==="swing"?"1d-bias/4h-zone/1h-confirmation-for-15m-entry; 1d-bias/4h-zone/1h-entry-for-1h-entry":"NOT_APPLICABLE"},dataRange:{start:entryRows[0].timestamp,end:entryRows.at(-1).timestamp}};
}
