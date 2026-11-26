import { writeFile } from "node:fs/promises";
import { BingXPublicKlineProvider, fetchEngineDataset, INTERVAL_MS } from "../src/bingx-market-data.js";
import { evaluateSwing } from "../src/setup-evaluator.js";
import { runHistoricalBacktest } from "../src/multi-timeframe-backtest.js";
import { RISK_CONFIG } from "../src/config.js";
import { selectCryptoPerpetualUniverse } from "../src/backtest-universe.js";

const BASE_URL = "https://open-api.bingx.com";
const DAY = 86400000;
const TARGET_SYMBOLS = 50;
const WINDOW_DAYS = 90;
const SEGMENT_DAYS = 30;
const ENTRY_TFS = ["15m", "1h"];
const FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0002;

async function publicData(path) {
  const response = await fetch(new URL(path, BASE_URL));
  if (!response.ok) throw new Error("BINGX_HTTP_" + response.status + "_" + path);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error("BINGX_API_" + payload.code + ":" + (payload.msg || path));
  return payload.data;
}

async function selectTopSymbols() {
  const [contracts, tickers] = await Promise.all([
    publicData("/openApi/swap/v2/quote/contracts"),
    publicData("/openApi/swap/v2/quote/ticker")
  ]);
  return selectCryptoPerpetualUniverse(contracts, tickers, TARGET_SYMBOLS);
}

function pf(trades) {
  const wins = trades.filter(t => t.netR > 0).reduce((s, t) => s + t.netR, 0);
  const losses = Math.abs(trades.filter(t => t.netR <= 0).reduce((s, t) => s + t.netR, 0));
  return losses ? wins / losses : wins ? null : 0;
}
function metrics(trades) {
  const wins = trades.filter(t => t.netR > 0);
  const losses = trades.filter(t => t.netR <= 0);
  const totalR = trades.reduce((s, t) => s + t.netR, 0);
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const t of [...trades].sort((a, b) => a.entryAt - b.entryAt)) {
    equity *= 1 + t.netR * RISK_CONFIG.riskUnitFraction;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: pf(trades), totalR, expectancyR: trades.length ? totalR / trades.length : 0,
    maxDrawdownPct: maxDrawdown * 100,
    averageMAER: trades.length ? trades.reduce((s, t) => s + t.maeR, 0) / trades.length : 0,
    averageMFER: trades.length ? trades.reduce((s, t) => s + t.mfeR, 0) / trades.length : 0,
    totalEstimatedCostR: trades.reduce((s, t) => s + t.estimatedCostR, 0),
    confidence: trades.length < 30 ? "INSUFFICIENT_DATA" : "SAMPLE_AVAILABLE"
  };
}
function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, ...metrics(rows) }))
    .sort((a, b) => b.totalR - a.totalR);
}
function evidenceValue(trade, prefix) {
  return (trade.evidence || []).find(x => x.startsWith(prefix)) || prefix + "UNKNOWN";
}
function lossDiagnosis(trades) {
  const losing = trades.filter(t => t.netR <= 0);
  return {
    byExitReason: groupBy(losing, t => t.exitReason),
    bySetup: groupBy(losing, t => t.setupId),
    byDirection: groupBy(losing, t => t.direction),
    byHTFBias: groupBy(losing, t => evidenceValue(t, "HTF_")),
    byStructureContext: groupBy(losing, t => evidenceValue(t, "STRUCTURE_")),
    byZone: groupBy(losing, t => t.zoneBounds?.type || "NO_ZONE"),
    byScoreBand: groupBy(losing, t => t.score >= 90 ? "90-100" : t.score >= 85 ? "85-89" : "80-84"),
    byEntryTimeframe: groupBy(losing, t => t.timeframe),
    highCostLosses: losing.filter(t => t.estimatedCostR >= Math.abs(t.grossR) * 0.5)
      .map(t => ({ symbol: t.symbol, setupId: t.setupId, timeframe: t.timeframe, grossR: t.grossR, costR: t.estimatedCostR, netR: t.netR })),
    adverseExcursionLosses: losing.filter(t => t.maeR >= 0.8)
      .map(t => ({ symbol: t.symbol, setupId: t.setupId, timeframe: t.timeframe, maeR: t.maeR, mfeR: t.mfeR, netR: t.netR }))
  };
}
function learnRules(completedTrades, priorRules, learnedAfterSegment) {
  const rules = [...priorRules];
  const bySetupDirection = groupBy(completedTrades, t => t.timeframe + "|" + t.setupId + "|" + t.direction);
  for (const row of bySetupDirection) {
    const rows = completedTrades.filter(t => t.timeframe + "|" + t.setupId + "|" + t.direction === row.key);
    if (rows.length >= 5 && row.profitFactor !== null && row.profitFactor < 0.35 && row.expectancyR < 0) {
      const [timeframe, setupId, direction] = row.key.split("|");
      const rule = {
        id: "BLOCK_SETUP_DIRECTION:" + row.key,
        type: "SETUP_DIRECTION",
        timeframe, setupId, direction,
        learnedAfterSegment,
        sampleSize: rows.length, profitFactor: row.profitFactor, expectancyR: row.expectancyR,
        reason: "Önceki dönemde en az 5 işlem, PF < 0.35 ve negatif beklenti"
      };
      if (!rules.some(x => x.id === rule.id)) rules.push(rule);
    }
  }
  const bySetupBias = groupBy(completedTrades, t => [t.timeframe, t.setupId, t.direction, evidenceValue(t, "HTF_")].join("|"));
  for (const row of bySetupBias) {
    const rows = completedTrades.filter(t => [t.timeframe, t.setupId, t.direction, evidenceValue(t, "HTF_")].join("|") === row.key);
    if (rows.length >= 3 && row.profitFactor !== null && row.profitFactor < 0.5 && row.expectancyR < 0) {
      const [timeframe, setupId, direction, htfBias] = row.key.split("|");
      const rule = {
        id: "BLOCK_SETUP_DIRECTION_HTF:" + row.key,
        type: "SETUP_DIRECTION_HTF",
        timeframe, setupId, direction, htfBias,
        learnedAfterSegment,
        sampleSize: rows.length, profitFactor: row.profitFactor, expectancyR: row.expectancyR,
        reason: "Önceki dönemde aynı HTF bağlamında en az 3 işlem, PF < 0.50 ve negatif beklenti"
      };
      if (!rules.some(x => x.id === rule.id)) rules.push(rule);
    }
  }
  return rules;
}
function candidateAllowed(candidate, rules) {
  const htfBias = (candidate.evidence || []).find(x => x.startsWith("HTF_")) || "HTF_UNKNOWN";
  return !rules.some(rule =>
    rule.timeframe === candidate.timeframe &&
    rule.setupId === candidate.setupId &&
    rule.direction === candidate.direction &&
    (rule.type === "SETUP_DIRECTION" ||
      (rule.type === "SETUP_DIRECTION_HTF" && rule.htfBias === htfBias))
  );
}
function candleSlice(timeframes, endTime) {
  return Object.fromEntries(Object.entries(timeframes).map(([tf, rows]) => [
    tf, rows.filter(c => c.timestamp + INTERVAL_MS[tf] <= endTime)
  ]));
}
function combineReports(reports, key) {
  return reports.flatMap(r => r[key] || []);
}

const endTime = Date.now();
const startTime = endTime - WINDOW_DAYS * DAY;
const provider = new BingXPublicKlineProvider({ minRequestIntervalMs: 1050 });
const universe = await selectTopSymbols();
if (universe.length < TARGET_SYMBOLS) {
  throw new Error("INSUFFICIENT_LIQUID_USDT_PERPETUALS: expected at least " + TARGET_SYMBOLS + ", found " + universe.length);
}
const selectedPairs = universe.slice(0, TARGET_SYMBOLS);
const datasets = new Map();
const pairFailures = [];
for (let i = 0; i < selectedPairs.length; i++) {
  const pair = selectedPairs[i];
  process.stdout.write("FETCH " + (i + 1) + "/" + TARGET_SYMBOLS + " " + pair.symbol + "\n");
  try {
    const timeframes = await fetchEngineDataset({ provider, symbol: pair.symbol, engine: "swing", startTime, endTime });
    const fundingRates = await provider.getFundingRates({ symbol: pair.symbol, startTime, endTime, limit: 100 });
    if (!fundingRates.length) throw new Error("PUBLIC_HISTORICAL_FUNDING_DATA_MISSING");
    datasets.set(pair.symbol, { pair, timeframes, fundingRates });
  } catch (error) {
    pairFailures.push({ symbol: pair.symbol, stage: "DATA_FETCH", error: String(error?.message || error) });
  }
}
if (datasets.size !== TARGET_SYMBOLS) {
  throw new Error("DATASET_COLLECTION_INCOMPLETE: " + datasets.size + "/" + TARGET_SYMBOLS + " complete. Failures: " + JSON.stringify(pairFailures));
}

const segments = [];
let learnedRules = [];
for (let segmentIndex = 0; segmentIndex < 3; segmentIndex++) {
  const segmentStart = startTime + segmentIndex * SEGMENT_DAYS * DAY;
  const segmentEnd = segmentStart + SEGMENT_DAYS * DAY;
  const segmentTrades = { "15m": [], "1h": [] };
  const perPair = [];
  process.stdout.write("SEGMENT " + (segmentIndex + 1) + "/3 start; activeRules=" + learnedRules.length + "\n");
  for (const [symbol, data] of datasets) {
    const sliced = candleSlice(data.timeframes, segmentEnd);
    const pairRow = { symbol, entry15m: null, entry1h: null };
    for (const entryTimeframe of ENTRY_TFS) {
      const report = runHistoricalBacktest({
        engine: "swing", symbol, timeframes: sliced, evaluate: evaluateSwing,
        periodDays: [30], feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE,
        fundingRates: data.fundingRates, entryTimeframe,
        startTime: segmentStart, endTime: segmentEnd,
        candidateFilter: candidate => candidateAllowed(candidate, learnedRules)
      });
      const trades = report.tradesByPeriod[30].map(t => ({ ...t, symbol }));
      segmentTrades[entryTimeframe].push(...trades);
      pairRow[entryTimeframe === "15m" ? "entry15m" : "entry1h"] = {
        ...report.periods[0], diagnostics: lossDiagnosis(trades), trades
      };
    }
    perPair.push(pairRow);
    process.stdout.write("SEGMENT " + (segmentIndex + 1) + " " + symbol + " complete\n");
  }
  const allSegmentTrades = [...segmentTrades["15m"], ...segmentTrades["1h"]];
  const segmentReport = {
    segment: segmentIndex + 1,
    start: new Date(segmentStart).toISOString(),
    end: new Date(segmentEnd).toISOString(),
    appliedLearningRules: [...learnedRules],
    entry15m: { metrics: metrics(segmentTrades["15m"]), setupBreakdown: groupBy(segmentTrades["15m"], t => t.setupId), directionBreakdown: groupBy(segmentTrades["15m"], t => t.direction), lossDiagnosis: lossDiagnosis(segmentTrades["15m"]), trades: segmentTrades["15m"] },
    entry1h: { metrics: metrics(segmentTrades["1h"]), setupBreakdown: groupBy(segmentTrades["1h"], t => t.setupId), directionBreakdown: groupBy(segmentTrades["1h"], t => t.direction), lossDiagnosis: lossDiagnosis(segmentTrades["1h"]), trades: segmentTrades["1h"] },
    entryTimeframeComparison: { "15m": metrics(segmentTrades["15m"]), "1h": metrics(segmentTrades["1h"]) },
    pairs: perPair,
    learning: { rulesLearnedFromThisSegment: [], ruleMethod: "Only rules supported by repeated negative out-of-sample outcomes are applied to the NEXT 30-day segment; no same-segment filtering." }
  };
  const nextRules = learnRules([...segmentTrades["15m"], ...segmentTrades["1h"]], learnedRules, segmentIndex + 1);
  segmentReport.learning.rulesLearnedFromThisSegment = nextRules.filter(r => !learnedRules.some(old => old.id === r.id));
  segments.push(segmentReport);
  learnedRules = nextRules;
  process.stdout.write("SEGMENT " + (segmentIndex + 1) + " complete; newRules=" + segmentReport.learning.rulesLearnedFromThisSegment.length + "\n");
}

const all15m = combineReports(segments, "entry15m");
const all1h = combineReports(segments, "entry1h");

const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    exchange: "BingX USDT-M perpetuals",
    engine: "SWING_ONLY_WALK_FORWARD_LEARNING",
    requestedPairs: TARGET_SYMBOLS, completedPairs: datasets.size,
    dataWindowDays: WINDOW_DAYS, segments: 3, segmentDays: SEGMENT_DAYS,
    symbolSelection: "BTC-USDT mandatory plus top 49 crypto-asset USDT perpetuals by 24h quoteVolume; excludes TradFi, indices, stocks, commodities, forex, gold and synthetic reference symbols; active/open and observed spread <= 0.5%.",
    timeframes: { bias: "1d", structuralZones: "4h", confirmation: "1h", entryComparisons: ["15m", "1h"] },
    costs: { feeRatePerSide: FEE_RATE, slippageRatePerSide: SLIPPAGE_RATE, maxCostToRisk: 0.20, minimumStopDistancePct: 0.007 },
    riskUnitFraction: RISK_CONFIG.riskUnitFraction,
    learningPolicy: "Strict chronological walk-forward: segment 1 diagnoses; its learned filters apply to segment 2; cumulative segment 1+2 learning applies to segment 3. No same-segment learning or future leakage.",
    learningThresholds: {
      setupDirection: "At least 5 trades, PF < 0.35, negative expectancy",
      setupDirectionAndHtf: "At least 3 trades, PF < 0.50, negative expectancy"
    },
    limitations: [
      "Only public BingX market data; no private account data or orders",
      "Each 30-day segment is isolated; open trades are force-closed at the segment boundary",
      "The 15m and 1h entry comparisons are separate simulations and must not be added as if they were one portfolio",
      "No historical leverage/liquidation, depth, spread evolution or market-impact simulation",
      "50% partial close at +1R; remaining 50% stop moves to breakeven; final target +3.5R",
      "Trades rejected when stop distance <0.70% or estimated round-trip fee/slippage exceeds 20% of initial risk",
      "Historical spread/depth/market impact cannot be reconstructed from OHLCV; current spread is used only for universe screening",
      "Historical leverage and liquidation are not simulated because historical maintenance-margin tiers are unavailable",
      "30-day segment boundary force-closes open positions; boundary exits are explicitly tagged",
      "Stop-first assumption if stop and target are touched in the same candle",
      "Funding applied only from returned historical settlement records",
      "Normalized R and equity metrics are not actual VST or USDT returns"
    ]
  },
  universe: selectedPairs.map(x => ({ symbol: x.symbol, quoteVolume24h: x.quoteVolume, observedSpreadPct: x.spreadPct })),
  dataFailures: pairFailures,
  segments,
  total90d: {
    entry15m: { metrics: metrics(all15m.flatMap(x => x.trades)), setupBreakdown: groupBy(all15m.flatMap(x => x.trades), t => t.setupId), lossDiagnosis: lossDiagnosis(all15m.flatMap(x => x.trades)), trades: all15m.flatMap(x => x.trades) },
    entry1h: { metrics: metrics(all1h.flatMap(x => x.trades)), setupBreakdown: groupBy(all1h.flatMap(x => x.trades), t => t.setupId), lossDiagnosis: lossDiagnosis(all1h.flatMap(x => x.trades)), trades: all1h.flatMap(x => x.trades) },
    entryTimeframeComparison: { "15m": metrics(all15m.flatMap(x => x.trades)), "1h": metrics(all1h.flatMap(x => x.trades)) }
  },
  finalLearnedRules: learnedRules
};
await writeFile("swing-50-pairs-90d-walk-forward-report.json", JSON.stringify(output, null, 2) + "\n", { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  completedPairs: datasets.size,
  segments: segments.map(s => ({ segment: s.segment, entry15m: s.entry15m.metrics, entry1h: s.entry1h.metrics, rulesLearned: s.learning.rulesLearnedFromThisSegment.length })),
  total90d: { entry15m: output.total90d.entry15m.metrics, entry1h: output.total90d.entry1h.metrics },
  finalLearnedRules: learnedRules.length
}, null, 2) + "\n");
