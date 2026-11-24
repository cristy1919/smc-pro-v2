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
test("BingX provider refuses forbidden 1m/3m trading intervals",async()=>{
  const provider=new BingXPublicKlineProvider({fetchImpl:async()=>{throw new Error("should not fetch");},now:()=>1000000,minRequestIntervalMs:0});
  await assert.rejects(()=>provider.getCandles({symbol:"BTC-USDT",timeframe:"1m",startTime:0,endTime:1000000}),/Forbidden timeframe/);
});
test("engine dataset fetch uses only independent approved timeframe sets",async()=>{
  const calls=[];
  const provider={getCandles:async args=>{calls.push(args.timeframe);return [];}};
  await fetchEngineDataset({provider,symbol:"BTC-USDT",engine:"scalp",startTime:0,endTime:1000000});
  assert.deepEqual(calls,["1h","15m","5m"]);
});
test("walk-forward backtest produces separate trade ledger and refuses missing 90d history",()=>{
  const hour=3600000, day=24*hour, start=Date.UTC(2026,0,1);
  const make=(n,step)=>Array.from({length:n},(_,i)=>({timestamp:start+i*step,open:100.1,high:101,low:100.2,close:100.8,volume:100,closed:true}));
  const timeframes={"1d":make(32,day),"4h":make(192,4*hour),"1h":make(768,hour)};
  let emitted=false;
  const report=runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes,periodDays:[30],initialEquity:10000,maxHoldBars:5,evaluate:({timeframes:tf})=>{
    if(emitted)return [];
    emitted=true;
    const last=tf["1h"].at(-1);
    return [{id:"one-trade",engine:"swing",symbol:"BTC-USDT",direction:"BULLISH",setupId:"W01_HTF_OB_REVERSAL",state:"QUALIFIED",score:85,createdAt:last.timestamp,entry:100.8,stop:99,target:107.1,zoneBounds:{low:100,high:101},hardFilters:{validStop:true,minimumRR:true}}];
  }});
  assert.equal(report.periods.length,1);
  assert.equal(report.tradesByPeriod[30].length,1);
  assert.equal(report.tradesByPeriod[30][0].exitReason,"DATA_END");
  assert.equal(report.assumptions.compounding,"CURRENT_EQUITY");
  assert.throws(()=>runHistoricalBacktest({engine:"swing",symbol:"BTC-USDT",timeframes,periodDays:[90],initialEquity:10000,evaluate:()=>[]}),/INSUFFICIENT_PERIOD_HISTORY_90D/);
});
test("legacy compatibility adapter only publishes candidate snapshots and guards close action",async()=>{
  let saved;
  const adapter=createLegacyWorkerCompatibilityAdapter({readEngineSnapshot:async()=>({runnerEnabled:true}),writeCandidateSnapshot:async v=>{saved=v;}});
  const result=await adapter.publishCandidates({scalp:[{id:"s1",engine:"scalp",symbol:"BTC-USDT",direction:"BULLISH",setupId:"S01",state:"WATCH",score:70,evidence:[]}],swing:[]});
  assert.equal(result.scalpCount,1);
  assert.equal(saved.schemaVersion,1);
  await assert.rejects(()=>adapter.close({positionId:"p1",closePercent:100}),/NOT_CONFIGURED/);
});
test("dashboard model publishes required tabs, independent counters and compact open positions",()=>{
  const snap=buildDashboardSnapshot({positions:[{id:"p1",status:"OPEN",engine:"scalp",symbol:"BTC-USDT",side:"LONG",entry:100,target:110,stop:95,reasonTr:"Sweep ve MSS teyidi"}],scalpCandidates:[{id:"s1"}],swingCandidates:[{id:"w1"},{id:"w2"}]});
  assert.deepEqual(snap.tabs,DASHBOARD_TABS);
  assert.equal(snap.counters.scalpPositions,1);
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
