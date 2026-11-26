import { writeFile } from "node:fs/promises";
import { BingXPublicKlineProvider, fetchEngineDataset } from "../src/bingx-market-data.js";
import { evaluateSwing } from "../src/setup-evaluator.js";
import { runHistoricalBacktest } from "../src/multi-timeframe-backtest.js";

const BASE_URL = "https://open-api.bingx.com";
const DAY = 86400000;
const TARGET_SYMBOLS = 50;
const WINDOW_DAYS = 90;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new Error("INVALID_BINGX_UNIVERSE_RESPONSE");
  const active = new Set(contracts
    .filter(c => c && c.status === 1 && String(c.apiStateOpen).toLowerCase() === "true")
    .map(c => String(c.symbol || "").toUpperCase())
    .filter(s => /^[A-Z0-9]+-USDT$/.test(s)));
  return tickers
    .filter(t => active.has(String(t.symbol || "").toUpperCase()))
    .map(t => {
      const bid = Number(t.bidPrice), ask = Number(t.askPrice), quoteVolume = Number(t.quoteVolume);
      const mid = (bid + ask) / 2;
      const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : Infinity;
      return { symbol: String(t.symbol).toUpperCase(), quoteVolume, spreadPct, lastPrice: Number(t.lastPrice) };
    })
    .filter(t => Number.isFinite(t.quoteVolume) && t.quoteVolume > 0 &&
      Number.isFinite(t.lastPrice) && t.lastPrice > 0 &&
      Number.isFinite(t.spreadPct) && t.spreadPct >= 0 && t.spreadPct <= 0.5)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
}

const now = Date.now();
const startTime = now - WINDOW_DAYS * DAY;
const provider = new BingXPublicKlineProvider({ minRequestIntervalMs: 1050 });
const universe = await selectTopSymbols();
if (universe.length < TARGET_SYMBOLS) {
  throw new Error("INSUFFICIENT_LIQUID_USDT_PERPETUALS: expected at least " + TARGET_SYMBOLS + ", found " + universe.length);
}

const results = [];
const failures = [];
for (let index = 0; index < universe.length && results.length < TARGET_SYMBOLS; index++) {
  const selected = universe[index];
  process.stdout.write("[" + (results.length + 1) + "/" + TARGET_SYMBOLS + "] " + selected.symbol + " fetching 90d Swing data\n");
  try {
    const timeframes = await fetchEngineDataset({
      provider, symbol: selected.symbol, engine: "swing", startTime, endTime: now
    });
    const fundingRates = await provider.getFundingRates({
      symbol: selected.symbol, startTime, endTime: now, limit: 100
    });
    if (!fundingRates.length) throw new Error("PUBLIC_HISTORICAL_FUNDING_DATA_MISSING");
    const common = {
      symbol: selected.symbol, periodDays: [WINDOW_DAYS], fundingRates,
      feeRate: 0.0005, slippageRate: 0.0002
    };
    const entry15m = runHistoricalBacktest({
      ...common, engine: "swing", timeframes, evaluate: evaluateSwing, entryTimeframe: "15m"
    });
    const entry1h = runHistoricalBacktest({
      ...common, engine: "swing", timeframes, evaluate: evaluateSwing, entryTimeframe: "1h"
    });
    results.push({
      symbol: selected.symbol,
      selection: { quoteVolume24h: selected.quoteVolume, spreadPct: selected.spreadPct },
      fundingRecords: fundingRates.length,
      dataRanges: Object.fromEntries(Object.entries(timeframes).map(([tf, rows]) => [
        tf, { candles: rows.length, start: rows[0]?.timestamp ?? null, end: rows.at(-1)?.timestamp ?? null }
      ])),
      entry15m: entry15m.periods[0],
      entry1h: entry1h.periods[0],
      trades15m: entry15m.tradesByPeriod[WINDOW_DAYS],
      trades1h: entry1h.tradesByPeriod[WINDOW_DAYS],
      assumptions: { entry15m: entry15m.assumptions, entry1h: entry1h.assumptions }
    });
    process.stdout.write("[" + results.length + "/" + TARGET_SYMBOLS + "] " + selected.symbol + " complete\n");
  } catch (error) {
    failures.push({ symbol: selected.symbol, error: String(error?.message || error) });
    process.stderr.write(selected.symbol + " FAILED: " + String(error?.message || error) + "\n");
  }
}

const aggregate = (field) => {
  const rows = results.map(x => x[field]);
  const trades = rows.reduce((sum, x) => sum + x.trades, 0);
  const wins = rows.reduce((sum, x) => sum + x.wins, 0);
  const grossWins = rows.reduce((sum, x) => sum + (x.profitFactor === null ? 0 : x.profitFactor * Math.abs(x.totalR - x.expectancyR * x.trades < 0 ? x.totalR : 0)), 0);
  const totalR = rows.reduce((sum, x) => sum + x.totalR, 0);
  const weightedDrawdown = rows.length ? rows.reduce((sum, x) => sum + x.maxDrawdownPct, 0) / rows.length : 0;
  const grossWinR = results.flatMap(x => x[field === "entry15m" ? "trades15m" : "trades1h"]).filter(t => t.netR > 0).reduce((s, t) => s + t.netR, 0);
  const grossLossR = Math.abs(results.flatMap(x => x[field === "entry15m" ? "trades15m" : "trades1h"]).filter(t => t.netR <= 0).reduce((s, t) => s + t.netR, 0));
  return {
    pairsCompleted: results.length, totalTrades: trades, wins, losses: trades - wins,
    winRate: trades ? wins / trades : 0,
    profitFactor: grossLossR ? grossWinR / grossLossR : grossWinR ? null : 0,
    expectancyR: trades ? totalR / trades : 0, totalR,
    averagePerPairMaxDrawdownPct: Number(weightedDrawdown.toFixed(4)),
    confidence: trades < 30 ? "INSUFFICIENT_DATA" : "SAMPLE_AVAILABLE"
  };
};

const output = {
  metadata: {
    generatedAt: new Date().toISOString(),
    exchange: "BingX USDT-M perpetuals",
    engine: "SWING_ONLY",
    requestedPairs: TARGET_SYMBOLS,
    completedPairs: results.length,
    failedPairs: failures.length,
    dataWindowDays: WINDOW_DAYS,
    source: "BingX public market-data endpoints",
    symbolSelection: "Top 50 by 24h quoteVolume among active/open USDT perpetuals with observed bid/ask spread <= 0.5%",
    timeframes: ["1d", "4h", "1h", "15m"],
    entryComparisons: ["15m", "1h"],
    costAssumptions: { feeRatePerSide: 0.0005, slippageRatePerSide: 0.0002 },
    limitations: [
      "Public historical market data only; no API credentials, private account reads, or orders",
      "Per-trade maximum observation horizon remains 30 days; the 90 days is the historical sample window",
      "Normalized equity index only; no USDT starting balance is assumed",
      "No partial TP1/50% close or break-even stop management",
      "No leverage, liquidation, historical spread/depth or market-impact simulation",
      "Stop is assumed to execute first when stop and target are both touched in one candle",
      "Funding uses actual returned historical settlement records only; missing funding data fails that pair"
    ]
  },
  aggregate: { entry15m: aggregate("entry15m"), entry1h: aggregate("entry1h") },
  pairs: results,
  failures
};

await writeFile("swing-50-pairs-90d-report.json", JSON.stringify(output, null, 2) + "\n", { encoding: "utf8" });
process.stdout.write(JSON.stringify({ metadata: output.metadata, aggregate: output.aggregate, failures }, null, 2) + "\n");
if (results.length !== TARGET_SYMBOLS) {
  throw new Error("SWING_BACKTEST_INCOMPLETE: completed " + results.length + " of " + TARGET_SYMBOLS + " pairs; report artifact retained for diagnosis");
}
