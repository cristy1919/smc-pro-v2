import { MarketDataProvider,validateCandles } from "./market-data.js";
export class HistoricalDataAdapter extends MarketDataProvider {
 constructor({fetchPage,normalize,now=()=>Date.now(),maxPages=100}){super();if(typeof fetchPage!=="function"||typeof normalize!=="function")throw new TypeError("fetchPage and normalize adapters are required");this.fetchPage=fetchPage;this.normalize=normalize;this.now=now;this.maxPages=maxPages;}
 async getCandles(symbol,timeframe,limit,{startTime,endTime}={}){if(!Number.isInteger(limit)||limit<1)throw new RangeError("limit must be positive");const rows=[];let cursor=startTime??null;for(let page=0;page<this.maxPages&&rows.length<limit;page++){const raw=await this.fetchPage({symbol,timeframe,limit:Math.min(1000,limit-rows.length),startTime:cursor,endTime});if(!Array.isArray(raw)||!raw.length)break;const normalized=raw.map(this.normalize);rows.push(...normalized);const next=normalized.at(-1)?.timestamp;if(!Number.isFinite(next)||next===cursor)break;cursor=next+1;if(normalized.length<Math.min(1000,limit-rows.length+normalized.length))break;}const unique=[...new Map(rows.map(c=>[c.timestamp,c])).values()].sort((a,b)=>a.timestamp-b.timestamp);const closed=unique.filter(c=>c.closed===true&&c.timestamp<=this.now());validateCandles(closed);return closed.slice(-limit);}
}

const BINGX_INTERVAL_MS=Object.freeze({"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"8h":28800000,"12h":43200000,"1d":86400000,"3d":259200000,"1w":604800000});
export class BingXSwapHistoricalDataProvider extends HistoricalDataAdapter {
 constructor({fetchImpl=fetch,baseUrl="https://open-api-vst.bingx.com",now=()=>Date.now(),maxPages=100}={}) {
  if(typeof fetchImpl!=="function")throw new TypeError("fetch implementation required");
  const normalize=(x,interval,nowMs)=>{const time=Number(x.time??x.openTime??x.timestamp);const open=Number(x.open),high=Number(x.high),low=Number(x.low),close=Number(x.close),volume=Number(x.volume);return {timestamp:time,open,high,low,close,volume,closed:Number.isFinite(time)&&time+BINGX_INTERVAL_MS[interval]<=nowMs};};
  super({now, maxPages,normalize:()=>{throw new Error("Interval context required");},fetchPage:async()=>[]});
  this.fetchImpl=fetchImpl;this.baseUrl=baseUrl.replace(/\/$/,"");this.clock=now;this.maxPages=maxPages;
 }
 async getCandles(symbol,timeframe,limit,{startTime,endTime}={}) {
  if(!Object.hasOwn(BINGX_INTERVAL_MS,timeframe))throw new Error("Unsupported or forbidden BingX interval: "+timeframe);
  if(!/^[A-Z0-9]+-[A-Z]+$/.test(symbol))throw new Error("Invalid BingX perpetual symbol");
  if(!Number.isInteger(limit)||limit<1)throw new RangeError("limit must be positive");
  const rows=[];let cursor=startTime??null;const end=endTime??this.clock();
  for(let page=0;page<this.maxPages&&rows.length<limit;page++){
   const params=new URLSearchParams({symbol,interval:timeframe,limit:String(Math.min(1440,limit-rows.length))});
   if(cursor!==null)params.set("startTime",String(cursor));if(end!==undefined)params.set("endTime",String(end));
   const response=await this.fetchImpl(this.baseUrl+"/openApi/swap/v3/quote/klines?"+params.toString(),{method:"GET",headers:{"Accept":"application/json"}});
   if(!response.ok)throw new Error("BingX klines HTTP "+response.status);
   const json=await response.json();if(json.code!==0)throw new Error("BingX klines error "+json.code+": "+(json.msg??"unknown"));
   if(!Array.isArray(json.data)||!json.data.length)break;
   const normalized=json.data.map(x=>({timestamp:Number(x.time??x.openTime??x.timestamp),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume)})).map(x=>({...x,closed:x.timestamp+BINGX_INTERVAL_MS[timeframe]<=this.clock()}));
   rows.push(...normalized);const next=Math.max(...normalized.map(x=>x.timestamp));if(!Number.isFinite(next)||next<0||next===cursor)break;cursor=next+BINGX_INTERVAL_MS[timeframe];if(json.data.length<Math.min(1440,limit-rows.length+json.data.length))break;
  }
  const unique=[...new Map(rows.map(c=>[c.timestamp,c])).values()].sort((a,b)=>a.timestamp-b.timestamp);
  const closed=unique.filter(c=>c.closed===true&&c.timestamp<=this.clock());validateCandles(closed);return closed.slice(-limit);
 }
}
