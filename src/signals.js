import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";
import { detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps } from "./zones.js";
import { detectOrderBlocks, detectBreakers, detectSupplyDemand, detectRollingRanges, detectRangeDeviations, detectOTE, detectCRT } from "./advanced-zones.js";
import { scoreSetup } from "./scoring.js";
import { ENGINE_CONFIG } from "./config.js";
const last=a=>a.at(-1)??null;
function factorEvidence({bias,liquidity,structure,zone,entry,volume}){return {htf:bias?100:0,liquidity:liquidity?100:0,structure:structure?100:0,zone:zone?100:0,entry:entry?100:0,volume:volume===true?100:volume===false?0:50};}
export function analyzePriceAction(candles,{engine="scalp",volumeAvailable=false}={}) {
 const cfg=ENGINE_CONFIG[engine];if(!cfg)throw new Error("Unknown engine");const pivots=detectPivots(candles),labels=classifyStructure(pivots),events=detectStructureEvents(candles,pivots),fvg=detectFairValueGaps(candles),pools=detectLiquidityPools(pivots),sweeps=detectLiquiditySweeps(candles,pools),obs=detectOrderBlocks(candles,{pivots,events}),breakers=detectBreakers(candles,obs),sd=detectSupplyDemand(candles,{pivots}),ranges=detectRollingRanges(candles),deviations=detectRangeDeviations(candles,ranges),ote=detectOTE(candles,pivots),crt=detectCRT(candles);
 const i=candles.length-1,c=candles[i],event=last(events.filter(x=>x.index===i)),sweep=last(sweeps.filter(x=>x.index===i)),dev=last(deviations.filter(x=>x.index===i)),crtNow=last(crt.filter(x=>x.index===i));
 const direction=sweep?.direction??dev?.direction??crtNow?.direction??event?.direction??null;
 const zone=[...fvg,...obs,...breakers,...sd,...ote].filter(z=>z.status!=="INVALIDATED"&&z.confirmedAt<=i&&c.close>=z.low&&c.close<=z.high).at(-1)??null;
 const displacement=Math.abs(c.close-c.open)>=((c.high-c.low)*0.65)&&c.high>c.low;
 const biasPivots=labels.slice(-4),bullBias=biasPivots.some(x=>x.label==="HH")&&biasPivots.some(x=>x.label==="HL"),bearBias=biasPivots.some(x=>x.label==="LH")&&biasPivots.some(x=>x.label==="LL");
 const aligned=direction==="BULLISH"?bullBias:direction==="BEARISH"?bearBias:false;
 const reversalEvidence=Boolean(sweep||dev||crtNow),structureEvidence=Boolean(event&&event.direction===direction),zoneEvidence=Boolean(zone&&(!direction||zone.direction===direction||zone.type.includes(direction)));
 const setupType=sweep&&last(fvg.filter(z=>z.formedAt<=i))?"SWEEP_MSS_FVG":dev?"RANGE_DEVIATION":crtNow?"CRT_SWEEP_RECLAIM":last(breakers.filter(z=>z.confirmedAt===i))?"BREAKER_RETEST":event&&displacement?"BOS_DISPLACEMENT":null;
 const candidates=[];
 if(direction&&setupType){const score=scoreSetup(engine,factorEvidence({bias:aligned,liquidity:reversalEvidence,structure:structureEvidence,zone:zoneEvidence,entry:displacement,volume:volumeAvailable?null:null}),{validStop:true,rrAtLeastOne:true,liquid:true,candlesValid:true,directionConsistent:true});candidates.push({engine,direction,setupType,detectedAt:c.timestamp,signalIndex:i,entryZone:zone?{low:zone.low,high:zone.high}:null,score:score.score,scoreBand:score.band,confidence:"INSUFFICIENT_DATA",requiresRetest:true,entryEligible:false,evidence:{liquiditySweep:Boolean(sweep),rangeDeviation:Boolean(dev),crt:Boolean(crtNow),structureEvent:event?.type??null,displacement,zoneType:zone?.type??null,volume:volumeAvailable?"AVAILABLE":"UNAVAILABLE"},reason:"RESEARCH_CANDIDATE_ONLY_CONFIRM_RETEST_AND_RISK"});
 }
 return {engine,lastClosedCandle:c.timestamp,structure:{pivots:labels,events},liquidity:{pools,sweeps},zones:{fvg,orderBlocks:obs,breakers,supplyDemand:sd,ranges,rangeDeviations:deviations,ote,crt},candidates};
}
