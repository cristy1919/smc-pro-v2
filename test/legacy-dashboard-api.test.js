import test from "node:test";
import assert from "node:assert/strict";
import { LegacySmcDashboardApi } from "../src/legacy-dashboard-api.js";
import { buildLegacyDashboardPayload } from "../src/dashboard-model.js";

test("legacy API adapter reads dashboard and paper endpoints without starting scans",async()=>{
 const paths=[];
 const api=new LegacySmcDashboardApi({baseUrl:"https://smc.example",fetchImpl:async url=>{paths.push(new URL(url).pathname);return {ok:true,json:async()=>({ok:true,positions:[]})};}});
 await api.getDashboardData();await api.getPaperStatus();await api.getAnalytics();
 assert.deepEqual(paths,["/api/data","/api/paper/status","/api/paper/analytics"]);
});
test("legacy API adapter sends manual close through the existing confirmed close route",async()=>{
 let request;
 const api=new LegacySmcDashboardApi({baseUrl:"https://smc.example",fetchImpl:async(url,init)=>{request={url:String(url),init};return {ok:true,json:async()=>({ok:true})};}});
 await api.closePosition({positionId:"p1",closePercent:25});
 assert.equal(new URL(request.url).pathname,"/api/close");
 assert.deepEqual(JSON.parse(request.init.body),{positionId:"p1",fraction:0.25,confirmedByUser:true});
});
test("legacy API adapter rejects forbidden chart intervals and invalid close portions",async()=>{
 const api=new LegacySmcDashboardApi({baseUrl:"https://smc.example",fetchImpl:async()=>{throw new Error("must not fetch");}});
 assert.throws(()=>api.getKlines({symbol:"BTC-USDT",interval:"1m"}),/FORBIDDEN/);
 assert.throws(()=>api.closePosition({positionId:"p1",closePercent:101}),/between 0 and 100/);
});
test("legacy dashboard publishes only Swing candidates on 4H or 1D",()=>{
 const payload=buildLegacyDashboardPayload({swingCandidates:[{id:"w1",symbol:"BTC-USDT",engine:"swing",direction:"BULLISH",setupId:"W03_SWEEP_CHOCH",setupTimeframe:"4h",score:85,confidence:"INSUFFICIENT_DATA",entry:100,stop:98,target:107,entryConfirmation:{status:"PENDING"},evidence:["SWEEP"]},{id:"old",symbol:"BTC-USDT",engine:"swing",direction:"BULLISH",setupId:"W03_SWEEP_CHOCH",setupTimeframe:"1h"}]});
 assert.equal(payload.health.scalpCandidateCount,0);assert.equal(payload.health.swingCandidateCount,1);assert.equal(payload.health.setups[0].status,"WAIT");
});
