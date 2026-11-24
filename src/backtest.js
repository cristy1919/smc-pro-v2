import { RISK_CONFIG } from "./config.js";
import { advanceEntryConfirmation } from "./entry-confirmation.js";

const DAY = 86400000;
const finite = n => Number.isFinite(n);
function assertCandles(rows, name) {
  if (!Array.isArray(rows) || rows.length < 30) throw new Error("INSUFFICIENT_BACKTEST_DATA_" + name);
  let prev = -Infinity;
  for (const c of rows) {
    for (const k of ["timestamp","open","high","low","close","volume"]) if (!finite(c[k])) throw new Error("INVALID_CANDLE_" + name);
    if (c.timestamp <= prev || c.closed !== true) throw new Error("NON_CHRONOLOGICAL_OR_OPEN_CANDLE_" + name);
    prev = c.timestamp;
  }
}
function summarize(engine, symbol, days, trades, initialEquity, skipped) {
  const wins=trades.filter(t=>t.netR>0), losses=trades.filter(t=>t.netR<=0);
  const grossWin=wins.reduce((s,t)=>s+t.netR,0), grossLoss=Math.abs(losses.reduce((s,t)=>s+t.netR,0));
  let equity=initialEquity, peak=equity, maxDrawdown=0;
  for (const t of trades) { equity += t.netR * initialEquity * 0.02; peak=Math.max(peak,equity); maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak); }
  const totalR=trades.reduce((s,t)=>s+t.netR,0);
  return { engine,symbol,periodDays:days,initialEquity,endingEquity:Number(equity.toFixed(4)),trades:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length? wins.length/trades.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin?Infinity:0,expectancyR:trades.length?totalR/trades.length:0,totalR,maxDrawdownPct:maxDrawdown*100,skipped,feesIncluded:true,confidence:trades.length<30?"INSUFFICIENT_DATA":"SAMPLE_AVAILABLE" };
}
export function runHistoricalBacktest({ engine,symbol,timeframes,evaluate,periodDays=[30,60,90],initialEquity,feeRate=0.0005,slippageRate=0.0002,fundingRate=0,maxHoldBars=500,maxWaitBars=6 }) {
  if (!["scalp","swing"].includes(engine)) throw new Error("INVALID_ENGINE");
  if (typeof evaluate!=="function") throw new TypeError("evaluate callback is required");
  if (!finite(initialEquity)||initialEquity<=0) throw new RangeError("VERIFIED_INITIAL_EQUITY_REQUIRED");
  for (const [tf,rows] of Object.entries(timeframes)) assertCandles(rows,tf);
  const entryTf=engine==="scalp"?"5m":"1h", entryRows=timeframes[entryTf];
  const outputs=[];
  for (const days of periodDays) {
    if (![30,60,90].includes(days)) throw new Error("PERIOD_MUST_BE_30_60_OR_90_DAYS");
    const cutoff=entryRows.at(-1).timestamp-days*DAY;
    const startIndex=entryRows.findIndex(c=>c.timestamp>=cutoff);
    const trades=[], seen=new Set(); let skipped=0, lastExit=-Infinity;
    for (let i=Math.max(startIndex,30); i<entryRows.length-1; i++) {
      const signal=entryRows[i];
      if (signal.timestamp<cutoff || signal.timestamp<=lastExit) continue;
      const sliced={};
      for (const [tf,rows] of Object.entries(timeframes)) sliced[tf]=rows.filter(c=>c.timestamp<=signal.timestamp);
      if (Object.values(sliced).some(rows=>rows.length<25)) { skipped++; continue; }
      let candidates;
      try { candidates=evaluate({symbol,timeframes:sliced}); } catch { skipped++; continue; }
      const candidate=candidates.find(c=>c.state!=="REJECTED" && c.score>=70 && c.hardFilters?.validStop && c.hardFilters?.minimumRR);
      if (!candidate || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const future=entryRows.slice(i+1,i+1+maxWaitBars);
      const confirmation=advanceEntryConfirmation(candidate,future,{maxWaitBars});
      if (confirmation.status!=="CONFIRMED") { skipped++; continue; }
      const entry=confirmation.entry, stop=candidate.stop, risk=Math.abs(entry-stop);
      if (!(risk>0) || (candidate.direction==="BULLISH"&&stop>=entry) || (candidate.direction==="BEARISH"&&stop<=entry)) { skipped++; continue; }
      const target=candidate.direction==="BULLISH"?entry+risk*3.5:entry-risk*3.5;
      let exit=null, exitReason="DATA_END";
      const after=entryRows.filter(c=>c.timestamp>confirmation.confirmedAt).slice(0,maxHoldBars);
      for (const c of after) {
        const stopHit=candidate.direction==="BULLISH"?c.low<=stop:c.high>=stop;
        const targetHit=candidate.direction==="BULLISH"?c.high>=target:c.low<=target;
        if (stopHit) { exit=stop; exitReason="STOP"; break; }
        if (targetHit) { exit=target; exitReason="TARGET"; break; }
      }
      if (exit===null) { const last=after.at(-1); if(!last) {skipped++;continue;} exit=last.close; }
      const grossR=(candidate.direction==="BULLISH"?(exit-entry):(entry-exit))/risk;
      const costR=(2*feeRate+slippageRate+Math.abs(fundingRate))*entry/risk;
      const netR=grossR-costR;
      trades.push({candidateId:candidate.id,setupId:candidate.setupId,direction:candidate.direction,signalAt:signal.timestamp,entryAt:confirmation.confirmedAt,entry,stop,target,exit,exitReason,grossR,estimatedCostR:costR,netR});
      lastExit=after.find(c=>c.timestamp>=confirmation.confirmedAt)?.timestamp ?? confirmation.confirmedAt;
    }
    outputs.push(summarize(engine,symbol,days,trades,initialEquity,skipped));
  }
  return {engine,symbol,periods:outputs,tradesByPeriod:Object.fromEntries(outputs.map(o=>[o.periodDays, tradesForPeriodPlaceholder(o)])),assumptions:{riskPerTrade:RISK_CONFIG.riskUnitFraction,feeRate,slippageRate,fundingRate,stopFirstWhenStopAndTargetSameCandle:true,maxWaitBars,maxHoldBars,entryTimeframe:entryTf},dataRange:{start:entryRows[0].timestamp,end:entryRows.at(-1).timestamp}};
}
function tradesForPeriodPlaceholder(summary) { return {tradeCount:summary.trades,winRate:summary.winRate,expectancyR:summary.expectancyR}; }
