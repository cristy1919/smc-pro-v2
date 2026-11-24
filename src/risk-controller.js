import { RISK_CONFIG } from "./config.js";
import { calculatePosition } from "./risk.js";

export function evaluateEntryEligibility(candidate,{
 currentEquity,openPositions=[],riskMultiple=1,portfolioRiskCheck,marketLiquidityCheck,liquidationCheck,highVolume=false,extraConfirmations=[]
}={}){
 const reasons=[];
 if(!candidate||!["scalp","swing"].includes(candidate.engine))reasons.push("INVALID_ENGINE");
 if(candidate?.state!=="QUALIFIED"||candidate?.score<80)reasons.push("SCORE_BELOW_QUALIFIED");
 if(candidate?.entryConfirmation?.status!=="CONFIRMED")reasons.push("ENTRY_CONFIRMATION_PENDING");
 if(!Number.isFinite(currentEquity)||currentEquity<=0)reasons.push("VERIFIED_VST_EQUITY_UNAVAILABLE");
 if(!Array.isArray(openPositions))reasons.push("OPEN_POSITION_STATE_UNAVAILABLE");
 if(Array.isArray(openPositions)&&openPositions.length>=RISK_CONFIG.maxOpenPositions)reasons.push("MAX_OPEN_POSITIONS");
 if(Array.isArray(openPositions)&&openPositions.some(p=>p.engine===candidate?.engine&&p.symbol===candidate?.symbol&&p.status==="OPEN"))reasons.push("DUPLICATE_ENGINE_SYMBOL_POSITION");
 if(!candidate?.hardFilters?.validStop||!candidate?.hardFilters?.minimumRR||!candidate?.hardFilters?.direction||!candidate?.hardFilters?.candle)reasons.push("CANDIDATE_HARD_FILTER_FAILED");
 if(typeof marketLiquidityCheck!=="function")reasons.push("MARKET_LIQUIDITY_UNAVAILABLE");
 else if(marketLiquidityCheck({candidate})!==true)reasons.push("MARKET_LIQUIDITY_REJECTED");
 if(typeof portfolioRiskCheck!=="function")reasons.push("PORTFOLIO_RISK_UNAVAILABLE");
 else if(portfolioRiskCheck({candidate,openPositions})!==true)reasons.push("PORTFOLIO_RISK_REJECTED");
 if(!liquidationCheck||liquidationCheck.available!==true||!Number.isFinite(liquidationCheck.distancePct)||!Number.isFinite(liquidationCheck.maxSafeLeverage))reasons.push("LIQUIDATION_DISTANCE_UNAVAILABLE");
 if(![1,0.5].includes(riskMultiple))reasons.push("INVALID_RISK_MULTIPLE");
 const side=candidate?.direction==="BULLISH"?"LONG":candidate?.direction==="BEARISH"?"SHORT":null;
 const entry=candidate?.entry,stop=candidate?.stopLoss??candidate?.stop,target=candidate?.takeProfit??candidate?.target;
 if(!side||!Number.isFinite(entry)||!Number.isFinite(stop)||!Number.isFinite(target))reasons.push("INVALID_TRADE_LEVELS");
 let sizing=null,leverage=null;
 if(!reasons.length){
  const stopDistancePct=Math.abs(entry-stop)/entry*100;
  const safeLeverage=Math.min(RISK_CONFIG.maxLeverage,Math.floor(liquidationCheck.maxSafeLeverage));
  if(safeLeverage<RISK_CONFIG.minLeverage)reasons.push("SAFE_LEVERAGE_BELOW_MINIMUM");
  else if(liquidationCheck.distancePct<=stopDistancePct*1.5)reasons.push("LIQUIDATION_BUFFER_TOO_SMALL");
  else{
   leverage=safeLeverage;
   try{sizing=calculatePosition({currentEquity,riskMultiple,entry,stop,target,side});}
   catch(error){reasons.push(String(error.message??error));}
  }
 }
 const rewardRisk=Number.isFinite(entry)&&Number.isFinite(stop)&&Number.isFinite(target)?Math.abs(target-entry)/Math.abs(entry-stop):0;
 if(rewardRisk>RISK_CONFIG.normalTargetR){
  const extra=extraConfirmations.length>=2&&highVolume&&candidate.score>=90;
  if(!extra)reasons.push("EXTENDED_TARGET_NEEDS_HIGH_QUALITY_CONFIRMATION");
 }
 const eligible=reasons.length===0;
 return {eligible,reasons,marginMode:"ISOLATED",leverage:eligible?leverage:null,riskMultiple,currentEquity:Number.isFinite(currentEquity)?currentEquity:null,riskUnitUsd:sizing?.riskUnitUsd??null,riskBudget:sizing?.riskBudget??null,quantity:sizing?.quantity??null,approvedCandidate:eligible?{...candidate,entryEligible:true,status:"QUALIFIED"}:null};
}
