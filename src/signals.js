import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";
import { detectFairValueGaps, detectLiquidityPools, detectLiquiditySweeps } from "./zones.js";
import { detectOrderBlocks, detectBreakers, detectSupplyDemand, detectRollingRanges, detectRangeDeviations, detectOTE, detectCRT } from "./advanced-zones.js";
import { scoreSetup } from "./scoring.js";
import { ENGINE_CONFIG } from "./config.js";
const last=a=>a.at(-1)??null;
function factorEvidence({htf,liquidity,structure,zone,entry,volume}){return {htf:htf?100:0,liquidity:liquidity?100:0,structure:structure?100:0,zone:zone?100:0,entry:entry?100:0,volume};}
export function analyzePriceAction(candles,{engine="scalp",volumeAvailable=false}={}) {
 const cfg=ENGINE_CONFIG[engine];if(!cfg)throw new Error("Unknown engine");
 const pivots=detectPivots(candles),labels=classifyStructure(pivots),events=detectStructureEvents(candles,pivots),fvg=detectFairValueGaps(candles),pools=detectLiquidityPools(pivots),sweeps=detectLiquiditySweeps(candles,pools),obs=detectOrderBlocks(candles,{pivots,events}),breakers=detectBreakers(candles,obs),sd=detectSupplyDemand(candles,{pivots}),ranges=detectRollingRanges(candles),deviations=detectRangeDeviations(candles,ranges),ote=detectOTE(candles,pivots),crt=detectCRT(candles);
 const i=candles.length-1,c=candles[i],event=last(events.filter(x=>x.index===i)),sweep=last(sweeps.filter(x=>x.index===i)),dev=last(deviations.filter(x=>x.index===i)),crtNow=last(crt.filter(x=>x.index===i));
 const direction=sweep?.direction??dev?.direction??crtNow?.direction??event?.direction??null;
 const zone=[...fvg,...obs,...breakers,...sd,...ote].filter(z=>z.status!=="INVALIDATED"&&z.confirmedAt<=i&&c.close>=z.low&&c.close<=z.high).at(-1)??null;
 const displacement=Math.abs(c.close-c.open)>=((c.high-c.low)*0.65)&&c.high>c.low;
 const biasPivots=labels.slice(-4),bullBias=biasPivots.some(x=>x.label==="HH")&&biasPivots.some(x=>x.label==="HL"),bearBias=biasPivots.some(x=>x.label==="LH")&&biasPivots.some(x=>x.label==="LL");
 const aligned=direction==="BULLISH"?bullBias:direction==="BEARISH"?bearBias:false;
 const reversalEvidence=Boolean(sweep||dev||crtNow),structureEvidence=Boolean(event&&event.direction===direction),zoneEvidence=Boolean(zone&&(!direction||zone.direction===direction||zone.type.includes(direction)));
 const freshFvg=last(fvg.filter(z=>z.formedAt===i));
 const setupType=sweep&&freshFvg?"SWEEP_MSS_FVG":dev?"RANGE_DEVIATION":crtNow?"CRT_SWEEP_RECLAIM":last(breakers.filter(z=>z.confirmedAt===i))?"BREAKER_RETEST":event&&displacement?"BOS_DISPLACEMENT":null;
 const candidates=[];
 if(direction&&setupType){const score=volumeAvailable?scoreSetup(engine,factorEvidence({htf:aligned,liquidity:reversalEvidence,structure:structureEvidence,zone:zoneEvidence,entry:displacement,volume:100})):null;candidates.push({engine,direction,setupType,detectedAt:c.timestamp,signalIndex:i,entryZone:zone?{low:zone.low,high:zone.high}:null,score:score?.score??null,scoreBand:score?.band??"INSUFFICIENT_DATA",confidence:"INSUFFICIENT_DATA",requiresRetest:true,entryEligible:false,evidence:{liquiditySweep:Boolean(sweep),rangeDeviation:Boolean(dev),crt:Boolean(crtNow),structureEvent:event?.type??null,displacement,zoneType:zone?.type??null,volume:volumeAvailable?"AVAILABLE":"UNAVAILABLE"},reason:"RESEARCH_CANDIDATE_ONLY_CONFIRM_RETEST_AND_RISK"});}
 return {engine,lastClosedCandle:c.timestamp,structure:{pivots:labels,events},liquidity:{pools,sweeps},zones:{fvg,orderBlocks:obs,breakers,supplyDemand:sd,ranges,rangeDeviations:deviations,ote,crt},candidates};
}
export function analyzeMultiTimeframe({engine="scalp",candlesByTimeframe,volumeAvailable=false}={}) {
 const plan=ENGINE_CONFIG[engine];if(!plan)throw new Error("Unknown engine");
 for(const tf of plan.allowed){if(!Array.isArray(candlesByTimeframe?.[tf])||candlesByTimeframe[tf].length<5)throw new Error("Insufficient closed candles for "+tf);}
 const bias=analyzePriceAction(candlesByTimeframe[plan.bias],{engine,volumeAvailable});
 const zoneTf=plan.liquidity??plan.zone,zone=analyzePriceAction(candlesByTimeframe[zoneTf],{engine,volumeAvailable});
 const entry=analyzePriceAction(candlesByTimeframe[plan.entry],{engine,volumeAvailable});
 const biasEvent=bias.structure.events.at(-1),biasDirection=biasEvent?.direction??null;
 const recentStart=Math.max(0,candlesByTimeframe[zoneTf].length-3);
 const candidates=entry.candidates.map(c=>{const liquidityConfirmed=zone.liquidity.sweeps.some(x=>x.index>=recentStart)||zone.zones.rangeDeviations.some(x=>x.index>=recentStart)||zone.zones.crt.some(x=>x.index>=recentStart);const htfAligned=biasDirection===c.direction;return {...c,htfBias:biasDirection??"UNCONFIRMED",htfAligned,liquidityConfirmed:liquidityConfirmed||c.evidence.liquiditySweep||c.evidence.rangeDeviation||c.evidence.crt,status:htfAligned&&liquidityConfirmed?"WATCH":"WAIT",entryEligible:false,reason:!htfAligned?"HTF_ALIGNMENT_NOT_CONFIRMED":!liquidityConfirmed?"15M_OR_4H_LIQUIDITY_CONFIRMATION_MISSING":"RETEST_AND_RISK_CONFIRMATION_REQUIRED"};});
 return {engine,timeframes:{bias:plan.bias,zone:zoneTf,entry:plan.entry},bias,zone,entry,candidates,executionEnabled:false};
}
