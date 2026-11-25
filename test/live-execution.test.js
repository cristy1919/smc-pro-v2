import test from "node:test";
import assert from "node:assert/strict";
import { getLiveReadiness, validateLiveCandidate, BingXLiveExecutionAdapter } from "../src/live-execution.js";

const baseCandidate = (overrides = {}) => ({
  id: "scalp-setup-001", engine: "scalp", symbol: "BTC-USDT", direction: "BULLISH",
  status: "QUALIFIED", entryEligible: true, entryConfirmation: { status: "CONFIRMED" },
  stopLoss: 99000, takeProfit: 103500, marginMode: "ISOLATED", leverage: 20, ...overrides
});
const contract = { minQty: 0.001, qtyStep: 0.001, tickSize: 0.1, minNotional: 5, maxLeverage: 50 };

test("live readiness remains blocked until two independent live secrets exist", () => {
  const blocked = getLiveReadiness({ BINGX_API_KEY: "demo", BINGX_API_SECRET: "demo-secret" });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes("LIVE_API_KEY"));
  const ready = getLiveReadiness({
    BINGX_API_KEY: "demo", BINGX_API_SECRET: "demo-secret",
    BINGX_LIVE_API_KEY: "live", BINGX_LIVE_API_SECRET: "live-secret", LIVE_CONTROL_TOKEN: "control"
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.liveTradingEnabled, false);
});

test("live credentials must be independently provisioned", () => {
  const state = getLiveReadiness({
    BINGX_API_KEY: "demo", BINGX_API_SECRET: "demo-secret",
    BINGX_LIVE_API_KEY: "live", BINGX_LIVE_API_SECRET: "demo-secret", LIVE_CONTROL_TOKEN: "control"
  });
  assert.equal(state.ready, false);
  assert.ok(state.blockers.includes("LIVE_CREDENTIALS_SEPARATE_FROM_DEMO"));
});

test("normal setup enforces isolated margin and 20x-50x leverage", () => {
  const result = validateLiveCandidate(baseCandidate(), {
    equity: 10000, availableMargin: 5000, openPositions: [], contract,
    markPrice: 100000, riskMultiple: 1, explicitConfirmation: true, idempotencyKey: "scalp-btc-20261125"
  });
  assert.equal(result.eligible, true);
  assert.equal(result.marginMode, "ISOLATED");
  assert.equal(result.leverage, 20);
  assert.equal(result.riskBudget, 200);
});

test("reduced-risk setup enforces 0.5R and 5x-10x leverage", () => {
  const result = validateLiveCandidate(baseCandidate({ leverage: 10 }), {
    equity: 10000, availableMargin: 5000, openPositions: [], contract,
    markPrice: 100000, riskMultiple: 0.5, explicitConfirmation: true, idempotencyKey: "scalp-btc-20261125"
  });
  assert.equal(result.eligible, true);
  assert.equal(result.riskBudget, 100);
  const invalid = validateLiveCandidate(baseCandidate({ leverage: 20 }), {
    equity: 10000, availableMargin: 5000, openPositions: [], contract,
    markPrice: 100000, riskMultiple: 0.5, explicitConfirmation: true, idempotencyKey: "scalp-btc-20261125"
  });
  assert.ok(invalid.reasons.includes("LEVERAGE_OUTSIDE_POLICY"));
});

test("ten-position cap, duplicates, and invalid quantity metadata fail closed", () => {
  const common = { equity: 10000, availableMargin: 5000, contract, markPrice: 100000,
    riskMultiple: 1, explicitConfirmation: true, idempotencyKey: "scalp-btc-20261125" };
  const full = validateLiveCandidate(baseCandidate(), { ...common, openPositions: Array.from({length:10},()=>({state:"OPEN"})) });
  assert.ok(full.reasons.includes("MAX_OPEN_POSITIONS"));
  const duplicate = validateLiveCandidate(baseCandidate(), { ...common, openPositions: [{state:"OPEN",engine:"scalp",symbol:"BTC-USDT",side:"LONG"}] });
  assert.ok(duplicate.reasons.includes("DUPLICATE_ENGINE_SYMBOL_SIDE"));
  const noRules = validateLiveCandidate(baseCandidate(), { ...common, contract: null, openPositions: [] });
  assert.ok(noRules.reasons.includes("CONTRACT_RULES_UNAVAILABLE"));
});

test("disabled live flag blocks before any exchange request", async () => {
  let called = false;
  const adapter = new BingXLiveExecutionAdapter({
    env: { BINGX_LIVE_API_KEY: "live", BINGX_LIVE_API_SECRET: "live-secret", LIVE_CONTROL_TOKEN: "control" },
    client: { getAccountSnapshot: async () => { called = true; } },
    store: {}
  });
  await assert.rejects(
    adapter.submit(baseCandidate(), { confirmation: { confirmedByUser: true, token: "control", confirmedAt: Date.now() }, idempotencyKey: "scalp-btc-20261125" }),
    /LIVE_EXECUTION_LOCKED/
  );
  assert.equal(called, false);
});

import { BingXLiveClient } from "../src/bingx-live-client.js";
import { DurableObjectLiveStore } from "../src/live-state-store.js";

test("BingX live client signs only against the production host with isolated credentials", async () => {
  let captured;
  const client = new BingXLiveClient({
    apiKey: "live-key", apiSecret: "live-secret", now: () => 1700000000000,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ code: 0, data: { marginType: "ISOLATED" } }), { status: 200 });
    }
  });
  const result = await client.getMarginMode("BTC-USDT");
  assert.equal(result, "ISOLATED");
  assert.ok(captured.url.startsWith("https://open-api.bingx.com/"));
  assert.equal(captured.init.headers["X-BX-APIKEY"], "live-key");
  assert.equal(captured.init.headers["X-SOURCE-KEY"], "BX-AI-SKILL");
  assert.ok(captured.url.includes("signature="));
  assert.ok(captured.url.includes("timestamp=1700000000000"));
  assert.ok(!captured.url.includes("open-api-vst"));
});

test("BingX live client refuses missing credentials before network access", () => {
  assert.throws(() => new BingXLiveClient({ apiKey: "key" }), /LIVE_CREDENTIALS_REQUIRED/);
});

test("live sizing uses stop distance for risk and available margin for margin ceiling", () => {
  const client = new BingXLiveClient({ apiKey: "key", apiSecret: "secret", fetchImpl: async () => { throw new Error("network should not be used"); } });
  const qty = client.roundQuantity(200, 100000, 99000, { qtyStep: 0.001, minQty: 0.001 }, 20, 5000);
  assert.ok(qty > 0);
  const riskLimitedNotional = 200 * 100000 / (1000 + 140);
  assert.ok(qty * 100000 <= riskLimitedNotional + 100);
});

test("durable live store uses dedicated DO routes and rejects invalid idempotency keys", async () => {
  const calls = [];
  const store = new DurableObjectLiveStore({
    stub: { fetch: async request => {
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ url: request.url, method: request.method, body });
      return new Response(JSON.stringify({ ok: true, claimed: true, persisted: true, positions: [] }), { status: 200 });
    } }
  });
  assert.equal(await store.claimIdempotencyKey("invalid"), false);
  assert.equal(await store.claimIdempotencyKey("live-order-key-001"), true);
  await store.saveLivePosition({ id: "p1", mode: "BINGX_LIVE", state: "OPEN" });
  await store.markLivePositionClosed("p1", { closedAt: 123 });
  assert.equal(calls.length, 3);
  assert.ok(calls.some(c => c.url.endsWith("/live/idempotency/claim")));
  assert.ok(calls.some(c => c.url.endsWith("/live/positions")));
});

import { manageLivePositions } from "../src/live-position-manager.js";

test("live position manager closes 50% at TP1 and moves stop to breakeven only once", async () => {
  let position = { id:"live-p1", mode:"BINGX_LIVE", state:"OPEN", symbol:"BTC-USDT", side:"LONG",
    entry:100, stopLoss:95, tp1:110, takeProfit:120, quantity:2, stage:0 };
  let partialCalls=0, protectionCalls=0;
  const store = {
    listLivePositions: async () => [position],
    saveLivePosition: async next => { position = { ...position, ...next }; },
    markLivePositionClosed: async () => { position = { ...position, state:"CLOSED" }; }
  };
  const client = {
    getOpenPositions: async () => [{symbol:"BTC-USDT",side:"LONG",positionAmt:"2",isolated:true}],
    getMarkPrice: async () => 111,
    reconcilePosition: async () => ({position:{positionAmt:"2"},protection:{stopLoss:true,takeProfit:true}})
  };
  const adapter = {
    partialClose: async () => { partialCalls++; return {remainingQuantity:1}; },
    updateProtection: async (_p, levels) => {
      protectionCalls++;
      assert.equal(levels.stopLoss,100);
      position = {...position, stopLoss:levels.stopLoss, takeProfit:levels.takeProfit};
      return {ok:true};
    }
  };
  const env={LIVE_TRADING_ENABLED:"true",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",
    BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",LIVE_CONTROL_TOKEN:"control"};
  const first=await manageLivePositions({env,client,store,adapter,clock:()=>1000});
  assert.equal(first.results[0].action,"TP1_HALF_CLOSED_STOP_TO_BREAKEVEN");
  assert.equal(position.quantity,1);
  assert.equal(position.stage,1);
  assert.equal(position.stopLoss,100);
  await manageLivePositions({env,client,store,adapter,clock:()=>2000});
  assert.equal(partialCalls,1);
  assert.equal(protectionCalls,1);
});

test("live position manager continues managing existing positions when new live entries are disabled", async () => {
  const env={LIVE_TRADING_ENABLED:"false",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",LIVE_CONTROL_TOKEN:"control"};
  const result=await manageLivePositions({env,client:{getOpenPositions:async()=>[]},store:{listLivePositions:async()=>[]},adapter:{}});
  assert.equal(result.ok,true);
  assert.equal(result.managed,0);
});

import { findConfirmedTrailingStop } from "../src/live-position-manager.js";

test("structural live trailing uses only pivots confirmed after entry", () => {
  const candles = [
    {time:100,open:11,high:11.4,low:11.0,close:11.2},
    {time:200,open:11.2,high:11.3,low:10.8,close:11.0},
    {time:300,open:11,high:11.2,low:10.5,close:10.9},
    {time:400,open:10.9,high:11.4,low:10.9,close:11.3},
    {time:500,open:11.3,high:11.5,low:11.1,close:11.4}
  ];
  const trail = findConfirmedTrailingStop(candles,"LONG",10,12,0.1,450);
  assert.equal(trail.stopPrice,10.4);
  assert.equal(trail.confirmedAt,500);
  const notYetConfirmed = findConfirmedTrailingStop(candles,"LONG",10,12,0.1,500);
  assert.equal(notYetConfirmed,null);
});

test("structural live trailing tightens short stops without moving them away from price", () => {
  const candles = [
    {time:100,open:8.8,high:9.1,low:8.5,close:8.7},
    {time:200,open:8.7,high:9.3,low:8.6,close:8.9},
    {time:300,open:8.9,high:9.5,low:8.8,close:9.0},
    {time:400,open:9,high:9.2,low:8.7,close:8.9},
    {time:500,open:8.9,high:9.0,low:8.6,close:8.8}
  ];
  const trail = findConfirmedTrailingStop(candles,"SHORT",10,8.5,0.1,450);
  assert.equal(trail.stopPrice,9.6);
  assert.equal(trail.confirmedAt,500);
});

import { runLiveSetupQueue } from "../src/live-runner.js";

const readyScannerSetup = (overrides={}) => ({
  model:"S01_SWEEP_MSS_FVG", symbol:"BTC-USDT", side:"LONG", tradeStyle:"SCALP",
  setupCandleTime:900000, candleTime:900000, status:"READY", entry:100,
  stopLoss:98, takeProfit:107, tp1:102, tp2:104, score:88, riskMultiplier:0.5,
  confirmations:["CLOSED_CANDLE_CONFIRMATION"], audit:{zone:{bottom:99,top:101},countertrend:true},
  ...overrides
});

test("activated live runner uses current READY scanner setup only when mark is inside its zone", async () => {
  let submitted=null;
  const env={LIVE_TRADING_ENABLED:"true",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",
    BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",LIVE_CONTROL_TOKEN:"control"};
  const store={getActivation:async()=>({active:true,id:"activation-123456",confirmedByUser:true})};
  const client={getMarkPrice:async()=>100};
  const adapter={submit:async(candidate,options)=>{submitted={candidate,options};return {ok:true};}};
  const result=await runLiveSetupQueue({env,setups:[readyScannerSetup()],client,store,adapter,clock:()=>1000000});
  assert.equal(result.results[0].action,"LIVE_ENTRY_OPENED");
  assert.equal(submitted.candidate.engine,"scalp");
  assert.equal(submitted.candidate.riskMultiplier,0.5);
  assert.equal(submitted.candidate.leverage>=5 && submitted.candidate.leverage<=10,true);
  assert.equal(submitted.options.confirmation.activationId,"activation-123456");
  assert.match(submitted.options.idempotencyKey,/^smc-[a-f0-9]{32}$/);
});

test("activated live runner leaves out-of-zone setups waiting", async () => {
  let submitted=0;
  const env={LIVE_TRADING_ENABLED:"true",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",
    BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",LIVE_CONTROL_TOKEN:"control"};
  const result=await runLiveSetupQueue({
    env,setups:[readyScannerSetup()],client:{getMarkPrice:async()=>105},
    store:{getActivation:async()=>({active:true,id:"activation-123456",confirmedByUser:true})},
    adapter:{submit:async()=>{submitted++;}},clock:()=>1000000
  });
  assert.equal(result.results[0].action,"WAIT_ENTRY_OUTSIDE_ZONE");
  assert.equal(submitted,0);
});

test("live runner requires durable explicit activation and stays disabled by default", async () => {
  const env={LIVE_TRADING_ENABLED:"false"};
  const disabled=await runLiveSetupQueue({env});
  assert.equal(disabled.reason,"LIVE_NEW_ENTRIES_DISABLED");
  const waiting=await runLiveSetupQueue({
    env:{LIVE_TRADING_ENABLED:"true",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",
      BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",LIVE_CONTROL_TOKEN:"control"},
    setups:[readyScannerSetup()],client:{getMarkPrice:async()=>100},
    store:{getActivation:async()=>({active:false,id:null})},adapter:{submit:async()=>{}},clock:()=>1000000
  });
  assert.equal(waiting.reason,"LIVE_USER_ACTIVATION_REQUIRED");
});

test("live adapter accepts a durable user activation for automated scanner entries", async () => {
  let saved=null;
  const env={LIVE_TRADING_ENABLED:"true",BINGX_API_KEY:"demo",BINGX_API_SECRET:"demo-secret",
    BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",LIVE_CONTROL_TOKEN:"control"};
  const client={
    getPositionMode:async()=>true,
    getAccountSnapshot:async()=>({source:"BINGX_LIVE",asset:"USDT",equity:10000,availableMargin:5000}),
    getOpenPositions:async()=>[],
    getOpenOrders:async()=>[],
    getMarkPrice:async()=>100000,
    getContractRules:async()=>({minQty:0.001,qtyStep:0.001,tickSize:0.1,minNotional:5,maxLeverage:50,maxLongLeverage:50,maxShortLeverage:50}),
    getMarginMode:async()=>"ISOLATED",
    setMarginMode:async()=>{},
    setLeverage:async()=>{},
    getLeverage:async()=>20,
    roundQuantity:()=>0.001,
    placeEntryWithProtection:async()=>({orderID:"entry-001"}),
    reconcilePosition:async()=>({position:{positionId:"position-001",positionAmt:0.001,entryPrice:100000},protection:{stopLoss:true,takeProfit:true}})
  };
  const store={
    getActivation:async()=>({active:true,id:"activation-123456",confirmedByUser:true}),
    claimIdempotencyKey:async()=>true,
    releaseIdempotencyKey:async()=>{},
    saveLivePosition:async p=>{saved=p;}
  };
  const adapter=new BingXLiveExecutionAdapter({env,client,store,clock:()=>1700000000000});
  const result=await adapter.submit(baseCandidate(),{
    idempotencyKey:"scalp-btc-20261125",
    confirmation:{confirmedByUser:true,token:"control",activationId:"activation-123456"}
  });
  assert.equal(result.ok,true);
  assert.equal(saved.mode,"BINGX_LIVE");
  assert.equal(saved.marginMode,"ISOLATED");
  assert.equal(saved.engine,"scalp");
});

test("BingX live contract rules use public directional leverage caps and allow absent min-notional metadata", async () => {
  const client=new BingXLiveClient({
    apiKey:"live",apiSecret:"secret",
    fetchImpl:async()=>new Response(JSON.stringify({code:0,data:{
      symbol:"BTC-USDT",quantityPrecision:3,pricePrecision:1,tradeMinQuantity:"0.001",
      maxLongLeverage:"50",maxShortLeverage:"40"
    }}),{status:200})
  });
  const rules=await client.getContractRules("BTC-USDT");
  assert.equal(rules.minQty,0.001);
  assert.equal(rules.qtyStep,0.001);
  assert.equal(rules.tickSize,0.1);
  assert.equal(rules.maxLongLeverage,50);
  assert.equal(rules.maxShortLeverage,40);
  assert.equal(rules.minNotional,0);
});

test("live activation invalidation is a system-only disable path and never grants activation", async () => {
  let posted=null;
  const store=new DurableObjectLiveStore({
    stub:{fetch:async request=>{
      posted=await request.json();
      return new Response(JSON.stringify({ok:true,activation:{active:false}}),{status:200});
    }},
    now:()=>1700000000000
  });
  await store.invalidateActivation();
  assert.equal(posted.active,false);
  assert.equal(posted.systemInvalidation,true);
  assert.equal(posted.confirmedByUser,false);
});

test("live position management remains available with only live credentials after entry flag is off", async () => {
  const env={LIVE_TRADING_ENABLED:"false",BINGX_LIVE_API_KEY:"live",BINGX_LIVE_API_SECRET:"live-secret",LIVE_CONTROL_TOKEN:"control"};
  const client={
    closePosition:async()=>({orderID:"close-001"}),
    getPosition:async()=>null
  };
  let closed=null;
  const store={markLivePositionClosed:async(id,meta)=>{closed={id,meta};}};
  const adapter=new BingXLiveExecutionAdapter({env,client,store,clock:()=>1000});
  const result=await adapter.close({id:"live-pos-001",mode:"BINGX_LIVE",state:"OPEN",symbol:"BTC-USDT",side:"LONG"});
  assert.equal(result.ok,true);
  assert.equal(closed.id,"live-pos-001");
});
