import test from "node:test";
import assert from "node:assert/strict";
import { BingXPublicKlineProvider } from "../src/bingx-market-data.js";

test("BingX klines page backwards when API returns newest-first capped pages", async () => {
  const interval=300000, start=1_700_000_000_000, rows=Array.from({length:2500},(_,i)=>({
    time:start+i*interval,open:"100",high:"101",low:"99",close:"100",volume:"10"
  }));
  const requests=[];
  const provider=new BingXPublicKlineProvider({
    now:()=>start+rows.length*interval+interval,
    sleep:async()=>{},minRequestIntervalMs:0,
    fetchImpl:async url=>{
      const u=new URL(url),end=Number(u.searchParams.get("endTime"));
      requests.push(end);
      const page=rows.filter(x=>x.time<=end).slice(-1000).reverse();
      return {ok:true,json:async()=>({code:0,data:page})};
    }
  });
  const candles=await provider.getCandles({symbol:"BTC-USDT",timeframe:"5m",startTime:start,endTime:start+rows.length*interval,limit:2500});
  assert.equal(candles.length,2500);
  assert.equal(candles[0].timestamp,start);
  assert.equal(candles.at(-1).timestamp,rows.at(-1).time);
  assert.ok(requests.length>=3);
  assert.ok(candles.every((c,i)=>i===0||c.timestamp>candles[i-1].timestamp));
});
