import test from "node:test";
import assert from "node:assert/strict";
import { advanceEntryConfirmation } from "../src/entry-confirmation.js";
import { BingXPublicKlineProvider, fetchEngineDataset } from "../src/bingx-market-data.js";
import { runHistoricalBacktest } from "../src/multi-timeframe-backtest.js";
import { createLegacyWorkerCompatibilityAdapter } from "../src/worker-compat.js";
import { buildDashboardSnapshot, createDashboardActions } from "../src/dashboard-model.js";
import { DASHBOARD_TABS } from "../src/config.js";

test("entry confirmation waits for a later closed candle and confirms zone retest",()=>{
  const candidate={createdAt:1000,direction:"BULLISH",setupId:"S02_BREAKER_RETEST",zoneBounds:{low:100,high:101}};
  const wait=advanceEntryConfirmation(candidate,[{timestamp:2000,open:99,high:99.8,low:98.9,close:99.5,closed:true}],{maxWaitBars:2});
  assert.equal(wait.status,"WAIT");
  const confirmed=advanceEntryConfirmation(candidate,[{timestamp:2000,open:100.2,high:101.1,low:100.1,close:100.8,closed:true}],{maxWaitBars:2});
  assert.equal(confirmed.status,"CONFIRMED");
  assert.equal(confirmed.method,"ZONE_RETEST_CLOSE");
  assert.equal(confirmed.entry,100.8);
});
test("entry confirmation expires after configured closed bars",()=>{
  const candidate={createdAt:1000,direction:"BEARISH",setupId:"W01_HTF_OB_REVERSAL",zoneBounds:{low:100,high:101}};
  const rows=[1,2].map(i=>({timestamp:1000+i,open:102,high:103,low:101.5,close:102.5,closed:true}));
  assert.equal(advanceEntryConfirmation(candidate,rows,{maxWaitBars:2}).status,"EXPIRED");
});
test("BingX provider normalizes public OHLCV and drops forming candle",async()=>{
  const now=1000000;
  const fetchImpl=async url=>{
    assert.match(url,/openApi\/swap\/v3\/quote\/klines/);
    return {ok:true,json:async()=>({code:0,data:[
      {time:0,open:"100",high:"101",low:"99",close:"100.5",volume:"20"},
      {time:300000,open:"100.5",high:"102",low:"100",close:"101",volume:"25"},
      {time:600000,open:"101",high:"103",low:"100.5",close:"102",volume:"30"}
    ]})};
  };
  const provider=new BingXPublicKlineProvider({fetchImpl,now:()=>now,minRequestIntervalMs:0});
  const rows=await provider.getCandles({symbol:"BTC-USDT",timeframe:"5m",startTime:0,endTime:900000});
  assert.equal(rows.length,3);
  assert.equal(rows[0].open,100);
  assert.ok(rows.every(c=>c.closed));
});
test("BingX klines paginate backwards from newest-first pages to recover full history",async()=>{
  const requests=[];
  const pages=[
    [{time:600000,open:"3",high:"3",low:"3",close:"3",volume:"1"},{time:300000,open:"2",high:"2",low:"2",close:"2",volume:"1"}],
    [{time:0,open:"1",high:"1",low:"1",close:"1",volume:"1"}]
  ];
  const provider=new BingXPublicKlineProvider({fetchImpl:async url=>{
    requests.push(new URL(url));
    return {ok:true,json:async()=>({code:0,data:pages.shift()??[]})};
  },now:()=>2000000,minRequestIntervalMs:0});
  const rows=await provider.getCandles({symbol:"BTC-USDT",timeframe:"5m",startTime:0,endTime:900000,limit:4});
  assert.deepEqual(rows.map(x=>x.timestamp),[0,300000,600000]);
  assert.equal(requests.length,2);
  assert.equal(Number(requests[1].searchParams.get("endTime")),299999);
});
test("BingX provider refuses forbidden 1m/3m trading intervals",async()=>{
  const provider=new BingXPublicKlineProvider({fetchImpl:async()=>{throw new Error("should not fetch");},now:()=>1000000,minRequestIntervalMs:0});
  await assert.rejects(()=>provider.getCandles({symbol:"BTC-USDT",timeframe:"1m",startTime:0,endTime:1000000}),/Forbidden timeframe/);
});
test("engine dataset fetch uses only independent approved timeframe sets",async()=>{
  const calls=[];
  const provider={getCandles:async args=>{calls.push(args.timeframe);return [];}};
  await assert.rejects(()=>fetchEngineDataset({provider,symbol:"BTC-USDT",engine:"scalp",startTime:0,endTime:1000000}),/SCALP_ENGINE_REMOVED/);
  await fetchEngineDataset({provider,symbol:"BTC-USDT",engine:"swing",startTime:0,endTime:1000000});
  assert.deepEqual(calls,["1d","4h"]);
});
test("walk-forward backtest produces separate trade ledger and refuses missing 90d history",()=>{
  const hour=3600000, day=24*hour, start=Date.UTC(2026,0,1);
  const make=(n,step)=>Array.from({length:n},(_,i)=>({timestamp:start+i*step,open:100.1,high:101,low:100.2,close:100.8,volume:100,closed:true}));
  const timeframes={"1d":make(80,day),"4h":make(480,4*hour)};
  let emitted=false; const fundingRates=[];
  const report=runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes,periodDays:[30],maxHoldBars:5,fundingRates,evaluate:({timeframes:tf})=>{
    if(emitted)return [];
    emitted=true;
    const last=tf["4h"].at(-1); fundingRates.push({fundingTime:last.timestamp+4*hour+30*60*1000,fundingRate:0.0001});
    return [{id:"one-trade",engine:"swing",symbol:"BTC-USDT",direction:"BULLISH",setupId:"W01_HTF_OB_REVERSAL",state:"QUALIFIED",score:85,createdAt:last.timestamp,entry:100.8,stop:99,target:107.1,zoneBounds:{low:100,high:101},hardFilters:{validStop:true,minimumRR:true}}];
  }});
  assert.equal(report.periods.length,1);
  assert.equal(report.tradesByPeriod[30].length,1);
  assert.equal(report.tradesByPeriod[30][0].exitReason,"MAX_OBSERVATION_HORIZON");
  assert.ok(report.tradesByPeriod[30][0].fundingR>0);
  assert.equal(report.tradesByPeriod[30][0].fundingSettlements,1);
  assert.equal(report.assumptions.compounding,"NORMALIZED_EQUITY_INDEX_ONLY");
  assert.equal(report.assumptions.usdtBalanceUsed,false);
  assert.equal(report.periods[0].startingEquityIndex,1);
  assert.equal(report.periods[0].initialEquity,undefined);
  assert.throws(()=>runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes,periodDays:[90],evaluate:()=>[]}),/INSUFFICIENT_PERIOD_HISTORY_90D/);
});
test("legacy compatibility adapter only publishes candidate snapshots and guards close action",async()=>{
  let saved;
  const adapter=createLegacyWorkerCompatibilityAdapter({readEngineSnapshot:async()=>({runnerEnabled:true}),writeCandidateSnapshot:async v=>{saved=v;}});
  const result=await adapter.publishCandidates({swing:[{id:"w1",engine:"swing",symbol:"BTC-USDT",direction:"BULLISH",setupId:"W01",setupTimeframe:"4h",state:"WATCH",score:70,evidence:[]}]});
  assert.equal(result.scalpCount,0);
  assert.equal(saved.schemaVersion,2);
  await assert.rejects(()=>adapter.close({positionId:"p1",closePercent:100}),/NOT_CONFIGURED/);
});
test("dashboard model publishes required tabs, independent counters and compact open positions",()=>{
  const snap=buildDashboardSnapshot({positions:[{id:"p1",status:"OPEN",engine:"swing",symbol:"BTC-USDT",side:"LONG",entry:100,target:110,stop:95,reasonTr:"Sweep ve MSS teyidi"}],swingCandidates:[{id:"w1",engine:"swing",setupTimeframe:"4h"},{id:"w2",engine:"swing",setupTimeframe:"1d"},{id:"old",engine:"swing",setupTimeframe:"1h"}]});
  assert.deepEqual(snap.tabs,DASHBOARD_TABS);
  assert.equal(snap.counters.swingPositions,1);
  assert.equal(snap.counters.swingCandidates,2);
  assert.equal(snap.openPositions[0].reason,"Sweep ve MSS teyidi");
});
test("dashboard close action validates partial close percentage and delegates",async()=>{
  let request;
  const actions=createDashboardActions({closePosition:async r=>{request=r;return {ok:true};}});
  await actions.close({positionId:"p1",closePercent:50});
  assert.deepEqual(request,{positionId:"p1",closePercent:50});
  await assert.rejects(()=>actions.close({positionId:"p1",closePercent:101}),/between 0 and 100/);
});

test("BingX public provider reads historical funding settlements with exact timestamps",async()=>{
 const provider=new BingXPublicKlineProvider({fetchImpl:async url=>({ok:true,json:async()=>({code:0,data:[{fundingTime:600000,fundingRate:"0.0001"}]})}),now:()=>2000000,minRequestIntervalMs:0});
 const rows=await provider.getFundingRates({symbol:"BTC-USDT",startTime:0,endTime:1000000,limit:100});
 assert.deepEqual(rows,[{fundingTime:600000,fundingRate:0.0001}]);
});

test("90d Swing dataset fetches only 4H and 1D setup candles", async () => {
  const calls = [];
  const provider = { getCandles: async args => { calls.push(args); return []; } };
  const endTime = Date.UTC(2026, 10, 26), startTime = endTime - 90 * 86400000;
  await fetchEngineDataset({ provider, symbol: "BTC-USDT", engine: "swing", startTime, endTime });
  const byTf = Object.fromEntries(calls.map(x => [x.timeframe, x.limit]));
  assert.equal(calls.length,2);
  assert.ok(byTf["4h"] > 500, "4H history must include 90d plus warmup");
  assert.ok(byTf["1d"] >= 120, "daily history must include 90d plus warmup");
});
test("walk-forward backtest rejects 1H and lower setup timeframes", () => {
  const hour=3600000,day=24*hour,start=Date.UTC(2026,0,1);
  const make=(n,step)=>Array.from({length:n},(_,i)=>({timestamp:start+i*step,open:100.1,high:101,low:100.2,close:100.8,volume:100,closed:true}));
  const timeframes={"1d":make(120,day),"4h":make(720,4*hour)};
  assert.throws(()=>runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes,setupTimeframe:"1h",periodDays:[30],evaluate:()=>[]}),/FORBIDDEN_SETUP_TIMEFRAME/);
  assert.throws(()=>runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes:{...timeframes,"1h":make(2880,hour)},periodDays:[30],evaluate:()=>[]}),/FORBIDDEN_BACKTEST_TIMEFRAME_1h/);
});
