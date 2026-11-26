import { canOpenPosition,calculatePosition } from "./risk.js";
export class PaperExecutionAdapter {
 constructor({store,market,account,clock=()=>Date.now(),maxOpen=10}){if(!store||!market)throw new TypeError("persistent store and market adapter required");this.store=store;this.market=market;this.account=account;this.clock=clock;this.maxOpen=maxOpen;}
 async submit(candidate,{riskMultiple=1,feeRate=0,slippageRate=0,fundingRate=0}={}){
  if(!this.account||typeof this.account.getBalance!=="function")throw new Error("VST_CURRENT_EQUITY_REQUIRED");
  const balance=await this.account.getBalance();
  if(balance.source!=="BINGX_VST"||balance.asset!=="USDT"||!Number.isFinite(balance.equity)||balance.equity<=0)throw new Error("UNVERIFIED_VST_EQUITY");
  if(candidate.engine!=="swing")throw new Error("SCALP_ENGINE_REMOVED");
  if(!["4h","1d"].includes(String(candidate.setupTimeframe??"").toLowerCase()))throw new Error("FORBIDDEN_SETUP_TIMEFRAME");
  if(candidate.status!=="QUALIFIED"||candidate.entryEligible!==true)throw new Error("CANDIDATE_NOT_ENTRY_READY");
  if(candidate.entryConfirmation?.status!=="CONFIRMED")throw new Error("ENTRY_CONFIRMATION_REQUIRED");
  const existing=await this.store.listOpenPositions();
  if(!canOpenPosition({openPositions:existing.length,maxOpen:this.maxOpen}))throw new Error("MAX_OPEN_POSITIONS");
  if(existing.some(p=>p.candidateId===candidate.id))throw new Error("DUPLICATE_POSITION");
  const mark=await this.market.getMarkPrice(candidate.symbol);
  if(!Number.isFinite(mark)||mark<=0)throw new Error("MARK_PRICE_UNAVAILABLE");
  const side=candidate.direction==="BULLISH"?"LONG":"SHORT";
  const calc=calculatePosition({currentEquity:balance.equity,riskMultiple,entry:mark,stop:candidate.stopLoss,target:candidate.takeProfit,side,feeRate,slippageRate,fundingRate});
  const p={id:candidate.id+":"+this.clock(),candidateId:candidate.id,engine:candidate.engine,symbol:candidate.symbol,side,entry:mark,stopLoss:candidate.stopLoss,takeProfit:candidate.takeProfit,quantity:calc.quantity,riskBudget:calc.riskBudget,riskUnitUsd:calc.riskUnitUsd,currentEquityAtEntry:balance.equity,marginMode:candidate.marginMode??"ISOLATED",leverage:candidate.leverage??null,state:"OPEN",openedAt:this.clock(),mode:"PAPER_SIMULATION_NOT_EXCHANGE"};
  await this.store.savePosition(p);return p;
 }
 async close(positionId,price,reason="MANUAL"){if(!Number.isFinite(price)||price<=0)throw new Error("INVALID_EXIT_PRICE");const p=await this.store.getPosition(positionId);if(!p||p.state!=="OPEN")throw new Error("POSITION_NOT_OPEN");const pnl=(price-p.entry)*(p.side==="LONG"?1:-1)*p.quantity;const closed={...p,state:"CLOSED",exit:price,exitReason:reason,closedAt:this.clock(),grossPnl:pnl};await this.store.saveTrade(closed);await this.store.deletePosition(positionId);return closed;}
}
