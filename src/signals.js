import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";
import { detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps } from "./zones.js";
import { detectOrderBlocks, detectBreakers, detectSupplyDemand, detectRollingRanges, detectRangeDeviations, detectOTE, detectCRT } from "./advanced-zones.js";
import { assertSetupTimeframe } from "./config.js";
export function analyzePriceAction(candles,{engine="swing"}={}) {
 if(engine==="scalp")throw new Error("SCALP_ENGINE_REMOVED");
 if(engine!=="swing")throw new Error("INVALID_ENGINE");
 const pivots=detectPivots(candles),labels=classifyStructure(pivots),events=detectStructureEvents(candles,pivots),fvg=detectFairValueGaps(candles),pools=detectLiquidityPools(pivots),sweeps=detectLiquiditySweeps(candles,pools),obs=detectOrderBlocks(candles,{pivots,events}),breakers=detectBreakers(candles,obs),sd=detectSupplyDemand(candles,{pivots}),ranges=detectRollingRanges(candles),deviations=detectRangeDeviations(candles,ranges),ote=detectOTE(candles,pivots),crt=detectCRT(candles);
 const i=candles.length-1,c=candles[i],event=events.filter(x=>x.index===i).at(-1),sweep=sweeps.filter(x=>x.index===i).at(-1),dev=deviations.filter(x=>x.index===i).at(-1),crtNow=crt.filter(x=>x.index===i).at(-1);
 const direction=sweep?.direction??dev?.direction??crtNow?.direction??event?.direction??null;
 const zone=[...fvg,...obs,...breakers,...sd,...ote].filter(z=>z.status!=="INVALIDATED"&&z.confirmedAt<=i&&c.close>=z.low&&c.close<=z.high).at(-1)??null;
 const displacement=Boolean(event?.displacement),structureEvent=event?.type??null;
 return {engine,lastClosedCandle:c.timestamp,structure:{pivots:labels,events},liquidity:{pools,sweeps},zones:{fvg,orderBlocks:obs,breakers,supplyDemand:sd,ranges,rangeDeviations:deviations,ote,crt},marketRegime:ranges.at(-1)?.regime??"UNCLASSIFIED",observation:{direction,displacement,structureEvent,zoneType:zone?.type??null},candidates:[]};
}
export function analyzeMultiTimeframe({engine="swing",candlesByTimeframe,setupTimeframe="4h"}={}) {
 if(engine==="scalp")throw new Error("SCALP_ENGINE_REMOVED");
 if(engine!=="swing")throw new Error("INVALID_ENGINE");
 assertSetupTimeframe(setupTimeframe);
 for(const tf of ["1d","4h"])if(!Array.isArray(candlesByTimeframe?.[tf])||candlesByTimeframe[tf].length<30)throw new Error("Insufficient closed candles for "+tf);
 const daily=analyzePriceAction(candlesByTimeframe["1d"]),fourHour=analyzePriceAction(candlesByTimeframe["4h"]),setup=analyzePriceAction(candlesByTimeframe[setupTimeframe]);
 const higher=setupTimeframe==="1d"?fourHour:daily;
 return {engine,timeframes:{bias:"1d",structure:"4h",setup:setupTimeframe},bias:daily,structure:fourHour,setup,higherTimeframeAlignment:daily.observation.direction===fourHour.observation.direction?daily.observation.direction:"MIXED",candidates:[],executionEnabled:false};
}
