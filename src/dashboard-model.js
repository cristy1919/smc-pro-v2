import { DASHBOARD_TABS } from "./config.js";

const openPositions = positions => positions.filter(p => p.status === "OPEN" || p.state === "OPEN");
const conciseReason = value => String(value ?? "Açılış gerekçesi mevcut değil").replace(/\s*[:|·].*$/, "").trim();
const normalizeCandidate = c => ({
  id:c.id,symbol:c.symbol,side:c.side ?? (c.direction==="BULLISH"?"LONG":"SHORT"),
  engine:c.engine,setupId:c.setupId ?? c.model,status:c.status ?? (c.entryEligible?"READY":"WAIT"),
  currentPrice:c.currentPrice ?? c.markPrice ?? null,score:c.score ?? null,
  confidence:c.confidence ?? c.confidenceStatus ?? "Veri yetersiz",
  entry:c.entry ?? c.entryPrice ?? null,tp:c.tp ?? c.takeProfit ?? c.target ?? null,
  sl:c.sl ?? c.stopLoss ?? c.stop ?? null,
  reasonTr:conciseReason(c.reasonTr ?? c.openReasonTr ?? c.setupReason),
  setupTimeframe:c.setupTimeframe ?? c.timeframe ?? null,
  entryTimeframe:c.entryTimeframe ?? null,
  structure:c.structure ?? c.structureType ?? null,
  createdAt:c.createdAt ?? null
});

export function buildDashboardSnapshot({market={},positions=[],scalpCandidates=[],swingCandidates=[],pendingSetups=[],statistics={},diagnostics={},cloudflareUsage={},scanHealth={},runner={},historical={},tickerData={},globalContext={}}={}) {
  const open=openPositions(positions);
    return {
    generatedAt:Date.now(),
    tabs:[...DASHBOARD_TABS],
    marketOverview:{market,cloudflareUsage,scanHealth,globalContext,tickerData,
      runner:{lastScannedAt:runner.lastScannedAt??null,lastScannedSymbol:runner.lastScannedSymbol??null,status:runner.status??"UNKNOWN"},
      historical:{lastArchivedAt:historical.lastArchivedAt??null,lastArchivedSymbol:historical.lastArchivedSymbol??null,status:historical.status??"UNKNOWN"}},
    counters:{openPositions:open.length,scalpPositions:open.filter(p=>p.engine==="scalp").length,swingPositions:open.filter(p=>p.engine==="swing").length,scalpCandidates:scalpCandidates.length,swingCandidates:swingCandidates.length},
    engines:{scalp:{status:diagnostics.scalpStatus??"UNKNOWN"},swing:{status:diagnostics.swingStatus??"UNKNOWN"}},
    openPositions:open.map(p=>({id:p.id,symbol:p.symbol,side:p.side,livePrice:p.livePrice,entry:p.entry,tp:p.tp??p.target,sl:p.sl??p.stop,reasonTr:conciseReason(p.openReasonTr??p.reasonTr??p.reason),engine:p.engine,setupId:p.setupId??p.model,setupTimeframe:p.setupTimeframe??p.timeframe,entryTimeframe:p.entryTimeframe,structure:p.structure??p.structureType,openedAt:p.openedAt,unrealizedPnl:p.unrealizedPnl,stopDistancePct:p.stopDistancePct,tpDistancePct:p.tpDistancePct})),
    scanner:{scalp:scalpCandidates.map(normalizeCandidate),swing:swingCandidates.map(normalizeCandidate)},
    pendingSetups:pendingSetups.map(normalizeCandidate).filter(c=>c.status==="WAIT"||c.status==="PENDING"),
    candidates:[...scalpCandidates,...swingCandidates].map(normalizeCandidate).filter(c=>c.status==="READY"||c.status==="QUALIFIED"||c.status==="HIGH_QUALITY"),
    statistics:{...statistics,calendar:statistics.calendar??[]},
    diagnostics:{...diagnostics,modelChecks:(diagnostics.modelChecks??[]).filter(x=>(x.setupCount??x.count??0)>0)}
  };
}

export function createDashboardActions({closePosition,openChart}={}) {
  return Object.freeze({
    async close({positionId,closePercent=100}) {
      if(typeof closePosition!=="function")throw new Error("POSITION_CLOSE_ACTION_NOT_CONNECTED");
      if(typeof positionId!=="string"||!positionId)throw new TypeError("positionId is required");
      if(!Number.isFinite(closePercent)||closePercent<=0||closePercent>100)throw new RangeError("closePercent must be between 0 and 100");
      return closePosition({positionId,closePercent});
    },
    chart(symbol){if(typeof openChart!=="function")throw new Error("CHART_ACTION_NOT_CONNECTED");if(typeof symbol!=="string"||!symbol)throw new TypeError("symbol is required");return openChart(symbol);}
  });
}

export function toLegacyDashboardCandidate(candidate) {
  const setupReasons={
    S01_SWEEP_MSS_FVG:"Likidite süpürmesi gerçekleşti; piyasa yapısı dönüşü ve FVG oluşumu görüldü.",
    S02_BREAKER_RETEST:"Kırılan emir bloğu yeniden test edildi.",
    S03_BOS_DISPLACEMENT:"Önemli tepe/dip kırıldı ve güçlü fiyat hareketi geldi.",
    S04_RANGE_DEVIATION:"Fiyat aralık dışındaki likiditeyi alıp aralığa geri döndü.",
    S05_FAILED_BREAKOUT:"Kırılım başarısız oldu; fiyat ters yöne döndü.",
    S06_OB_REACTION:"Emir bloğunda belirgin fiyat tepkisi oluştu.",
    W01_HTF_OB_REVERSAL:"Günlük/4 saatlik emir bloğunda dönüş sinyali oluştu.",
    W02_SUPPLY_DEMAND_REVERSAL:"Üst zaman dilimi arz/talep bölgesinde dönüş tepkisi oluştu.",
    W03_SWEEP_CHOCH:"Likidite alındı ve piyasa yapısı yön değiştirdi.",
    W04_BREAKER_RETEST:"Üst zaman dilimindeki kırıcı bölge yeniden test edildi.",
    W05_RANGE_DEVIATION:"Üst zaman dilimi fiyat aralığının dışına çıkıp geri döndü.",
    W06_CRT:"Günlük aralık likiditesi alındı ve fiyat aralığa döndü.",
    W07_OTE:"Fiyat Fibonacci geri çekilme bölgesine ulaştı.",
    W08_BOS_CONTINUATION:"Üst zaman dilimindeki yapı kırılımı aynı yönde devam etti."
  };
  const reason=setupReasons[candidate.setupId]??candidate.reasonTr??"Fiyat yapısı işlem adayı oluşturdu.";
  return {id:candidate.id,symbol:candidate.symbol,side:candidate.direction==="BULLISH"?"LONG":"SHORT",engine:candidate.engine,model:candidate.setupId,status:candidate.status??(candidate.entryEligible?"READY":"WAIT"),score:candidate.score,confidence:candidate.confidence??candidate.confidenceStatus??"Veri yetersiz",entry:candidate.entry,takeProfit:candidate.target,stopLoss:candidate.stop,currentPrice:candidate.currentPrice??null,setupReason:reason,reasonTr:reason,entryEligible:candidate.entryEligible===true,setupTimeframe:candidate.setupTimeframe??candidate.timeframe??null,entryTimeframe:candidate.entryTimeframe??null,structure:candidate.structure??candidate.structureType??null,evidence:candidate.evidence,createdAt:candidate.createdAt};
}


export function buildLegacyDashboardPayload({paperStatus={},analytics={},scalpCandidates=[],swingCandidates=[],systemHealth={},archiveHealth={},historyHealth={},cloudflareUsage={},tickerData={},universeData={},globalContext={}}={}) {
  const scalp=scalpCandidates.map(toLegacyDashboardCandidate);
  const swing=swingCandidates.map(toLegacyDashboardCandidate);
  const setups=[...scalp,...swing];
  return {
    health:{...paperStatus,setups,scalpCandidates:scalp,swingCandidates:swing,scalpCandidateCount:scalp.length,swingCandidateCount:swing.length},
    systemHealth,analytics,archiveHealth,historyHealth,cloudflareUsage,tickerData,universeData,globalContext
  };
}
