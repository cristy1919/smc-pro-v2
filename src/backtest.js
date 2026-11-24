import { validateCandles } from "./market-data.js";
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
export function runBacktest({candles,signalAt,initialEquity=10000,riskFraction=.02,feeRate=.0005,slippageRate=.0002,fundingRatePerBar=0,maxOpenPositions=10,engine="scalp"}) {
 validateCandles(candles);if(typeof signalAt!=="function")throw new TypeError("signalAt callback required");
 if(!(initialEquity>0&&riskFraction>0&&riskFraction<=.02)||!Number.isInteger(maxOpenPositions)||maxOpenPositions<1)throw new RangeError("invalid equity/risk/position cap");
 let equity=initialEquity,peak=equity,maxDrawdown=0;const positions=[],trades=[],equityCurve=[{index:0,equity}];
 const closePosition=(p,index,exit,reason)=>{const gross=(exit-p.entry)*(p.side==="LONG"?1:-1)*p.qty,exitCost=p.qty*exit*(feeRate+slippageRate),net=gross-p.entryCost-exitCost-p.funding;equity+=net;trades.push({...p,exitIndex:index,exit,reason,grossPnl:gross,fees:p.entryCost+exitCost,funding:p.funding,netPnl:net,rMultiple:net/p.riskBudget,equityAfter:equity});};
 for(let i=1;i<candles.length;i++){
  const c=candles[i];
  for(let j=positions.length-1;j>=0;j--){const p=positions[j],hitStop=p.side==="LONG"?c.low<=p.stop:c.high>=p.stop,hitTarget=p.side==="LONG"?c.high>=p.target:c.low<=p.target;if(hitStop||hitTarget){closePosition(p,i,hitStop?p.stop:p.target,hitStop?"STOP":"TARGET");positions.splice(j,1);}else p.funding+=p.qty*p.entry*fundingRatePerBar;}
  if(positions.length<maxOpenPositions){const raw=signalAt(i,c,candles.slice(0,i+1)),signals=Array.isArray(raw)?raw:raw?[raw]:[];for(const s of signals){if(positions.length>=maxOpenPositions)break;if(s.engine!==engine||!["LONG","SHORT"].includes(s.side)||!Number.isFinite(s.stop)||!Number.isFinite(s.target))continue;const symbol=s.symbol??"UNKNOWN";if(positions.some(p=>p.symbol===symbol&&p.engine===engine))continue;const entry=c.close,dist=Math.abs(entry-s.stop),rr=dist?Math.abs(s.target-entry)/dist:0;if(!(dist>0&&rr>=1))continue;const risk=equity*riskFraction,qty=risk/dist,entryCost=qty*entry*(feeRate+slippageRate);positions.push({engine,symbol,side:s.side,entryIndex:i,entry,stop:s.stop,target:s.target,qty,riskBudget:risk,entryCost,funding:0,setupType:s.setupType??"UNSPECIFIED"});}}
  peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);equityCurve.push({index:i,equity});
 }
 for(const p of positions)closePosition(p,candles.length-1,candles.at(-1).close,"END_OF_DATA");
 if(positions.length)equityCurve.push({index:candles.length,equity});
 const wins=trades.filter(t=>t.netPnl>0),losses=trades.filter(t=>t.netPnl<0),grossWin=wins.reduce((s,t)=>s+t.netPnl,0),grossLoss=-losses.reduce((s,t)=>s+t.netPnl,0),sum=trades.reduce((s,t)=>s+t.netPnl,0);
 return {engine,initialEquity,finalEquity:equity,netPnl:sum,tradeCount:trades.length,winRate:trades.length?wins.length/trades.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?Infinity:0,expectancy:mean(trades.map(t=>t.netPnl)),averageR:mean(trades.map(t=>t.rMultiple)),maxDrawdown,fees:trades.reduce((s,t)=>s+t.fees,0),funding:trades.reduce((s,t)=>s+t.funding,0),maeMfe:"UNAVAILABLE_WITHOUT_TRADE_PATH_CALLBACK",trades,equityCurve,assumptions:{sameCandleStopTarget:"STOP_FIRST",signalUsesOnlyCandlesThroughIndex:true,unclosedCandlesRejected:true,maxOpenPositions}};
}
export function splitBacktestWindows(candles){validateCandles(candles);const end=candles.at(-1).timestamp;return Object.fromEntries([30,60,90].map(days=>[days,candles.filter(c=>c.timestamp>=end-days*86400000)]));}
