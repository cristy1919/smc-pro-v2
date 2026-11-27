import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { DASHBOARD_TABS } from "../src/config.js";
import { buildDashboardSnapshot, buildLegacyDashboardPayload, createDashboardActions, toLegacyDashboardCandidate } from "../src/dashboard-model.js";

test("dashboard exposes the exact ten required tabs in order without duplicate Positions", () => {
  assert.deepEqual(DASHBOARD_TABS, [
    "Market Overview","Açık İşlemler","Scalp Scanner","Swing Scanner","Positions",
    "Statistics","Candidates (İşlem Adayları)","Trade History","Diagnostics","Grafik"
  ]);
});

test("dashboard publishes Scalp 5m and Swing 15m/1h candidates independently and preserves open positions", () => {
  const snapshot=buildDashboardSnapshot({
    positions:[{id:"p1",symbol:"BTC-USDT",side:"LONG",state:"OPEN",engine:"scalp",entry:100,tp:110,sl:95}],
    scalpCandidates:[
      {id:"s1",symbol:"ETH-USDT",direction:"BULLISH",engine:"scalp",setupId:"S01_SWEEP_MSS_FVG",timeframe:"5m",status:"QUALIFIED",score:81},
      {id:"bad-scalp",symbol:"XRP-USDT",direction:"BULLISH",engine:"scalp",setupId:"S01",timeframe:"1m",status:"READY",score:99}
    ],
    swingCandidates:[
      {id:"wait1",symbol:"SOL-USDT",direction:"BULLISH",engine:"swing",setupId:"W04_BREAKER_RETEST",setupTimeframe:"15m",status:"WAIT",score:78},
      {id:"ready1",symbol:"BNB-USDT",direction:"BEARISH",engine:"swing",setupTimeframe:"1h",status:"READY",score:82},
      {id:"old",symbol:"ADA-USDT",direction:"BEARISH",engine:"swing",setupTimeframe:"4h",status:"READY",score:90}
    ],
    diagnostics:{scalpStatus:"RUNNING",swingStatus:"RUNNING"}
  });
  assert.equal(snapshot.openPositions.length,1);
  assert.deepEqual(snapshot.scanner.scalp.map(x=>x.id),["s1"]);
  assert.deepEqual(snapshot.scanner.swing.map(x=>x.id),["wait1","ready1"]);
  assert.deepEqual(snapshot.pendingSetups.map(x=>x.id),["wait1"]);
  assert.deepEqual(snapshot.candidates.map(x=>x.id),["ready1"]);
  assert.equal(snapshot.counters.scalpCandidates,1);
  assert.equal(snapshot.counters.swingCandidates,2);
  assert.equal(snapshot.engines.scalp.status,"RUNNING");
  assert.equal(snapshot.engines.swing.status,"RUNNING");
});

test("legacy candidate conversion supports Scalp and Swing setup reasons", () => {
  const scalp=toLegacyDashboardCandidate({id:"s",symbol:"BTC-USDT",direction:"BULLISH",engine:"scalp",setupId:"S01_SWEEP_MSS_FVG",timeframe:"5m",score:80,status:"READY"});
  const swing=toLegacyDashboardCandidate({id:"w",symbol:"ETH-USDT",direction:"BEARISH",engine:"swing",setupId:"W04_BREAKER_RETEST",setupTimeframe:"1h",score:80,status:"READY"});
  assert.equal(scalp.engine,"scalp"); assert.match(scalp.reasonTr,/likidite/i);
  assert.equal(swing.engine,"swing"); assert.match(swing.reasonTr,/breaker/i);
});

test("legacy dashboard payload publishes both engines instead of empty Scalp arrays", () => {
  const payload=buildLegacyDashboardPayload({
    scalpCandidates:[{id:"s",symbol:"BTC-USDT",direction:"BULLISH",engine:"scalp",setupId:"S01_SWEEP_MSS_FVG",timeframe:"5m",status:"READY"}],
    swingCandidates:[{id:"w",symbol:"ETH-USDT",direction:"BEARISH",engine:"swing",setupId:"W04_BREAKER_RETEST",setupTimeframe:"1h",status:"WAIT"}]
  });
  assert.equal(payload.health.scalpCandidateCount,1);
  assert.equal(payload.health.swingCandidateCount,1);
  assert.deepEqual(payload.health.setups.map(x=>x.engine),["scalp","swing"]);
});

test("position close action validates percentage and forwards user selection", async () => {
  let received;
  const actions=createDashboardActions({closePosition:async x=>(received=x,{ok:true}),openChart:()=>true});
  await actions.close({positionId:"p1",closePercent:35});
  assert.deepEqual(received,{positionId:"p1",closePercent:35});
  await assert.rejects(()=>actions.close({positionId:"p1",closePercent:101}),RangeError);
});

test("deployed dashboard module and inline browser script parse successfully", () => {
  const source = readFileSync(new URL("../cloudflare/dashboard/deployed/index.js", import.meta.url), "utf8");
  const moduleSource = source.replace("export default {", "const __default = {");
  assert.doesNotThrow(() => new vm.Script(moduleSource), "dashboard Worker module must parse");
  const html = vm.runInNewContext(moduleSource + "\nDASHBOARD_HTML");
  const scriptStart = html.indexOf("<script>") + 8;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  assert.ok(scriptStart >= 8 && scriptEnd > scriptStart, "inline dashboard script must be present");
  const script = html.slice(scriptStart, scriptEnd);
  assert.doesNotThrow(() => new vm.Script(script), "inline dashboard JavaScript must parse");
  for (const metric of ["LONG / SHORT performansı", "Sembol performansı", "Komisyon toplamı", "Funding toplamı", "En uzun kazanç serisi"]) {
    assert.ok(script.includes(metric), "missing statistics section: " + metric);
  }
});
