import { DASHBOARD_TABS } from "./config.js";

export function buildDashboardSnapshot({market={},positions=[],scalpCandidates=[],swingCandidates=[],statistics={},diagnostics={}}={}){
  const open=positions.filter(p=>p.status==="OPEN");
  return {
    generatedAt:Date.now(),tabs:[...DASHBOARD_TABS],
    counters:{scalpPositions:open.filter(p=>p.engine==="scalp").length,swingPositions:open.filter(p=>p.engine==="swing").length,scalpCandidates:scalpCandidates.length,swingCandidates:swingCandidates.length},
    engines:{scalp:{status:diagnostics.scalpStatus??"UNKNOWN"},swing:{status:diagnostics.swingStatus??"UNKNOWN"}},
    market,openPositions:open.map(p=>({id:p.id,symbol:p.symbol,side:p.side,livePrice:p.livePrice,entry:p.entry,tp:p.target,sl:p.stop,reason:p.openReasonTr??p.reasonTr??"Açılış gerekçesi mevcut değil",engine:p.engine,timeframe:p.timeframe,unrealizedPnl:p.unrealizedPnl})),
    candidates:{scalp:scalpCandidates,swing:swingCandidates,all:[...scalpCandidates,...swingCandidates]},
    statistics,diagnostics
  };
}
export function createDashboardActions({closePosition,openChart}={}){
  return Object.freeze({
    async close({positionId,closePercent=100}){
      if(typeof closePosition!=="function")throw new Error("POSITION_CLOSE_ACTION_NOT_CONNECTED");
      if(typeof positionId!=="string"||!positionId)throw new TypeError("positionId is required");
      if(!Number.isFinite(closePercent)||closePercent<=0||closePercent>100)throw new RangeError("closePercent must be between 0 and 100");
      return closePosition({positionId,closePercent});
    },
    chart(symbol){if(typeof openChart!=="function")throw new Error("CHART_ACTION_NOT_CONNECTED");if(typeof symbol!=="string"||!symbol)throw new TypeError("symbol is required");return openChart(symbol);}
  });
}
