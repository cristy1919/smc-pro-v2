import {RISK_CONFIG,calculateRiskUnitUsd} from "./config.js";
// The first VST snapshot is retained for audit; each new position sizes from current VST equity.
export async function initializeRiskBaseline({readVstEquity,loadBaseline,saveBaseline}){
 if(typeof readVstEquity!=="function"||typeof loadBaseline!=="function"||typeof saveBaseline!=="function")throw new TypeError("VST balance and persistent baseline adapters are required");
 const saved=await loadBaseline();
 if(saved){if(!Number.isFinite(saved.initialVstEquity)||!Number.isFinite(saved.initialRiskUnitUsd??saved.fixedRiskUnitUsd)||Number(saved.initialRiskUnitUsd??saved.fixedRiskUnitUsd)<=0)throw new Error("INVALID_STORED_RISK_BASELINE");return Object.freeze(saved);}
 const equity=await readVstEquity();
 const baseline={initialVstEquity:equity,initialRiskUnitUsd:calculateRiskUnitUsd(equity),fixedRiskUnitUsd:calculateRiskUnitUsd(equity),riskUnitFraction:RISK_CONFIG.riskUnitFraction,initializedAt:new Date().toISOString(),source:"BINGX_VST"};
 await saveBaseline(baseline);return Object.freeze(baseline);
}
export function calculatePosition({currentEquity,fixedRiskUnitUsd,riskMultiple=1,entry,stop,target,side=null,feeRate=0,slippageRate=0,fundingRate=0}){
 for(const [k,v] of Object.entries({riskMultiple,entry,stop,target,feeRate,slippageRate,fundingRate}))if(!Number.isFinite(v))throw new TypeError(k+" must be finite");
 const riskUnitUsd=Number.isFinite(currentEquity)?calculateRiskUnitUsd(currentEquity):fixedRiskUnitUsd;
 if(!Number.isFinite(riskUnitUsd)||riskUnitUsd<=0||riskMultiple<=0||entry<=0||stop<=0||target<=0)throw new RangeError("A valid current VST equity or explicit risk unit and positive trade values are required");
 if(side==="LONG"&&!(stop<entry&&target>entry))throw new Error("INVALID_LONG_STOP_OR_TARGET");
 if(side==="SHORT"&&!(stop>entry&&target<entry))throw new Error("INVALID_SHORT_STOP_OR_TARGET");
 const distance=Math.abs(entry-stop);if(!distance)throw new Error("INVALID_STOP");
 const rr=Math.abs(target-entry)/distance;if(rr<RISK_CONFIG.minRewardRisk)throw new Error("REWARD_RISK_BELOW_MINIMUM");if(rr>RISK_CONFIG.maxRewardRisk)throw new Error("REWARD_RISK_ABOVE_MAXIMUM");
 const fundingCost=fundingRate*(side==="SHORT"?-1:1);
 const costPerUnit=entry*(2*feeRate+2*slippageRate+fundingCost);
 if(distance+costPerUnit<=0)throw new Error("INVALID_COST_ADJUSTED_STOP_DISTANCE");
 const riskBudget=riskUnitUsd*riskMultiple,quantity=riskBudget/(distance+costPerUnit);
 return {riskUnitUsd,riskBudget,quantity,notional:quantity*entry,rewardRisk:rr,estimatedCosts:quantity*costPerUnit,currentEquity:Number.isFinite(currentEquity)?currentEquity:null};
}
export function canOpenPosition({openPositions,maxOpen=RISK_CONFIG.maxOpenPositions}){return Number.isInteger(openPositions)&&openPositions>=0&&openPositions<maxOpen;}
export function classifyTarget({rewardRisk,extraConfirmations=[],highVolume=false,structuralTargetFeasible=false}){if(!Number.isFinite(rewardRisk)||rewardRisk<RISK_CONFIG.minRewardRisk)return {allowed:false,reason:"RR_BELOW_1"};if(rewardRisk>RISK_CONFIG.maxRewardRisk)return {allowed:false,reason:"RR_ABOVE_4"};if(rewardRisk<=RISK_CONFIG.normalTargetR)return {allowed:true,classification:"NORMAL"};const confirmed=extraConfirmations.length>=2&&highVolume&&structuralTargetFeasible;return confirmed?{allowed:true,classification:"EXTENDED_HIGH_QUALITY"}:{allowed:false,reason:"EXTENDED_TARGET_NEEDS_EXTRA_CONFIRMATION"};}
export async function initializeBingXVSTRiskBaseline({account,loadBaseline,saveBaseline}){if(!account||typeof account.getBalance!=="function")throw new TypeError("A read-only BingX VST account adapter is required");return initializeRiskBaseline({readVstEquity:async()=>{const balance=await account.getBalance();if(balance.source!=="BINGX_VST"||balance.asset!=="USDT")throw new Error("UNVERIFIED_VST_BALANCE_SOURCE");return balance.equity;},loadBaseline,saveBaseline});}
export async function readCurrentBingXVSTRiskUnit(account){if(!account||typeof account.getBalance!=="function")throw new TypeError("A read-only BingX VST account adapter is required");const balance=await account.getBalance();if(balance.source!=="BINGX_VST"||balance.asset!=="USDT"||!Number.isFinite(balance.equity)||balance.equity<=0)throw new Error("UNVERIFIED_VST_EQUITY");return {source:"BINGX_VST",asset:"USDT",currentEquity:balance.equity,riskUnitUsd:calculateRiskUnitUsd(balance.equity),riskUnitFraction:RISK_CONFIG.riskUnitFraction,fetchedAt:balance.fetchedAt??new Date().toISOString()};}
