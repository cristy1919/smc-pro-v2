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

export function toLegacyDashboardCandidate(candidate){
  const setupReasons={
    S01_SWEEP_MSS_FVG:"Likidite süpürmesi ve piyasa yapısı dönüşü görüldü; FVG retest ve kapanış teyidi bekleniyor.",
    S02_BREAKER_RETEST:"Breaker bölgesi yeniden test ediliyor; kapanış teyidi bekleniyor.",
    S03_BOS_DISPLACEMENT:"Kapanışla BOS ve displacement tespit edildi; takip mumunda teyit bekleniyor.",
    S04_RANGE_DEVIATION:"Range dışı likidite alımı ve aralığa dönüş görüldü; retest bekleniyor.",
    S05_FAILED_BREAKOUT:"Başarısız kırılım ve ters yön teyidi görüldü; retest bekleniyor.",
    S06_OB_REACTION:"Order Block bölgesinde fiyat tepkisi tespit edildi; kapanış teyidi bekleniyor.",
    W01_HTF_OB_REVERSAL:"Üst zaman dilimi Order Block bölgesinde dönüş adayı; retest bekleniyor.",
    W02_SUPPLY_DEMAND_REVERSAL:"Üst zaman dilimi arz/talep bölgesinde tepki adayı; retest bekleniyor.",
    W03_SWEEP_CHOCH:"Üst zaman dilimi likidite süpürmesi ve CHoCH adayı; giriş teyidi bekleniyor.",
    W04_BREAKER_RETEST:"Üst zaman dilimi Breaker retest adayı; kapanış teyidi bekleniyor.",
    W05_RANGE_DEVIATION:"Üst zaman dilimi range deviation adayı; retest bekleniyor.",
    W06_CRT:"CRT sweep ve re-entry adayı; kapanış teyidi bekleniyor.",
    W07_OTE:"OTE geri çekilme bölgesi içinde; giriş teyidi bekleniyor.",
    W08_BOS_CONTINUATION:"Üst zaman dilimi BOS devam adayı; kapanış teyidi bekleniyor."
  };
  return {id:candidate.id,symbol:candidate.symbol,side:candidate.direction==="BULLISH"?"LONG":"SHORT",tradeStyle:candidate.engine.toUpperCase(),model:candidate.setupId,status:"WAIT",score:candidate.score,confidence:null,confidenceStatus:candidate.confidence,entry:candidate.entry,takeProfit:candidate.target,stopLoss:candidate.stop,currentPrice:null,markPrice:null,setupReason:setupReasons[candidate.setupId]??"Fiyat hareketi adayı; giriş teyidi bekleniyor.",reasonTr:setupReasons[candidate.setupId]??"Fiyat hareketi adayı; giriş teyidi bekleniyor.",entryEligible:false,entryConfirmation:candidate.entryConfirmation,evidence:candidate.evidence,createdAt:candidate.createdAt};
}
export function buildLegacyDashboardPayload({paperStatus={},analytics={},scalpCandidates=[],swingCandidates=[],systemHealth={},archiveHealth={},historyHealth={},cloudflareUsage={},tickerData={},universeData={},globalContext={}}={}){
  const candidates=[...scalpCandidates,...swingCandidates].map(toLegacyDashboardCandidate);
  return {health:{...paperStatus,setups:candidates,scalpCandidates:scalpCandidates.map(toLegacyDashboardCandidate),swingCandidates:swingCandidates.map(toLegacyDashboardCandidate),scalpCandidateCount:scalpCandidates.length,swingCandidateCount:swingCandidates.length},systemHealth,analytics,archiveHealth,historyHealth,cloudflareUsage,tickerData,universeData,globalContext};
}
