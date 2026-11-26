import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";
import { detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps } from "./zones.js";
import { detectOrderBlocks, detectBreakers, detectSupplyDemand, detectRollingRanges, detectRangeDeviations, detectOTE, detectCRT, detectMitigations } from "./advanced-zones.js";
import { validateCandles } from "./market-data.js";
import { scoreSetup } from "./scoring.js";
import { MIN_QUOTE_VOLUME_24H_USDT, MIN_RELATIVE_VOLUME, MAX_SPREAD_PCT } from "./config.js";

const SETUP_IDS = { ob:"W01_HTF_OB_REVERSAL", supply:"W02_SUPPLY_DEMAND_REVERSAL", sweep:"W03_SWEEP_CHOCH", breaker:"W04_BREAKER_RETEST", range:"W05_RANGE_DEVIATION", crt:"W06_CRT", ote:"W07_OTE", bos:"W08_BOS_CONTINUATION" };
const latest = (rows, predicate = () => true) => [...rows].filter(predicate).sort((a,b)=>b.index-a.index)[0] ?? null;
const dir = x => x?.direction ?? "NEUTRAL";
const candleDir = c => c.close > c.open ? "BULLISH" : c.close < c.open ? "BEARISH" : "NEUTRAL";
const opposite = d => d === "BULLISH" ? "BEARISH" : d === "BEARISH" ? "BULLISH" : "NEUTRAL";
function recentExtreme(candles, direction, lookback=12) {
 const rows=candles.slice(-lookback);
 return direction==="BULLISH"?Math.min(...rows.map(x=>x.low)):Math.max(...rows.map(x=>x.high));
}
function candleQuality(c) {
 const range=c.high-c.low;if(range<=0)return 0;
 const body=Math.abs(c.close-c.open)/range,loc=(c.close-c.low)/range;
 return Math.round(Math.min(100,body*65+(c.close>c.open?loc:1-loc)*35));
}
function structure(candles) {
 const pivots=classifyStructure(detectPivots(candles)),events=detectStructureEvents(candles,pivots);
 return {pivots,events,lastEvent:events.at(-1)??null};
}
function features(candles) {
 const s=structure(candles),pools=detectLiquidityPools(s.pivots),sweeps=detectLiquiditySweeps(candles,pools);
 const fvgs=detectFairValueGaps(candles).map(z=>{
  const bullish=z.type==="BULLISH_FVG";let mitigatedAt=null,filledAt=null;
  for(let i=z.formedAt+1;i<candles.length;i++){const c=candles[i],touched=bullish?c.low<=z.high:c.high>=z.low;if(!touched)continue;mitigatedAt??=i;const filled=bullish?c.low<=z.low:c.high>=z.high;if(filled){filledAt=i;break;}}
  return {...z,direction:bullish?"BULLISH":"BEARISH",mitigatedAt,filledAt,status:filledAt!==null?"FILLED":mitigatedAt!==null?"MITIGATED":"ACTIVE"};
 });
 const obs=detectMitigations(candles,detectOrderBlocks(candles,{pivots:s.pivots,events:s.events}));
 const breakers=detectBreakers(candles,detectOrderBlocks(candles,{pivots:s.pivots,events:s.events}));
 const supplyDemand=detectSupplyDemand(candles,{pivots:s.pivots}),ranges=detectRollingRanges(candles),deviations=detectRangeDeviations(candles,ranges),otes=detectOTE(candles,s.pivots),crt=detectCRT(candles);
 return {...s,pools,sweeps,fvgs,obs,breakers,supplyDemand,ranges,deviations,otes,crt};
}
function inZone(zones,price,direction) {
 return zones.find(z=>z.direction===direction&&z.confirmedAt<Infinity&&price>=z.low&&price<=z.high)??null;
}
function contextDirection(x) {
 const v=String(x?.direction??x?.bias??x??"").toUpperCase();
 return ["BULLISH","LONG","UP"].includes(v)?"BULLISH":["BEARISH","SHORT","DOWN"].includes(v)?"BEARISH":"NEUTRAL";
}
function btcContextScore(direction, context) {
 const weekly=contextDirection(context?.btc?.weekly),daily=contextDirection(context?.btc?.daily);
 if(weekly==="NEUTRAL"||daily==="NEUTRAL")return {score:null,weekly,daily,aligned:false,opposed:false};
 const aligned=(weekly===direction?1:0)+(daily===direction?1:0);
 return {score:aligned===2?100:aligned===1?55:10,weekly,daily,aligned:aligned===2,opposed:aligned===0};
}
function dominanceScore(direction, context) {
 const d=context?.dominance??{},btc=contextDirection(d.btc),alt=contextDirection(d.altcoin),usdt=contextDirection(d.usdt);
 if([btc,alt,usdt].includes("NEUTRAL"))return {score:null,btc,altcoin:alt,usdt};
 const expected=direction==="BULLISH"?{btc:"BEARISH",altcoin:"BULLISH",usdt:"BEARISH"}:{btc:"BULLISH",altcoin:"BEARISH",usdt:"BULLISH"};
 const hits=Number(btc===expected.btc)+Number(alt===expected.altcoin)+Number(usdt===expected.usdt);
 return {score:Math.round(hits/3*100),btc,altcoin:alt,usdt};
}
function marketIsLiquid(input) {
 const q=Number(input.marketQuality?.quoteVolume24h),spread=Number(input.marketQuality?.spreadPct),rv=Number(input.volumeData?.relativeVolume);
 return Number.isFinite(q)&&q>=MIN_QUOTE_VOLUME_24H_USDT&&Number.isFinite(spread)&&spread>=0&&spread<=MAX_SPREAD_PCT&&Number.isFinite(rv)&&rv>=MIN_RELATIVE_VOLUME;
}
function makeCandidate({symbol,direction,setupId,candles,timeframe,daily,fourHour,features:f,evidence,zone,input,btc,dominance,countertrend}) {
 const last=candles.at(-1),entry=last.close,stop=recentExtreme(candles.slice(0,-1),direction),risk=Math.abs(entry-stop);
 if(!Number.isFinite(entry)||!Number.isFinite(stop)||risk<=0||(direction==="BULLISH"&&stop>=entry)||(direction==="BEARISH"&&stop<=entry))return null;
 const target=direction==="BULLISH"?entry+risk*3.5:entry-risk*3.5,rr=Math.abs(target-entry)/risk;
 const event=latest(f.events),midEvent=latest(fourHour.events),dailyEvent=latest(daily.events);
 const structureScore=event?.direction===direction?(event.displacement?100:75):midEvent?.direction===direction?65:35;
 const zoneScore=zone?100:45,entryScore=candleDir(last)===direction?candleQuality(last):20;
 const volumeScore=Math.max(0,Math.min(100,50+(input.volumeData.relativeVolume-1)*35));
 const liquidityScore=evidence.some(x=>/SWEEP|RANGE|CRT/.test(x))?100:35;
 const factors={btcContext:btc.score,dominance:dominance.score,liquidity:liquidityScore,structure:structureScore,zone:zoneScore,entry:entryScore,volume:volumeScore};
 const hardFilters={validStop:true,rrAtLeastOne:rr>=1,liquid:marketIsLiquid(input),candlesValid:last.closed===true,directionConsistent:direction!=="NEUTRAL"};
 const scored=scoreSetup("swing",factors,hardFilters);
 const state=Object.values(hardFilters).every(Boolean)&&scored.score>=70?"QUALIFIED":"WATCH";
 return {id:["swing",symbol,setupId,timeframe,last.timestamp].join(":"),engine:"swing",symbol,direction,setupId,state,timeframe,setupTimeframe:timeframe,entryTimeframe:timeframe,entry,stop,target,stopLoss:stop,takeProfit:target,zoneBounds:zone?{low:zone.low,high:zone.high,type:zone.type}:null,rewardRisk:Number(rr.toFixed(2)),score:scored.score,band:scored.band,confidence:"INSUFFICIENT_DATA",factors,factorCoveragePct:scored.factorCoveragePct,hardFilters,entryConfirmation:{status:"PENDING",maxWaitBars:3,method:zone?"ZONE_RETEST_CLOSE":"CLOSED_CANDLE_CONFIRMATION"},evidence:[setupId,...evidence,"BTC_WEEKLY_"+btc.weekly,"BTC_DAILY_"+btc.daily,"BTC_DOM_"+dominance.btc,"ALT_DOM_"+dominance.altcoin,"USDT_DOM_"+dominance.usdt,...(countertrend?["COUNTERTREND_EXTRA_CONFIRMATION"]:[])],createdAt:last.timestamp,dataStatus:{btcWeekly:btc.weekly==="NEUTRAL"?"UNAVAILABLE":"AVAILABLE",btcDaily:btc.daily==="NEUTRAL"?"UNAVAILABLE":"AVAILABLE",dominance:[dominance.btc,dominance.altcoin,dominance.usdt].every(x=>x!=="NEUTRAL")?"AVAILABLE":"UNAVAILABLE",relativeVolume:"AVAILABLE",quoteVolume24h:"AVAILABLE"},marketRegime:f.ranges.at(-1)?.regime??"UNCLASSIFIED",countertrend};
}
export function evaluateScalp() { throw new Error("SCALP_ENGINE_REMOVED"); }
export function evaluateSwing(input) {
 if(!input||typeof input.symbol!=="string"||!input.symbol.trim())throw new TypeError("symbol is required");
 const setupTimeframe=input.setupTimeframe??"4h";
 if(!["4h","1d"].includes(setupTimeframe))throw new Error("FORBIDDEN_SETUP_TIMEFRAME_"+setupTimeframe);
 for(const tf of ["1d","4h"]){if(!Array.isArray(input.timeframes?.[tf]))throw new Error("MISSING_TIMEFRAME_"+tf);validateCandles(input.timeframes[tf]);if(input.timeframes[tf].length<30)throw new Error("INSUFFICIENT_CANDLES_"+tf);}
 if(!marketIsLiquid(input))return [];
 const daily=features(input.timeframes["1d"]),fourHour=features(input.timeframes["4h"]),candles=input.timeframes[setupTimeframe],f=features(candles),price=candles.at(-1).close;
 const btc=btcContextScore("BULLISH",input.marketContext),btcBear=btcContextScore("BEARISH",input.marketContext);
 const recentSweep=latest(f.sweeps,x=>x.index>=candles.length-3),deviation=latest(f.deviations,x=>x.index===candles.length-1&&x.regime==="RANGE"),crt=latest(f.crt,x=>x.index===candles.length-1),trigger=latest(f.events,x=>x.index>=candles.length-3);
 const direction=recentSweep?.direction??deviation?.direction??crt?.direction??trigger?.direction??"NEUTRAL";
 if(direction==="NEUTRAL")return [];
 const btcScore=direction==="BULLISH"?btc:btcBear,dominance=dominanceScore(direction,input.marketContext);
 const countertrend=btcScore.opposed===true;
 const displacement=latest(f.events,x=>x.direction===direction&&x.displacement&&x.index>=candles.length-3);
 const choch=latest(f.events,x=>x.direction===direction&&x.type==="CHoCH"&&x.mss===true&&x.index>=candles.length-3);
 const sweep=recentSweep?.direction===direction?recentSweep:null;
 const fvg=inZone(f.fvgs.filter(x=>x.status!=="FILLED"),price,direction);
 const breaker=inZone(f.breakers,price,direction),ob=inZone(f.obs.filter(x=>x.status!=="INVALIDATED"),price,direction);
 const sd=f.supplyDemand.find(x=>(direction==="BULLISH"?x.type==="DEMAND":x.type==="SUPPLY")&&price>=x.low&&price<=x.high)??null;
 const ote=inZone(f.otes,price,direction),range=deviation?{low:deviation.level,high:deviation.level,type:"RANGE_REENTRY"}:null;
 const strictCountertrend=Boolean(sweep&&displacement&&choch&&fvg&&trigger?.direction===direction);
 if(countertrend&&!strictCountertrend)return [];
 const candidates=[],add=(key,evidence,zone=null)=>{const c=makeCandidate({symbol:input.symbol,direction,setupId:SETUP_IDS[key],candles,timeframe:setupTimeframe,daily,fourHour,features:f,evidence,zone,input,btc:btcScore,dominance,countertrend});if(c)candidates.push(c);};
 if(ob)add("ob",["HTF_ORDER_BLOCK_REACTION"],ob);
 if(sd)add("supply",["SUPPLY_DEMAND_REACTION"],sd);
 if(sweep&&choch&&displacement&&fvg)add("sweep",["LIQUIDITY_SWEEP","CHOCH","MSS_DISPLACEMENT","FVG_CONFIRMED"],fvg);
 if(breaker)add("breaker",["BREAKER_INVALIDATION_AND_RETEST"],breaker);
 if(deviation&&range)add("range",["CONFIRMED_RANGE","DEVIATION","CLOSE_REENTRY"],range);
 if(crt)add("crt",["CRT_SWEEP_RECLAIM"]);
 if(ote)add("ote",["OTE_RETRACE"],ote);
 if(trigger?.type==="BOS"&&trigger.direction===direction&&trigger.displacement)add("bos",["BOS_CLOSE","MSB_DISPLACEMENT"]);
 return [...new Map(candidates.map(c=>[c.setupId,c])).values()].sort((a,b)=>b.score-a.score);
}
