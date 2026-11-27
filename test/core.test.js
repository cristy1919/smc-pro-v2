import test from "node:test";
import assert from "node:assert/strict";
import {assertSupportedTimeframe,detectPivots,detectFairValueGaps,calculatePosition,enginePlan,scoreSetup,transitionSetup,CandleCache,validateCandles,RISK_CONFIG,DASHBOARD_TABS,SETUP_SCORE_MINIMUM,calculateRiskUnitUsd,initializeRiskBaseline,classifyTarget} from "../src/index.js";
const candles=rows=>rows.map(([open,high,low,close],i)=>({timestamp:i+1,open,high,low,close,volume:100,closed:true}));
test("1m and 3m forbidden",()=>{assert.throws(()=>assertSupportedTimeframe("1m"),/Forbidden/);assert.throws(()=>assertSupportedTimeframe("3m"),/Forbidden/);});
test("independent engine timeframe plans",()=>{assert.deepEqual(enginePlan("scalp").allowed,["1h","15m","5m"]);assert.deepEqual(enginePlan("swing").allowed,["1d","4h","1h","15m"]);});
test("pivot waits for right-side candle confirmation",()=>{const p=detectPivots(candles([[1,2,0,1],[1,3,1,2],[2,5,2,4],[2,4,1,3],[2,3,1,2]]),{leftBars:2,rightBars:2});assert.ok(p.some(x=>x.type==="HIGH"&&x.index===2&&x.confirmedAt===4));});
test("rejects duplicate timestamps and unclosed candles",()=>{const d=candles([[1,2,0,1],[1,2,0,1]]);d[1].timestamp=d[0].timestamp;assert.throws(()=>validateCandles(d),/increasing/);d[1].timestamp=2;d[1].closed=false;assert.throws(()=>validateCandles(d),/closed/);});
test("detects bullish FVG",()=>{const d=candles([[1,3,.5,2],[2,3.5,1,3],[3.2,5,3.2,4.5]]);assert.equal(detectFairValueGaps(d)[0].type,"BULLISH_FVG");});
test("1R is 2% of actual VST balance with no hardcoded bankroll",()=>{assert.equal(calculateRiskUnitUsd(75000),1500);assert.throws(()=>calculateRiskUnitUsd(undefined),/valid BingX VST equity/);assert.equal(calculatePosition({fixedRiskUnitUsd:1500,entry:100,stop:99,target:103.5}).riskBudget,1500);assert.equal(calculatePosition({fixedRiskUnitUsd:1500,riskMultiple:.5,entry:100,stop:99,target:101}).riskBudget,750);assert.equal(RISK_CONFIG.riskUnitFraction,.02);});
test("VST baseline is captured once and never rebased",async()=>{let stored=null,reads=0;const deps={readVstEquity:async()=>{reads++;return 75000;},loadBaseline:async()=>stored,saveBaseline:async x=>{stored=x;}};const a=await initializeRiskBaseline(deps);const b=await initializeRiskBaseline({...deps,readVstEquity:async()=>{reads++;return 90000;}});assert.equal(a.fixedRiskUnitUsd,1500);assert.equal(b.fixedRiskUnitUsd,1500);assert.equal(reads,1);});
test("missing VST baseline adapters fail closed",async()=>{await assert.rejects(()=>initializeRiskBaseline({loadBaseline:async()=>null,saveBaseline:async()=>{}}),/adapters are required/);});
test("setup RR range is inclusive from 1R through 4R",()=>{assert.throws(()=>calculatePosition({fixedRiskUnitUsd:20,entry:100,stop:99,target:100.5}),/BELOW_MINIMUM/);assert.throws(()=>calculatePosition({fixedRiskUnitUsd:20,entry:100,stop:99,target:105}),/ABOVE_MAXIMUM/);assert.equal(calculatePosition({fixedRiskUnitUsd:20,entry:100,stop:99,target:101}).rewardRisk,1);assert.equal(calculatePosition({fixedRiskUnitUsd:20,entry:100,stop:99,target:104}).rewardRisk,4);assert.deepEqual(classifyTarget({rewardRisk:4.01}),{allowed:false,reason:"RR_ABOVE_4"});assert.deepEqual(classifyTarget({rewardRisk:4}),{allowed:false,reason:"EXTENDED_TARGET_NEEDS_EXTRA_CONFIRMATION"});assert.equal(classifyTarget({rewardRisk:4,extraConfirmations:["mss","retest"],highVolume:true,structuralTargetFeasible:true}).classification,"EXTENDED_HIGH_QUALITY");assert.equal(classifyTarget({rewardRisk:3.5}).classification,"NORMAL");});
test("dashboard tabs and waiting threshold are fixed",()=>{assert.deepEqual(DASHBOARD_TABS,["Market Overview","Açık İşlemler","Scalp Scanner","Swing Scanner","Positions","Statistics","Candidates (İşlem Adayları)","Trade History","Diagnostics","Grafik"]);assert.equal(SETUP_SCORE_MINIMUM,70);});
test("Scalp and Swing score models remain separate from empirical confidence",()=>{const f={htf:100,liquidity:100,structure:100,zone:100,entry:100,volume:100};for(const engine of ["scalp","swing"]){const r=scoreSetup(engine,f);assert.equal(r.score,100);assert.equal(r.band,"HIGH_QUALITY");assert.equal(r.confidence,"INSUFFICIENT_DATA");}});
test("terminal setup cannot be reopened",()=>{const c=transitionSetup({state:"OPEN"},"CLOSED");assert.throws(()=>transitionSetup(c,"OPEN"),/Invalid/);});
test("cache validates candles",()=>{const cache=new CandleCache(),d=candles([[1,2,0,1]]);cache.set("BTC-USDT","5m",d);assert.equal(cache.get("BTC-USDT","5m"),d);});

import { readCurrentBingXVSTRiskUnit } from "../src/index.js";
test("new trade 1R is recalculated from current VST equity",async()=>{
 const account={getBalance:async()=>({source:"BINGX_VST",asset:"USDT",equity:75000})};
 const first=await readCurrentBingXVSTRiskUnit(account);
 assert.equal(first.riskUnitUsd,1500);
 account.getBalance=async()=>({source:"BINGX_VST",asset:"USDT",equity:60000});
 const next=await readCurrentBingXVSTRiskUnit(account);
 assert.equal(next.riskUnitUsd,1200);
});
test("position sizing uses current equity before any immutable baseline fallback",()=>{
 const a=calculatePosition({currentEquity:75000,fixedRiskUnitUsd:1500,entry:100,stop:99,target:103.5,side:"LONG"});
 const b=calculatePosition({currentEquity:60000,fixedRiskUnitUsd:1500,entry:100,stop:99,target:103.5,side:"LONG"});
 assert.equal(a.riskBudget,1500);
 assert.equal(b.riskBudget,1200);
});
