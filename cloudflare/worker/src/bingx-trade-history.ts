export type BingXOrderHistoryTrade = {
  id:string; symbol:string; side:"LONG"|"SHORT"; model:string;
  entry:number|null; exitPrice:number|null; qty:number;
  feesPaidUsdt:number; pnlUsdt:number;
  closeReason:"TP"|"SL"|"MANUAL_CLOSE"|"LIQUIDATION";
  orderType:string; closedAt:number; positionId:string|null;
  executionEvents:Array<{event:string;qty:number;executionPrice:number;at:number;orderType:string}>;
  source:"BINGX_VST_ORDER_HISTORY_FALLBACK";
};

type HistoricalOrder = {
  orderId?:string|number; orderID?:string|number; symbol:string;
  side?:string; positionSide?:string; type?:string; status?:string;
  positionID?:string|number; reduceOnly?:boolean|string; closePosition?:boolean|string;
  avgPrice?:string|number; executedQty?:string|number;
  profit?:string|number; realizedPnl?:string|number; commission?:string|number;
  updateTime?:string|number; time?:string|number;
};

function finite(value:unknown):number|null {
  if(value===null||value===undefined||value==="")return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
}
function timestamp(value:unknown):number {
  const n=finite(value);
  if(n!==null)return n<1e12?n*1000:n;
  const parsed=Date.parse(String(value??""));
  return Number.isFinite(parsed)?parsed:0;
}
function truthy(value:unknown):boolean {
  return value===true||String(value??"").toLowerCase()==="true"||String(value??"")==="1";
}
function closeReason(type:string):BingXOrderHistoryTrade["closeReason"]|null {
  if(["TAKE_PROFIT_MARKET","TAKE_PROFIT"].includes(type))return "TP";
  if(["STOP_MARKET","STOP"].includes(type))return "SL";
  if(["LIQUIDATION","ADL"].includes(type))return "LIQUIDATION";
  return null;
}

/** Build a bounded fallback history from BingX allOrders when allFillOrders is
 * empty or unavailable. Exchange position IDs keep close orders tied to their
 * original entry; order IDs make the fallback idempotent with fill-derived rows. */
export function buildBingXOrderHistoryClosedTrades(orders:HistoricalOrder[]):BingXOrderHistoryTrade[] {
  const entries=new Map< --- TRUNCATED --- 5,613 chars