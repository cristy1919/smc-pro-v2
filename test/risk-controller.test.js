import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEntryEligibility } from "../src/risk-controller.js";
const candidate={id:"c1",engine:"swing",setupTimeframe:"4h",symbol:"BTC-USDT",direction:"BULLISH",state:"QUALIFIED",score:85,entry:100,stop:99,stopLoss:99,target:103.5,takeProfit:103.5,entryConfirmation:{status:"CONFIRMED"},hardFilters:{validStop:true,minimumRR:true,direction:true,candle:true}};
const deps={currentEquity:75000,openPositions:[],portfolioRiskCheck:()=>true,marketLiquidityCheck:()=>true,liquidationCheck:{available:true,distancePct:10,maxSafeLeverage:40}};
test("global risk gate approves only after retest, liquidity, portfolio and liquidation checks",()=>{
 const r=evaluateEntryEligibility(candidate,deps);
 assert.equal(r.eligible,true);assert.equal(r.riskBudget,1500);assert.equal(r.leverage,40);assert.equal(r.marginMode,"ISOLATED");assert.equal(r.approvedCandidate.entryEligible,true);
});
test("global risk gate fails closed when liquidity or liquidation data is unavailable",()=>{
 const r=evaluateEntryEligibility(candidate,{...deps,marketLiquidityCheck:undefined,liquidationCheck:null});
 assert.equal(r.eligible,false);assert.ok(r.reasons.includes("MARKET_LIQUIDITY_UNAVAILABLE"));assert.ok(r.reasons.includes("LIQUIDATION_DISTANCE_UNAVAILABLE"));
});
test("global risk gate prevents duplicate Swing symbol positions",()=>{
 const r=evaluateEntryEligibility(candidate,deps);
 assert.equal(r.eligible,true);
 const duplicate=evaluateEntryEligibility(candidate,{...deps,openPositions:[{engine:"swing",symbol:"BTC-USDT",status:"OPEN"}]});
 assert.equal(duplicate.eligible,false);
 assert.ok(duplicate.reasons.includes("DUPLICATE_ENGINE_SYMBOL_POSITION"));
});
test("global risk gate enforces ten open positions and reduced-risk sizing",()=>{
 const maxed=Array.from({length:10},(_,i)=>({engine:"swing",symbol:"COIN"+i,status:"OPEN"}));
 const blocked=evaluateEntryEligibility(candidate,{...deps,openPositions:maxed});
 assert.ok(blocked.reasons.includes("MAX_OPEN_POSITIONS"));
 const reduced=evaluateEntryEligibility(candidate,{...deps,riskMultiple:0.5});
 assert.equal(reduced.riskBudget,750);
});
