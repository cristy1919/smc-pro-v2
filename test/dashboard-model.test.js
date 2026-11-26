import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { DASHBOARD_TABS } from "../src/config.js";
import { buildDashboardSnapshot, buildLegacyDashboardPayload, createDashboardActions, toLegacyDashboardCandidate } from "../src/dashboard-model.js";

test("dashboard exposes the exact nine required tabs in order without duplicate Positions", () => {
  assert.deepEqual(DASHBOARD_TABS, [
    "Market Overview","Açık İşlemler","Swing Scanner","Positions",
    "Statistics","Candidates (İşlem Adayları)","Trade History","Diagnostics","Grafik"
  ]);
});

test("dashboard publishes only current 4H/1D Swing candidates and preserves open positions", () => {
  const snapshot=buildDashboardSnapshot({positions:[{id:"p1",symbol:"BTC-USDT",side:"LONG",state:"OPEN",engine:"scalp",entry:100,tp:110,sl:95}],swingCandidates:[
   {id:"wait1",symbol:"ETH-USDT",direction:"BULLISH",engine:"swing",setupId:"W04_BREAKER_RETEST",setupTimeframe:"4h",status:"WAIT",score:78},
   {id:"ready1",symbol:"SOL-USDT",direction:"BEARISH",engine:"swing",setupId:"W03_SWEEP_CHOCH",setupTimeframe:"1d",status:"READY",score:82},
   {id:"old",symbol:"BNB-USDT",direction:"BEARISH",engine:"swing",setupId:"W03_SWEEP_CHOCH",setupTimeframe:"1h",status:"READY",score:90},
   {id:"scalp",symbol:"ADA-USDT",direction:"LONG",engine:"scalp",setupId:"S01",setupTimeframe:"5m",status:"READY",score:99}
  ]});
  assert.equal(snapshot.openPositions.length,1);
  assert.deepEqual(snapshot.scanner.swing.map(x=>x.id),["wait1","ready1"]);
  assert.deepEqual(snapshot.pendingSetups.map(x=>x.id),["wait1"]);
  assert.deepEqual(snapshot.candidates.map(x=>x.id),["ready1"]);
  assert.equal(snapshot.counters.swingCandidates,2);
});
test("legacy candidate conversion uses the new Swing setup reasons", () => {
 const candidate=toLegacyDashboardCandidate({id:"x",symbol:"BTC-USDT",direction:"BEARISH",engine:"swing",setupId:"W04_BREAKER_RETEST",setupTimeframe:"4h",score:80,status:"READY",entry:100,target:90,stop:105});
 assert.equal(candidate.side,"SHORT");assert.equal(candidate.status,"READY");assert.match(candidate.reasonTr,/breaker/i);
});
test("legacy dashboard payload no longer publishes Scalp candidates", () => {
 const payload=buildLegacyDashboardPayload({swingCandidates:[{id:"w",symbol:"BTC-USDT",direction:"BULLISH",engine:"swing",setupId:"W01_HTF_OB_REVERSAL",setupTimeframe:"1d"}]});
 assert.equal(payload.health.scalpCandidateCount,0);assert.equal(payload.health.swingCandidateCount,1);
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
