import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { DASHBOARD_TABS } from "../src/config.js";
import { buildDashboardSnapshot, buildLegacyDashboardPayload, createDashboardActions, toLegacyDashboardCandidate } from "../src/dashboard-model.js";

test("dashboard exposes the exact nine required tabs in order without duplicate Positions", () => {
  assert.deepEqual(DASHBOARD_TABS, [
    "Market Overview","Açık İşlemler","Scalp Scanner","Swing Scanner",
    "Statistics","Candidates (İşlem Adayları)","Trade History","Diagnostics","Grafik"
  ]);
});

test("dashboard separates pending setups, qualified candidates and engine scanners", () => {
  const snapshot = buildDashboardSnapshot({
    positions:[{id:"p1",symbol:"BTC-USDT",side:"LONG",state:"OPEN",engine:"scalp",entry:100,tp:110,sl:95}],
    scalpCandidates:[
      {id:"wait1",symbol:"ETH-USDT",direction:"BULLISH",engine:"scalp",setupId:"S02_BREAKER_RETEST",status:"WAIT",score:78},
      {id:"ready1",symbol:"SOL-USDT",direction:"BEARISH",engine:"scalp",setupId:"S03_BOS_DISPLACEMENT",status:"READY",score:82}
    ],
    swingCandidates:[{id:"wait2",symbol:"BNB-USDT",direction:"BEARISH",engine:"swing",setupId:"W03_SWEEP_CHOCH",status:"WAIT",score:65}],
    diagnostics:{modelChecks:[{model:"S01",setupCount:0},{model:"S02",setupCount:2}]}
  });
  assert.equal(snapshot.openPositions.length,1);
  assert.equal(snapshot.scanner.scalp.length,2);
  assert.equal(snapshot.scanner.swing.length,1);
  assert.deepEqual(snapshot.pendingSetups.map(x=>x.id),["wait1","wait2"]);
  assert.deepEqual(snapshot.candidates.map(x=>x.id),["ready1"]);
  assert.deepEqual(snapshot.diagnostics.modelChecks.map(x=>x.model),["S02"]);
});

test("legacy candidate conversion uses concise Turkish setup reasons", () => {
  const candidate=toLegacyDashboardCandidate({id:"x",symbol:"BTC-USDT",direction:"BEARISH",engine:"scalp",setupId:"S02_BREAKER_RETEST",score:80,status:"READY",entry:100,target:90,stop:105});
  assert.equal(candidate.side,"SHORT");
  assert.equal(candidate.status,"READY");
  assert.match(candidate.reasonTr,/emir bloğu/i);
  assert.doesNotMatch(candidate.reasonTr,/STRUCTURAL PATTERN|HIGH_QUALITY|UNAVAILABLE/);
});

test("legacy dashboard payload export remains backwards compatible", () => {
  const payload=buildLegacyDashboardPayload({scalpCandidates:[{id:"s",symbol:"BTC-USDT",direction:"BULLISH",engine:"scalp",setupId:"S01_SWEEP_MSS_FVG"}]});
  assert.equal(payload.health.scalpCandidateCount,1);
  assert.equal(payload.health.setups[0].side,"LONG");
});

test("position close action validates percentage and forwards user selection", async () => {
  let received;
  const actions=createDashboardActions({closePosition:async x=>(received=x,{ok:true}),openChart:()=>true});
  await actions.close({positionId:"p1",closePercent:35});
  assert.deepEqual(received,{positionId:"p1",closePercent:35});
  await assert.rejects(()=>actions.close({positionId:"p1",closePercent:101}),RangeError);
});

test("deployed dashboard bundle and inline browser script parse successfully", () => {
  const source = readFileSync(new URL("../cloudflare/dashboard/deployed/index.js", import.meta.url), "utf8");
  const literal = source.match(/const DASHBOARD_HTML = ("(?:\\\\.|[^"\\\\])*");\\s*const API_ORIGIN/);
  assert.ok(literal, "DASHBOARD_HTML string literal must be present");
  const html = vm.runInNewContext(literal[1]);
  const script = html.match(/<script>([\\s\\S]*?)<\\/script>/);
  assert.ok(script, "inline dashboard script must be present");
  assert.doesNotThrow(() => new vm.Script(script[1]), "inline dashboard JavaScript must parse");
  for (const metric of ["LONG / SHORT performansı", "Sembol performansı", "Komisyon toplamı", "Funding toplamı", "En uzun kazanç serisi"]) {
    assert.ok(script[1].includes(metric), "missing statistics section: " + metric);
  }
});
