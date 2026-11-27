import { DASHBOARD_TABS } from "./config.js";
const openPositions = positions => positions.filter(p => p.status === "OPEN" || p.state === "OPEN");
const timeframeOf = c => String(c.setupTimeframe ?? c.timeframe ?? "").toLowerCase();
const engineOf = c => String(c?.engine ?? "swing").toLowerCase();
const validSetup = c => engineOf(c) === "scalp"
  ? timeframeOf(c) === "5m"
  : engineOf(c) === "swing" && ["15m", "1h"].includes(timeframeOf(c));
const conciseReason = value => String(value ?? "Açılış gerekçesi mevcut değil").replace(/\s*[:|·].*$/, "").trim();
const normalizeCandidate = c => ({
  id: c.id, symbol: c.symbol, side: c.side ?? (c.direction === "BULLISH" ? "LONG" : "SHORT"),
  engine: engineOf(c), setupId: c.setupId ?? c.model,
  status: c.status ?? c.state ?? (c.entryEligible ? "READY" : "WAIT"),
  currentPrice: c.currentPrice ?? c.markPrice ?? null, score: c.score ?? null,
  confidence: c.confidence ?? c.confidenceStatus ?? "Veri yetersiz",
  entry: c.entry ?? c.entryPrice ?? null, tp: c.tp ?? c.takeProfit ?? c.target ?? null,
  sl: c.sl ?? c.stopLoss ?? c.stop ?? null,
  reasonTr: conciseReason(c.reasonTr ?? c.openReasonTr ?? c.setupReason ?? c.reason),
  setupTimeframe: c.setupTimeframe ?? c.timeframe ?? null, entryTimeframe: c.entryTimeframe ?? null,
  structure: c.structure ?? c.structureType ?? null, createdAt: c.createdAt ?? null
});
const isWaiting = c => ["WAIT", "PENDING", "ENTRY_PENDING"].includes(String(c.status ?? "").toUpperCase());
const isCandidate = c => ["READY", "QUALIFIED", "HIGH_QUALITY"].includes(String(c.status ?? "").toUpperCase());
const uniqueById = rows => [...new Map(rows.map((item, index) => [item.id ?? `${item.symbol ?? "setup"}:${item.setupId ?? item.model ?? index}`, item])).values()];

export function buildDashboardSnapshot({
  market = {}, positions = [], scalpCandidates = [], swingCandidates = [], pendingSetups = [],
  statistics = {}, diagnostics = {}, cloudflareUsage = {}, scanHealth = {}, runner = {},
  historical = {}, tickerData = {}, globalContext = {}
} = {}) {
  const open = openPositions(positions);
  const scalp = scalpCandidates.filter(c => engineOf(c) === "scalp" && validSetup(c));
  const swing = swingCandidates.filter(c => engineOf(c) === "swing" && validSetup(c));
  const all = [...scalp, ...swing];
  const pending = uniqueById([...pendingSetups, ...all.filter(isWaiting)]).filter(validSetup).filter(isWaiting);
  const ready = uniqueById(all.filter(isCandidate));
  return {
    generatedAt: Date.now(), tabs: [...DASHBOARD_TABS],
    marketOverview: {
      market, cloudflareUsage, scanHealth, globalContext, tickerData,
      runner: { lastScannedAt: runner.lastScannedAt ?? null, lastScannedSymbol: runner.lastScannedSymbol ?? null, status: runner.status ?? "UNKNOWN" },
      historical: { lastArchivedAt: historical.lastArchivedAt ?? null, lastArchivedSymbol: historical.lastArchivedSymbol ?? null, status: historical.status ?? "UNKNOWN" }
    },
    counters: {
      openPositions: open.length,
      scalpPositions: open.filter(p => String(p.engine ?? p.tradeStyle).toLowerCase() === "scalp").length,
      swingPositions: open.filter(p => String(p.engine ?? p.tradeStyle).toLowerCase() === "swing").length,
      scalpCandidates: scalp.length, swingCandidates: swing.length,
      candidates: ready.length, pendingSetups: pending.length
    },
    engines: {
      scalp: { status: diagnostics.scalpStatus ?? "UNKNOWN" },
      swing: { status: diagnostics.swingStatus ?? "UNKNOWN" }
    },
    openPositions: open.map(p => ({
      id: p.id, symbol: p.symbol, side: p.side, livePrice: p.livePrice, entry: p.entry,
      tp: p.tp ?? p.target, sl: p.sl ?? p.stop,
      reasonTr: conciseReason(p.openReasonTr ?? p.reasonTr ?? p.reason),
      reason: conciseReason(p.openReasonTr ?? p.reasonTr ?? p.reason),
      engine: p.engine ?? String(p.tradeStyle ?? "").toLowerCase(), setupId: p.setupId ?? p.model,
      setupTimeframe: p.setupTimeframe ?? p.timeframe, entryTimeframe: p.entryTimeframe,
      structure: p.structure ?? p.structureType, openedAt: p.openedAt,
      unrealizedPnl: p.unrealizedPnl, stopDistancePct: p.stopDistancePct, tpDistancePct: p.tpDistancePct
    })),
    scanner: { scalp: scalp.map(normalizeCandidate), swing: swing.map(normalizeCandidate) },
    pendingSetups: pending.map(normalizeCandidate),
    candidates: ready.map(normalizeCandidate),
    statistics: { ...statistics, calendar: statistics.calendar ?? [] },
    diagnostics: { ...diagnostics, scalpStatus: diagnostics.scalpStatus ?? "UNKNOWN", swingStatus: diagnostics.swingStatus ?? "UNKNOWN" }
  };
}

export function createDashboardActions({ closePosition, openChart } = {}) {
  return Object.freeze({
    async close({ positionId, closePercent = 100 }) {
      if (typeof closePosition !== "function") throw new Error("POSITION_CLOSE_ACTION_NOT_CONNECTED");
      if (typeof positionId !== "string" || !positionId) throw new TypeError("positionId is required");
      if (!Number.isFinite(closePercent) || closePercent <= 0 || closePercent > 100) throw new RangeError("closePercent must be between 0 and 100");
      return closePosition({ positionId, closePercent });
    },
    chart(symbol) {
      if (typeof openChart !== "function") throw new Error("CHART_ACTION_NOT_CONNECTED");
      if (typeof symbol !== "string" || !symbol) throw new TypeError("symbol is required");
      return openChart(symbol);
    }
  });
}

const REASONS = {
  S01_SWEEP_MSS_FVG: "Likidite süpürmesi, MSS ve FVG retesti.",
  S02_BREAKER_RETEST: "Scalp breaker bölgesinin yeniden testi.",
  S03_BOS_DISPLACEMENT: "Displacement eşliğinde onaylı yapı kırılımı.",
  S04_RANGE_DEVIATION: "Yatay aralık deviation ve geri giriş.",
  S05_FAILED_BREAKOUT: "Başarısız kırılım ve likidite geri alımı.",
  S06_OB_REACTION: "Order Block bölgesinde fiyat tepkisi.",
  W01_HTF_OB_REVERSAL: "Günlük/4 saatlik emir bloğunda yapısal dönüş.",
  W02_SUPPLY_DEMAND_REVERSAL: "Üst zaman dilimi arz/talep bölgesinde tepki.",
  W03_SWEEP_CHOCH: "Likidite süpürmesi ve karakter değişimi.",
  W04_BREAKER_RETEST: "Kırılan emir bloğunun breaker olarak yeniden testi.",
  W05_RANGE_DEVIATION: "Doğrulanmış yatay aralıkta deviation ve geri giriş.",
  W06_CRT: "Üst zaman dilimi CRT likidite süpürmesi ve geri alım.",
  W07_OTE: "Üst zaman dilimi OTE geri çekilmesi.",
  W08_BOS_CONTINUATION: "Displacement eşliğinde onaylı yapı kırılımı."
};
export function toLegacyDashboardCandidate(candidate) {
  const engine = engineOf(candidate);
  const reason = REASONS[candidate.setupId] ?? candidate.reasonTr ?? "Fiyat yapısı işlem adayı oluşturdu.";
  return {
    id: candidate.id, symbol: candidate.symbol,
    side: candidate.direction === "BULLISH" ? "LONG" : "SHORT", engine,
    model: candidate.setupId, setupId: candidate.setupId,
    status: candidate.status ?? candidate.state ?? (candidate.entryEligible ? "READY" : "WAIT"),
    score: candidate.score, confidence: candidate.confidence ?? candidate.confidenceStatus ?? "Veri yetersiz",
    entry: candidate.entry, takeProfit: candidate.target ?? candidate.takeProfit, stopLoss: candidate.stop ?? candidate.stopLoss,
    currentPrice: candidate.currentPrice ?? null, setupReason: reason, reasonTr: reason,
    entryEligible: candidate.entryEligible === true, setupTimeframe: candidate.setupTimeframe ?? candidate.timeframe ?? null,
    entryTimeframe: candidate.entryTimeframe ?? null, structure: candidate.structure ?? candidate.structureType ?? null,
    evidence: candidate.evidence, createdAt: candidate.createdAt
  };
}
export function buildLegacyDashboardPayload({
  paperStatus = {}, analytics = {}, scalpCandidates = [], swingCandidates = [],
  systemHealth = {}, archiveHealth = {}, historyHealth = {}, cloudflareUsage = {},
  tickerData = {}, universeData = {}, globalContext = {}
} = {}) {
  const scalp = scalpCandidates.filter(validSetup).map(toLegacyDashboardCandidate);
  const swing = swingCandidates.filter(validSetup).map(toLegacyDashboardCandidate);
  return {
    health: {
      ...paperStatus,
      setups: [...scalp, ...swing], scalpCandidates: scalp, swingCandidates: swing,
      scalpCandidateCount: scalp.length, swingCandidateCount: swing.length
    },
    systemHealth, analytics, archiveHealth, historyHealth, cloudflareUsage, tickerData, universeData, globalContext
  };
}
