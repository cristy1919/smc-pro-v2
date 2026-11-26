import { DASHBOARD_TABS } from "./config.js";
const openPositions = positions => positions.filter(p => p.status === "OPEN" || p.state === "OPEN");
const validSetup = c => c?.engine === "swing" && ["4h","1d"].includes(String(c.setupTimeframe ?? c.timeframe ?? "").toLowerCase());
const conciseReason = value => String(value ?? "Açılış gerekçesi mevcut değil").replace(/\s*[:|·].*$/, "").trim();
const normalizeCandidate = c => ({
 id:c.id,symbol:c.symbol,side:c.side ?? (c.direction==="BULLISH"?"LONG":"SHORT"),engine:"swing",
 setupId:c.setupId ?? c.model,status:c.status ?? (c.entryEligible?"READY":"WAIT"),
 currentPrice:c.currentPrice ?? c.markPrice ?? null,score:c.score ?? null,
 confidence:c.confidence ?? c.confidenceStatus ?? "Veri yetersiz",
 entry:c.entry ?? c.entryPrice ?? null,tp:c.tp ?? c.takeProfit ?? c.target ?? null,
 sl:c.sl ?? c.stopLoss ?? c.stop ?? null,reasonTr:conciseReason(c.reasonTr ?? c.openReasonTr ?? c.setupReason),
 setupTimeframe:c.setupTimeframe ?? c.timeframe ?? null,entryTimeframe:c.entryTimeframe ?? null,
 structure:c.structure ?? c.structureType ?? null,createdAt:c.createdAt ?? null
});
export function buildDashboardSnapshot({market={},positions=[],swingCandidates=[],pendingSetups=[],statistics={},diagnostics={},cloudflareUsage={},scanHealth={},runner={},historical={},tickerData={},globalContext={}}={}) {
 const open=openPositions(positions),swing=swingCandidates.filter(validSetup),pending=pendingSetups.filter(validSetup);
 return {
  generatedAt:Date.now(),tabs:[...DASHBOARD_TABS],
  marketOverview:{market,cloudflareUsage,scanHealth,globalContext,tickerData,runner:{lastScannedAt:runner.lastScannedAt??null,lastScannedSymbol:runner.lastScannedSymbol??null,status:runner.status??"UNKNOWN"},historical:{lastArchivedAt:historical.lastArchivedAt??null,lastArchivedSymbol:historical.lastArchivedSymbol??null,status:historical.status??"UNKNOWN"}},
  counters:{openPositions:open.length,swingPositions:open.filter(p=>String(p.engine??p.tradeStyle).toLowerCase()==="swing").length,swingCandidates:swing.length},
  engines:{swing:{status:diagnostics.swingStatus??"UNKNOWN"}},
  openPositions:open.map(p=>({id:p.id,symbol:p.symbol,side:p.side,livePrice:p.livePrice,entry:p.entry,tp:p.tp??p.target,sl:p.sl??p.stop,reasonTr:conciseReason(p.openReasonTr??p.reasonTr??p.reason),reason:conciseReason(p.openReasonTr??p.reasonTr??p.reason),engine:p.engine??String(p.tradeStyle??"").toLowerCase(),setupId:p.setupId??p.model,setupTimeframe:p.setupTimeframe??p.timeframe,entryTimeframe:p.entryTimeframe,structure:p.structure??p.structureType,openedAt:p.openedAt,unrealizedPnl:p.unrealizedPnl,stopDistancePct:p.stopDistancePct,tpDistancePct:p.tpDistancePct})),
  scanner:{swing:swing.map(normalizeCandidate)},
  pendingSetups:[...new Map(pending.map((item,index)=>[item.id??`${item.symbol??"setup"}:${item.setupId??item.model??index}`,item])).values()].map(normalizeCandidate).filter(c=>c.status==="WAIT"||c.status==="PENDING"),
  candidates:swing.map(normalizeCandidate).filter(c=>["READY","QUALIFIED","HIGH_QUALITY"].includes(c.status)),
  statistics:{...statistics,calendar:statistics.calendar??[]},
  diagnostics:{...diagnostics,scalpStatus:"REMOVED",modelChecks:(diagnostics.modelChecks??[]).filter(x=>(x.setupCount??x.count??0)>0&&String(x.timeframe??x.setupTimeframe??"").match(/^(4h|1d)$/i))}
 };
}
export function createDashboardActions({closePosition,openChart}={}) {
 return Object.freeze({
  async close({positionId,closePercent=100}) {if(typeof closePosition!=="function")throw new Error("POSITION_CLOSE_ACTION_NOT_CONNECTED");if(typeof positionId!=="string"||!positionId)throw new TypeError("positionId is required");if(!Number.isFinite(closePercent)||closePercent<=0||closePercent>100)throw new RangeError("closePercent must be between 0 and 100");return closePosition({positionId,closePercent});},
  chart(symbol){if(typeof openChart!=="function")throw new Error("CHART_ACTION_NOT_CONNECTED");if(typeof symbol!=="string"||!symbol)throw new TypeError("symbol is required");return openChart(symbol);}
 });
}
export function toLegacyDashboardCandidate(candidate) {
 const reasons={W01_HTF_OB_REVERSAL:"Günlük/4 saatlik emir bloğunda yapısal dönüş.",W02_SUPPLY_DEMAND_REVERSAL:"Üst zaman dilimi arz/talep bölgesinde tepki.",W03_SWEEP_CHOCH:"Likidite süpürmesi ve karakter değişimi.",W04_BREAKER_RETEST:"Kırılan emir bloğunun breaker olarak yeniden testi.",W05_RANGE_DEVIATION:"Doğrulanmış yatay aralıkta deviation ve geri giriş.",W06_CRT:"Üst zaman dilimi CRT likidite süpürmesi ve geri alım.",W07_OTE:"Üst zaman dilimi OTE geri çekilmesi.",W08_BOS_CONTINUATION:"Displacement eşliğinde onaylı yapı kırılımı."};
 const reason=reasons[candidate.setupId]??candidate.reasonTr??"Fiyat yapısı işlem adayı oluşturdu.";
 return {id:candidate.id,symbol:candidate.symbol,side:candidate.direction==="BULLISH"?"LONG":"SHORT",engine:"swing",model:candidate.setupId,status:candidate.status??(candidate.entryEligible?"READY":"WAIT"),score:candidate.score,confidence:candidate.confidence??candidate.confidenceStatus??"Veri yetersiz",entry:candidate.entry,takeProfit:candidate.target,stopLoss:candidate.stop,currentPrice:candidate.currentPrice??null,setupReason:reason,reasonTr:reason,entryEligible:candidate.entryEligible===true,setupTimeframe:candidate.setupTimeframe??candidate.timeframe??null,entryTimeframe:candidate.entryTimeframe??null,structure:candidate.structure??candidate.structureType??null,evidence:candidate.evidence,createdAt:candidate.createdAt};
}
export function buildLegacyDashboardPayload({paperStatus={},analytics={},swingCandidates=[],systemHealth={},archiveHealth={},historyHealth={},cloudflareUsage={},tickerData={},universeData={},globalContext={}}={}) {
 const swing=swingCandidates.filter(validSetup).map(toLegacyDashboardCandidate);
 return {health:{...paperStatus,setups:swing,swingCandidates:swing,swingCandidateCount:swing.length,scalpCandidates:[],scalpCandidateCount:0},systemHealth,analytics,archiveHealth,historyHealth,cloudflareUsage,tickerData,universeData,globalContext};
}
