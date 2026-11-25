import { getLiveReadiness, BingXLiveExecutionAdapter } from "./src/live-execution.js";
import { BingXLiveClient } from "./src/bingx-live-client.js";
import { DurableObjectLiveStore } from "./src/live-state-store.js";
import { manageLivePositions } from "./src/live-position-manager.js";
import { runLiveSetupQueue } from "./src/live-runner.js";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/paper-engine.ts
function recordModelExecutionDecision(current, setup, code, stage, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const telemetry = current ? JSON.parse(JSON.stringify(current)) : { startedAt: at, updatedAt: at, scannedSymbols: 0, byModel: {}, byModelTimeframe: {}, executionByModel: {}, recentDecisions: [] };
  const row = telemetry.executionByModel[setup.model] ?? (telemetry.executionByModel[setup.model] = { checks: 0, opened: 0, rejections: {} });
  row.checks++;
  if (stage === "OPENED") row.opened++;
  else row.rejections[code] = (row.rejections[code] ?? 0) + 1;
  telemetry.recentDecisions.push({ at, symbol: setup.symbol, model: setup.model, side: setup.side, entryTimeframe: setup.entryTimeframe, ...setup.setupTimeframe ? { setupTimeframe: setup.setupTimeframe } : {}, score: setup.score, code, stage });
  telemetry.recentDecisions = telemetry.recentDecisions.slice(-100);
  telemetry.updatedAt = at;
  return telemetry;
}
__name(recordModelExecutionDecision, "recordModelExecutionDecision");
var round = /* @__PURE__ */ __name((n, dp = 8) => Number(n.toFixed(dp)), "round");
var DEFAULT_TAKER_FEE_RATE = 5e-4;
function analyzeMarketStructure(candles, options = {}) {
  const left = Math.max(1, Math.floor(options.leftBars ?? 2));
  const right = Math.max(1, Math.floor(options.rightBars ?? 2));
  const minDisplacementBodyRatio = Math.max(0.1, Math.min(0.9, Number(options.minDisplacementBodyRatio ?? 0.45)));
  const minCloseLocation = Math.max(0.5, Math.min(0.95, Number(options.minCloseLocation ?? 0.65)));
  const c = candles.filter((x) => [x.open, x.high, x.low, x.close, x.time].every(Number.isFinite) && x.close > 0 && x.high >= x.low && x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close)).sort((a, b) => a.time - b.time);
  const swings = [], events = [];
  if (c.length < left + right + 3) return { trend: "NEUTRAL", swings, events };
  let lastHigh, lastLow;
  let lastHighLabel, lastLowLabel;
  let activeTrend = "NEUTRAL";
  const brokenHighs = /* @__PURE__ */ new Set(), brokenLows = /* @__PURE__ */ new Set();
  const tolerance = /* @__PURE__ */ __name((price) => Math.max(1e-12, Math.abs(price) * 1e-10), "tolerance");
  const structuralTrend = /* @__PURE__ */ __name(() => {
    if (lastHighLabel === "HH" && lastLowLabel === "HL") return "LONG";
    if (lastHighLabel === "LH" && lastLowLabel === "LL") return "SHORT";
    return "NEUTRAL";
  }, "structuralTrend");
  const displacementAt = /* @__PURE__ */ __name((index, side) => {
    const candle = c[index], range = candle.high - candle.low, body = Math.abs(candle.close - candle.open);
    if (range <= 0) return { ok: false, multiple: 0 };
    const location = (candle.close - candle.low) / range, multiple = body / range;
    return { ok: multiple >= minDisplacementBodyRatio && (side === "LONG" ? candle.close > candle.open && location >= minCloseLocation : candle.close < candle.open && location <= 1 - minCloseLocation), multiple };
  }, "displacementAt");
  for (let i = 0; i < c.length; i++) {
    const pivotIndex = i - right;
    if (pivotIndex >= left) {
      const pivot = c[pivotIndex], before = c.slice(pivotIndex - left, pivotIndex), after = c.slice(pivotIndex + 1, pivotIndex + right + 1);
      const isHigh = before.every((x) => pivot.high >= x.high) && after.every((x) => pivot.high > x.high);
      const isLow = before.every((x) => pivot.low <= x.low) && after.every((x) => pivot.low < x.low);
      if (isHigh) {
        const eps = tolerance(pivot.high), label = lastHigh ? pivot.high > lastHigh.price + eps ? "HH" : pivot.high < lastHigh.price - eps ? "LH" : void 0 : void 0;
        const point = { index: pivotIndex, confirmedAt: i, price: pivot.high, kind: "HIGH", ...label ? { label } : {} };
        swings.push(point);
        lastHigh = point;
        lastHighLabel = label;
      }
      if (isLow) {
        const eps = tolerance(pivot.low), label = lastLow ? pivot.low > lastLow.price + eps ? "HL" : pivot.low < lastLow.price - eps ? "LL" : void 0 : void 0;
        const point = { index: pivotIndex, confirmedAt: i, price: pivot.low, kind: "LOW", ...label ? { label } : {} };
        swings.push(point);
        lastLow = point;
        lastLowLabel = label;
      }
    }
    if (i === 0) continue;
    const previousClose = c[i - 1].close, currentClose = c[i].close;
    const trendBefore = activeTrend !== "NEUTRAL" ? activeTrend : structuralTrend();
    const crossedUp = !!lastHigh && previousClose <= lastHigh.price && currentClose > lastHigh.price && !brokenHighs.has(lastHigh.index);
    const crossedDown = !!lastLow && previousClose >= lastLow.price && currentClose < lastLow.price && !brokenLows.has(lastLow.index);
    if (crossedUp && crossedDown) continue;
    if (crossedUp && lastHigh) {
      brokenHighs.add(lastHigh.index);
      const side = "LONG", displacement = displacementAt(i, side), reversal = trendBefore === "SHORT";
      const base = { type: reversal ? "CHoCH" : "BOS", side, level: lastHigh.price, levelIndex: lastHigh.index, candleIndex: i, candleTime: c[i].time, displacement: displacement.ok, bodyMultiple: Number(displacement.multiple.toFixed(3)), trendBefore };
      events.push(base);
      if (displacement.ok) events.push({ ...base, type: "MSB" });
      if (reversal && displacement.ok) events.push({ ...base, type: "MSS" });
      activeTrend = side;
    } else if (crossedDown && lastLow) {
      brokenLows.add(lastLow.index);
      const side = "SHORT", displacement = displacementAt(i, side), reversal = trendBefore === "LONG";
      const base = { type: reversal ? "CHoCH" : "BOS", side, level: lastLow.price, levelIndex: lastLow.index, candleIndex: i, candleTime: c[i].time, displacement: displacement.ok, bodyMultiple: Number(displacement.multiple.toFixed(3)), trendBefore };
      events.push(base);
      if (reversal && displacement.ok) events.push({ ...base, type: "MSS" });
      activeTrend = side;
    }
  }
  const trend = activeTrend !== "NEUTRAL" ? activeTrend : structuralTrend();
  return { trend, swings, events, lastHigh, lastLow };
}
__name(analyzeMarketStructure, "analyzeMarketStructure");
function backtestComparableStructuralBias(candles) {
  const rows = (candles ?? []).filter((c) => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0 && c.high >= c.low).sort((a, b) => a.time - b.time).slice(-72);
  if (rows.length < 24) return "NEUTRAL";
  const highs = [], lows = [];
  for (let i = 2; i < rows.length - 2; i++) {
    const candle = rows[i], left = rows.slice(i - 2, i), right = rows.slice(i + 1, i + 3);
    if (left.every((x) => candle.high > x.high) && right.every((x) => candle.high > x.high)) highs.push(candle.high);
    if (left.every((x) => candle.low < x.low) && right.every((x) => candle.low < x.low)) lows.push(candle.low);
  }
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  const [previousHigh, lastHigh] = highs.slice(-2), [previousLow, lastLow] = lows.slice(-2);
  if (lastHigh > previousHigh && lastLow > previousLow) return "BULLISH";
  if (lastHigh < previousHigh && lastLow < previousLow) return "BEARISH";
  return "NEUTRAL";
}
__name(backtestComparableStructuralBias, "backtestComparableStructuralBias");
function combineStructuralBias(fourHour, oneDay) {
  if (fourHour === oneDay) return fourHour;
  if (fourHour === "NEUTRAL") return oneDay;
  if (oneDay === "NEUTRAL") return fourHour;
  return "NEUTRAL";
}
__name(combineStructuralBias, "combineStructuralBias");
function updateConfirmedStructuralBiasState(previous, fourHourCandles, oneDayCandles, now = Date.now()) {
  const fourHour = [...fourHourCandles ?? []].filter((c) => Number.isFinite(c.time) && c.time + 144e5 <= now && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0 && c.high >= c.low).sort((a, b) => a.time - b.time);
  const oneDay = [...oneDayCandles ?? []].filter((c) => Number.isFinite(c.time) && c.time + 864e5 <= now && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close > 0 && c.high >= c.low).sort((a, b) => a.time - b.time);
  const latest = fourHour.at(-1);
  if (!latest || fourHour.length < 8 || oneDay.length < 8) return previous;
  const closedFourHourTime = latest.time + 144e5;
  if (previous && closedFourHourTime <= previous.lastEvaluatedFourHourCloseTime) return previous;
  const fourHourBias = backtestComparableStructuralBias(fourHour);
  const oneDayBias = backtestComparableStructuralBias(oneDay);
  const candidate = combineStructuralBias(fourHourBias, oneDayBias);
  let activeBias = previous?.activeBias ?? "NEUTRAL";
  let pendingBias = previous?.pendingBias ?? "NEUTRAL";
  let pendingCount = previous?.pendingCount ?? 0;
  if (candidate === activeBias) {
    pendingBias = "NEUTRAL";
    pendingCount = 0;
  } else if (candidate === pendingBias) {
    pendingCount++;
  } else {
    pendingBias = candidate;
    pendingCount = 1;
  }
  if (pendingCount >= 2) {
    activeBias = pendingBias;
    pendingBias = "NEUTRAL";
    pendingCount = 0;
  }
  return { activeBias, pendingBias, pendingCount, lastEvaluatedFourHourCloseTime: closedFourHourTime, updatedAt: now, fourHourBias, oneDayBias };
}
__name(updateConfirmedStructuralBiasState, "updateConfirmedStructuralBiasState");
function summarizeAltcoinBreadthBias(states, universeSymbols, now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1e3, minimumCoveragePct = 60, breadthThresholdPct = 60) {
  const eligible = universeSymbols.filter((symbol) => symbol !== "BTC-USDT");
  const fresh = eligible.filter((symbol) => {
    const state = states[symbol];
    return !!state && Number.isFinite(state.updatedAt) && state.updatedAt <= now + 6e4 && now - state.updatedAt <= maxAgeMs;
  });
  const freshSymbolCount = fresh.length;
  const coveragePct = eligible.length ? freshSymbolCount / eligible.length * 100 : 0;
  const bullish = fresh.filter((symbol) => states[symbol]?.activeBias === "BULLISH").length;
  const bearish = fresh.filter((symbol) => states[symbol]?.activeBias === "BEARISH").length;
  const bullishSharePct = eligible.length ? bullish / eligible.length * 100 : 0;
  const bearishSharePct = eligible.length ? bearish / eligible.length * 100 : 0;
  if (coveragePct < minimumCoveragePct) return { bias: "NEUTRAL", eligibleAltcoinCount: eligible.length, freshSymbolCount, coveragePct: Number(coveragePct.toFixed(2)), bullishSharePct: Number(bullishSharePct.toFixed(2)), bearishSharePct: Number(bearishSharePct.toFixed(2)), reason: "INSUFFICIENT_UNIVERSE_COVERAGE" };
  if (bullishSharePct >= breadthThresholdPct) return { bias: "BULLISH", eligibleAltcoinCount: eligible.length, freshSymbolCount, coveragePct: Number(coveragePct.toFixed(2)), bullishSharePct: Number(bullishSharePct.toFixed(2)), bearishSharePct: Number(bearishSharePct.toFixed(2)), reason: "CONFIRMED_BULLISH_BREADTH" };
  if (bearishSharePct >= breadthThresholdPct) return { bias: "BEARISH", eligibleAltcoinCount: eligible.length, freshSymbolCount, coveragePct: Number(coveragePct.toFixed(2)), bullishSharePct: Number(bullishSharePct.toFixed(2)), bearishSharePct: Number(bearishSharePct.toFixed(2)), reason: "CONFIRMED_BEARISH_BREADTH" };
  return { bias: "NEUTRAL", eligibleAltcoinCount: eligible.length, freshSymbolCount, coveragePct: Number(coveragePct.toFixed(2)), bullishSharePct: Number(bullishSharePct.toFixed(2)), bearishSharePct: Number(bearishSharePct.toFixed(2)), reason: "NEUTRAL_BREADTH" };
}
__name(summarizeAltcoinBreadthBias, "summarizeAltcoinBreadthBias");
var DEFAULT_MAINTENANCE_MARGIN_RATE = 5e-3;
var DEFAULT_LIQUIDATION_FEE_RATE = 5e-3;
function calculateLiquidationPrice(entry, side, leverage, maintenanceMarginRate = DEFAULT_MAINTENANCE_MARGIN_RATE) {
  if (![entry, leverage, maintenanceMarginRate].every(Number.isFinite) || entry <= 0 || leverage <= 0 || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) return 0;
  const raw = side === "LONG" ? entry * (1 - 1 / leverage + maintenanceMarginRate) : entry * (1 + 1 / leverage - maintenanceMarginRate);
  return raw > 0 ? round(raw, 8) : 0;
}
__name(calculateLiquidationPrice, "calculateLiquidationPrice");
function closePaperQuantity(ledger, p, qty, executionPrice, now, reason, triggerPrice, markPrice, liquidation = false, stage) {
  if (p.status !== "OPEN") return;
  const priorClosed = (ledger.closedTrades ?? []).find((trade) => (trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION") && String(trade.positionId ?? trade.id ?? "") === String(p.id));
  if (priorClosed) { p.status = "CLOSED"; p.closedAt = priorClosed.closedAt; p.closeReason = priorClosed.closeReason; p.closeSource = priorClosed.closeSource; p.qty = Number(p.initialQty ?? p.qty); p.unrealizedPnlUsdt = 0; return; }
  const closeQty = round(Math.min(Math.max(0, qty), Math.max(0, p.qty)), 8);
  if (closeQty <= 0 || !Number.isFinite(executionPrice) || executionPrice <= 0) return;
  const isLong = p.side === "LONG";
  const gross = round((isLong ? executionPrice - p.entry : p.entry - executionPrice) * closeQty);
  const feeRate = Number.isFinite(p.feeRate) ? Math.max(0, Number(p.feeRate)) : DEFAULT_TAKER_FEE_RATE;
  const exitFee = round(closeQty * executionPrice * feeRate + (liquidation ? closeQty * executionPrice * DEFAULT_LIQUIDATION_FEE_RATE : 0), 8);
  const exitSlippage = round(closeQty * executionPrice * SLIPPAGE_RATE, 8);
  p.exitFeesUsdt = round((p.exitFeesUsdt ?? 0) + exitFee, 8);
  p.feesPaidUsdt = round((p.entryFeeUsdt ?? 0) + (p.exitFeesUsdt ?? 0), 8);
  p.slippagePaidUsdt = round((Number(p.slippagePaidUsdt) || 0) + exitSlippage, 8);
  p.realizedPnlUsdt = round((p.realizedPnlUsdt ?? 0) + gross - exitFee - exitSlippage, 8);
  if (/^TP[123]_TAKE_PROFIT$/.test(String(reason))) { const initialQtyForTp = Number(p.initialQty ?? p.qty); const allocatedEntryFeeForTp = round((Number(p.entryFeeUsdt) || 0) * (initialQtyForTp > 0 ? closeQty / initialQtyForTp : 0), 8); p.tpRealizedPnlUsdt = round((Number(p.tpRealizedPnlUsdt) || 0) + gross - exitFee - exitSlippage - allocatedEntryFeeForTp, 8); }
  ledger.balance = round(ledger.balance + gross - exitFee - exitSlippage, 8);
  ledger.dailyPnl = round(ledger.dailyPnl + gross - exitFee - exitSlippage, 8);
  const initialQty = Number(p.initialQty ?? p.qty);
  p.qty = round(Math.max(0, p.qty - closeQty), 8);
  const initialMargin = Number(p.initialMarginUsdt ?? p.marginUsdt ?? p.allocationUsdt ?? 0);
  if (Number.isFinite(initialMargin) && initialMargin >= 0) {
    p.initialMarginUsdt = initialMargin;
    const remainingRatio = initialQty > 0 ? Math.max(0, p.qty / initialQty) : 0;
    p.marginUsdt = round(initialMargin * remainingRatio, 8);
    p.allocationUsdt = round(initialMargin * remainingRatio, 8);
  }
  const event = liquidation ? "LIQUIDATION" : reason.endsWith("BREAK_EVEN") ? "BREAK_EVEN" : reason === "STOP_LOSS" ? "STOP_LOSS" : p.qty <= 0 ? "TP_FINAL" : "TP_PARTIAL";
  p.lastTriggerPrice = triggerPrice;
  p.lastExecutionPrice = executionPrice;
  p.lastTriggerAt = now;
  p.lastMarkPrice = markPrice;
  p.markPrice = markPrice;
  p.markPriceAt = new Date(now).toISOString();
  p.executionEvents = [...p.executionEvents ?? [], { event, ...stage ? { stage } : {}, triggerPrice, markPrice, executionPrice, qty: closeQty, at: now, closeReason: reason }];
  console.info("Paper position execution", JSON.stringify({ at: new Date(now).toISOString(), symbol: p.symbol, model: p.model, side: p.side, event, stage: stage ?? null, triggerPrice, markPrice, executionPrice, priceDifference: round(executionPrice - triggerPrice, 10), qty: closeQty, remainingQty: p.qty, closeReason: reason, liquidation }));
  if (liquidation || p.qty <= 0) {
    p.status = "CLOSED";
    p.closedAt = now;
    p.exitPrice = executionPrice;
    p.exitTriggerPrice = triggerPrice;
    p.exitMarkPrice = markPrice;
    p.pnlUsdt = round(Number(p.realizedPnlUsdt) - (p.entryFeeUsdt ?? 0), 8);
    p.closeReason = reason;
    p.closeSource = liquidation ? "LIQUIDATION" : "AUTOMATED_SL_TP";
    p.qty = initialQty || closeQty;
    if (Number.isFinite(initialMargin) && initialMargin >= 0) {
      p.marginUsdt = initialMargin;
      p.allocationUsdt = initialMargin;
    }
    p.unrealizedPnlUsdt = 0;
    ledger.closedTrades.unshift({ ...p });
  }
}
__name(closePaperQuantity, "closePaperQuantity");
function updatePositions(ledger, prices, now = Date.now(), _marketStopSymbols = /* @__PURE__ */ new Set()) {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (ledger.dayKey !== dayKey) {
    ledger.dayKey = dayKey;
    ledger.dailyPnl = 0;
  }
  for (const p of ledger.positions.filter((x) => x.status === "OPEN")) {
    const markPrice = prices[p.symbol];
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      p.livePriceAvailable = false;
      p.livePriceUnavailableReason = "MARK_PRICE_UNAVAILABLE";
      p.livePriceUnavailableAt = new Date(now).toISOString();
      continue;
    }
    if (!Number.isFinite(p.initialQty) || !p.initialQty) p.initialQty = p.qty;
    if (!Number.isFinite(p.targetStage) || Number(p.targetStage) < 0) p.targetStage = 0;
    if (!Number.isFinite(p.realizedPnlUsdt)) p.realizedPnlUsdt = 0;
    if (p.feeAccountingVersion !== 2) {
      const legacyRate = Number(p.feeRate);
      if (Number.isFinite(legacyRate) && legacyRate > FEE_RATE && Number(p.entryFeeUsdt) > 0) {
        const correctedEntryFee = round(Number(p.initialQty ?? p.qty) * Number(p.entry) * FEE_RATE, 8);
        const feeRefund = round(Math.max(0, Number(p.entryFeeUsdt) - correctedEntryFee), 8);
        if (feeRefund > 0) {
          ledger.balance = round(ledger.balance + feeRefund, 8);
          if (ledger.dayKey === new Date(Number(p.openedAt) || now).toISOString().slice(0, 10)) ledger.dailyPnl = round((Number(ledger.dailyPnl) || 0) + feeRefund, 8);
          p.entryFeeUsdt = correctedEntryFee;
          p.feesPaidUsdt = round(correctedEntryFee + (Number(p.exitFeesUsdt) || 0), 8);
        }
      }
      p.feeRate = FEE_RATE;
      p.feeAccountingVersion = 2;
    }
    if (!Number.isFinite(p.feeRate)) p.feeRate = DEFAULT_TAKER_FEE_RATE;
    if (!Number.isFinite(p.entryFeeUsdt)) p.entryFeeUsdt = 0;
    if (!Number.isFinite(p.exitFeesUsdt)) p.exitFeesUsdt = 0;
    if (!Number.isFinite(p.feesPaidUsdt)) p.feesPaidUsdt = Number(p.entryFeeUsdt) + Number(p.exitFeesUsdt);
    if (!Number.isFinite(p.maintenanceMarginRate)) p.maintenanceMarginRate = DEFAULT_MAINTENANCE_MARGIN_RATE;
    if (!Number.isFinite(p.liquidationPrice) || Number(p.liquidationPrice) <= 0)
      p.liquidationPrice = calculateLiquidationPrice(p.entry, p.side, Number(p.leverage) || 20, Number(p.maintenanceMarginRate));
    p.markPrice = markPrice;
    p.lastMarkPrice = markPrice;
    p.markPriceAt = new Date(now).toISOString();
    p.livePriceAt = p.markPriceAt;
    p.livePriceAvailable = true;
    delete p.livePriceUnavailableReason;
    delete p.livePriceUnavailableAt;
    const isLong = p.side === "LONG", crossed = /* @__PURE__ */ __name((level) => isLong ? markPrice >= level : markPrice <= level, "crossed");
    const hitLiquidation = isLong ? markPrice <= Number(p.liquidationPrice) : markPrice >= Number(p.liquidationPrice);
    const hitSL = isLong ? markPrice <= p.stopLoss : markPrice >= p.stopLoss;
    const stopIsBeforeLiquidation = isLong ? p.stopLoss >= Number(p.liquidationPrice) : p.stopLoss <= Number(p.liquidationPrice);
    if (hitSL && (!hitLiquidation || stopIsBeforeLiquidation)) {
      const reached = (Array.isArray(p.targetStagesReached) ? p.targetStagesReached : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 3).sort((a, b) => a - b);
      const atEntry = Math.abs(Number(p.stopLoss) - Number(p.entry)) <= Math.max(1e-8, Math.abs(Number(p.entry)) * 1e-8);
      const closeReason2 = reached.length > 0 && atEntry ? [...reached.map((n) => "TP" + n), "BREAK_EVEN"].join("_") : "STOP_LOSS";
      const stopFillPrice = p.model === "TURTLE_SYSTEM_1" ? markPrice : p.stopLoss;
      closePaperQuantity(ledger, p, p.qty, stopFillPrice, now, closeReason2, p.stopLoss, markPrice, false, reached.length ? reached[reached.length - 1] : void 0);
      continue;
    }
    if (hitLiquidation) {
      const liqPrice = Number(p.liquidationPrice);
      closePaperQuantity(ledger, p, p.qty, liqPrice, now, "LIQUIDATION", liqPrice, markPrice, true);
      continue;
    }
    if (p.model === "TURTLE_SYSTEM_1") continue;
    const first = p.tp1 ?? p.takeProfit, second = p.tp2, third = p.tp3;
    if (!Number.isFinite(p.tp1) || !Number.isFinite(p.tp2)) {
      const hitTP = isLong ? markPrice >= p.takeProfit : markPrice <= p.takeProfit;
      if (hitTP) closePaperQuantity(ledger, p, p.qty, markPrice, now, "TAKE_PROFIT", p.takeProfit, markPrice, false, 1);
      continue;
    }
    const orderedTargets = isLong ? Number(p.tp1) < Number(p.tp2) && (!Number.isFinite(third) || Number(p.tp2) < Number(third)) : Number(p.tp1) > Number(p.tp2) && (!Number.isFinite(third) || Number(p.tp2) > Number(third));
    if (!orderedTargets) {
      const hitTP = isLong ? markPrice >= p.takeProfit : markPrice <= p.takeProfit;
      if (hitTP) closePaperQuantity(ledger, p, p.qty, markPrice, now, "TAKE_PROFIT", p.takeProfit, markPrice);
      continue;
    }
    const maxStage = Number.isFinite(third) ? 3 : 2;
    const storedStages = [...new Set((Array.isArray(p.targetStagesReached) ? p.targetStagesReached : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 3))].sort((a, b) => a - b);
    let contiguousStage = 0;
    while (storedStages.includes(contiguousStage + 1)) contiguousStage++;
    p.targetStagesReached = Array.from({ length: contiguousStage }, (_, index) => index + 1);
    p.targetStage = contiguousStage;
    while (p.status === "OPEN" && Number(p.targetStage) < maxStage) {
      const stage = Number(p.targetStage) + 1;
      const target = stage === 1 ? first : stage === 2 ? second : third;
      if (!Number.isFinite(target) || !crossed(Number(target))) break;
      const finalTarget = stage === maxStage;
      const closeQty = finalTarget ? p.qty : Math.min(p.qty, round(Number(p.initialQty) * (stage === 1 ? 0.5 : third ? 0.25 : 0.5), 8));
      if (closeQty <= 0) break;
      p.targetStage = stage;
      p.targetStagesReached = [.../* @__PURE__ */ new Set([...p.targetStagesReached, stage])].sort((a, b) => a - b);
      closePaperQuantity(ledger, p, closeQty, markPrice, now, "TP" + stage + "_TAKE_PROFIT", Number(target), markPrice, false, stage);
      if (stage === 1 && p.status === "OPEN") p.stopLoss = p.entry;
    }
  }
  ledger.positions = ledger.positions.filter((x) => x.status === "OPEN");
  ledger.equity = round(ledger.balance + ledger.positions.reduce((sum, p) => {
    const mark = prices[p.symbol] ?? p.markPrice ?? p.entry;
    if (!Number.isFinite(mark) || mark <= 0) return sum;
    const gross = (p.side === "LONG" ? mark - p.entry : p.entry - mark) * p.qty;
    const exitFee = p.qty * mark * (Number.isFinite(p.feeRate) ? Number(p.feeRate) : DEFAULT_TAKER_FEE_RATE);
    const exitSlippage = p.qty * mark * SLIPPAGE_RATE;
    p.unrealizedPnlUsdt = round(gross - exitFee - exitSlippage, 8);
    return sum + gross - exitFee - exitSlippage;
  }, 0), 8);
}
__name(updatePositions, "updatePositions");
function resolveContractLeverage(contract, side) {
  const read = /* @__PURE__ */ __name((...keys) => {
    const normalized = /* @__PURE__ */ __name((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ""), "normalized");
    for (const key of keys) {
      const actual = Object.keys(contract).find((k) => normalized(k) === normalized(key));
      if (actual !== void 0) {
        const value = contract[actual];
        if (value !== void 0 && value !== null && String(value).trim() !== "") return value;
      }
    }
    return void 0;
  }, "read");
  const candidates = side === "LONG" ? [read("maxLongLeverage", "max_leverage_long", "longMaxLeverage", "maxLeverageLong"), read("maxLeverage")] : [read("maxShortLeverage", "max_leverage_short", "shortMaxLeverage", "maxLeverageShort"), read("maxLeverage")];
  for (const raw of candidates) {
    if (raw === void 0 || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 1e3) return n;
  }
  return Number.NaN;
}
__name(resolveContractLeverage, "resolveContractLeverage");
function topUpPaperCapitalOnce(ledger, targetUsdt = 1e3, id = "paper-capital-topup-1000-v1", at = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!Number.isFinite(targetUsdt) || targetUsdt <= 0) throw new Error("targetUsdt must be a positive finite number");
  if (!id.trim()) throw new Error("adjustment id is required");
  if (!Number.isFinite(ledger.balance) || ledger.balance < 0) throw new Error("Current paper balance is not verifiable");
  const balanceBefore = ledger.balance;
  const prior = (ledger.capitalAdjustments ?? []).find((x) => x.id === id);
  if (prior) return { id, targetUsdt, balanceBefore, amountUsdt: 0, balanceAfter: balanceBefore, status: "ALREADY_APPLIED" };
  const amountUsdt = Math.max(0, round(targetUsdt - balanceBefore, 8));
  const status = amountUsdt > 0 ? "APPLIED" : "ALREADY_AT_OR_ABOVE_TARGET";
  if (amountUsdt > 0) {
    ledger.balance = round(balanceBefore + amountUsdt, 8);
    if (Number.isFinite(ledger.equity)) ledger.equity = round(ledger.equity + amountUsdt, 8);
  }
  const balanceAfter = ledger.balance;
  ledger.capitalAdjustments = [...ledger.capitalAdjustments ?? [], {
    id,
    at,
    targetUsdt,
    balanceBefore,
    amountUsdt,
    balanceAfter,
    status
  }].slice(-20);
  return { id, targetUsdt, balanceBefore, amountUsdt, balanceAfter, status };
}
__name(topUpPaperCapitalOnce, "topUpPaperCapitalOnce");
function analyticsNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
__name(analyticsNumber, "analyticsNumber");
function summarizeAnalyticsGroup(key, trades) {
  const pnlTrades = trades.filter((t) => t.pnlUsdt !== null);
  const wins = pnlTrades.filter((t) => t.pnlUsdt > 1e-8);
  const losses = pnlTrades.filter((t) => t.pnlUsdt < -1e-8);
  const breakeven = pnlTrades.length - wins.length - losses.length;
  const netPnlUsdt = pnlTrades.reduce((sum, t) => sum + (t.pnlUsdt ?? 0), 0);
  const grossWinsUsdt = wins.reduce((sum, t) => sum + (t.pnlUsdt ?? 0), 0);
  const grossLossesUsdt = Math.abs(losses.reduce((sum, t) => sum + (t.pnlUsdt ?? 0), 0));
  const feeTrades = trades.filter((t) => t.feesPaidUsdt !== null);
  const feesKnownUsdt = feeTrades.reduce((sum, t) => sum + (t.feesPaidUsdt ?? 0), 0);
  const fundingTrades = trades.filter((t) => t.fundingPaidUsdt !== null);
  const fundingPaidUsdt = fundingTrades.reduce((sum, t) => sum + (t.fundingPaidUsdt ?? 0), 0);
  const slippageTrades = trades.filter((t) => t.slippagePaidUsdt !== null);
  const slippagePaidUsdt = slippageTrades.reduce((sum, t) => sum + (t.slippagePaidUsdt ?? 0), 0);
  return { key, trades: trades.length, wins: wins.length, losses: losses.length, breakeven, winRatePct: pnlTrades.length ? round(wins.length / pnlTrades.length * 100, 2) : null, netPnlUsdt: round(netPnlUsdt, 8), expectancyUsdt: pnlTrades.length ? round(netPnlUsdt / pnlTrades.length, 8) : null, grossWinsUsdt: round(grossWinsUsdt, 8), grossLossesUsdt: round(grossLossesUsdt, 8), profitFactor: grossLossesUsdt > 0 ? round(grossWinsUsdt / grossLossesUsdt, 4) : null, feesKnownUsdt: round(feesKnownUsdt, 8), tradesWithKnownFees: feeTrades.length, fundingPaidUsdt: round(fundingPaidUsdt, 8), tradesWithKnownFunding: fundingTrades.length, slippagePaidUsdt: round(slippagePaidUsdt, 8), tradesWithKnownSlippage: slippageTrades.length };
}
__name(summarizeAnalyticsGroup, "summarizeAnalyticsGroup");
function summarizeClosedTradeAnalytics(input) {
  const raw = Array.isArray(input) ? input : [];
  const trades = raw.map((value) => {
    const p = value && typeof value === "object" ? value : {};
    const pnl = analyticsNumber(p.pnlUsdt);
    const fees = analyticsNumber(p.feesPaidUsdt);
    const entryFee = analyticsNumber(p.entryFeeUsdt), exitFees = analyticsNumber(p.exitFeesUsdt);
    const feeFallback = entryFee !== null && exitFees !== null ? entryFee + exitFees : null;
    const dataQuality = [];
    if (pnl === null) dataQuality.push("MISSING_PNL");
    if (fees === null && feeFallback === null) dataQuality.push("MISSING_FEES");
    if (!p.primaryTrend || !p.marketPhase) dataQuality.push("MISSING_ENTRY_REGIME");
    return {
      id: typeof p.id === "string" ? p.id : null,
      symbol: typeof p.symbol === "string" ? p.symbol : "UNKNOWN",
      side: typeof p.side === "string" ? p.side : "UNKNOWN",
      model: typeof p.model === "string" ? p.model : "UNKNOWN",
      tradeStyle: typeof p.tradeStyle === "string" ? p.tradeStyle : "UNKNOWN",
      entryTimeframe: typeof p.entryTimeframe === "string" ? p.entryTimeframe : "UNKNOWN",
      primaryTrend: typeof p.primaryTrend === "string" ? p.primaryTrend : "UNKNOWN",
      marketPhase: typeof p.marketPhase === "string" ? p.marketPhase : "UNKNOWN",
      openedAt: analyticsNumber(p.openedAt),
      closedAt: analyticsNumber(p.closedAt),
      pnlUsdt: pnl,
      feesPaidUsdt: fees !== null ? fees : feeFallback,
      fundingPaidUsdt: analyticsNumber(p.fundingPaidUsdt),
      slippagePaidUsdt: analyticsNumber(p.slippagePaidUsdt),
      closeReason: typeof p.closeReason === "string" ? p.closeReason : null,
      dataQuality
    };
  });
  const group = /* @__PURE__ */ __name((label) => {
    const map = /* @__PURE__ */ new Map();
    for (const t of trades) {
      const key = label(t);
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return [...map.entries()].map(([key, items]) => summarizeAnalyticsGroup(key, items)).sort((a, b) => b.netPnlUsdt - a.netPnlUsdt);
  }, "group");
  const overall = summarizeAnalyticsGroup("ALL", trades);
  const pnlTrades = trades.filter((t) => t.pnlUsdt !== null), feeTrades = trades.filter((t) => t.feesPaidUsdt !== null);
  return {
    totalClosedTrades: trades.length,
    tradesWithPnl: pnlTrades.length,
    tradesMissingPnl: trades.length - pnlTrades.length,
    tradesWithKnownFees: feeTrades.length,
    tradesMissingFees: trades.length - feeTrades.length,
    tradesWithKnownFunding: trades.filter((t) => t.fundingPaidUsdt !== null).length,
    tradesMissingFunding: trades.filter((t) => t.fundingPaidUsdt === null).length,
    tradesWithKnownSlippage: trades.filter((t) => t.slippagePaidUsdt !== null).length,
    tradesMissingSlippage: trades.filter((t) => t.slippagePaidUsdt === null).length,
    tradesMissingEntryRegime: trades.filter((t) => t.primaryTrend === "UNKNOWN" || t.marketPhase === "UNKNOWN").length,
    totalNetPnlUsdt: round(pnlTrades.reduce((sum, t) => sum + (t.pnlUsdt ?? 0), 0), 8),
    totalKnownFeesUsdt: round(feeTrades.reduce((sum, t) => sum + (t.feesPaidUsdt ?? 0), 0), 8),
    overall,
    byModel: group((t) => t.model),
    byStyle: group((t) => t.tradeStyle),
    byTimeframe: group((t) => t.entryTimeframe),
    bySide: group((t) => t.side),
    byMarketPhase: group((t) => t.marketPhase),
    byModelSideTimeframe: group((t) => [t.model, t.side, t.entryTimeframe, t.tradeStyle, t.primaryTrend, t.marketPhase].join(" | ")),
    recentTrades: trades.slice().sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 100)
  };
}
__name(summarizeClosedTradeAnalytics, "summarizeClosedTradeAnalytics");

// src/strategy-allowlist.ts
var ACTIVE_SWING_MODEL_IDS = [
  "S01_SWEEP_MSS_FVG",
  "S02_BREAKER_RETEST",
  "S03_BOS_DISPLACEMENT",
  "S04_RANGE_DEVIATION",
  "S05_FAILED_BREAKOUT",
  "S06_OB_REACTION",
  "W01_HTF_OB_REVERSAL",
  "W02_SUPPLY_DEMAND_REVERSAL",
  "W03_SWEEP_CHOCH",
  "W04_BREAKER_RETEST",
  "W05_RANGE_DEVIATION",
  "W06_CRT",
  "W07_OTE",
  "W08_BOS_CONTINUATION"
];
var ACTIVE_SWING_MODEL_SET = new Set(ACTIVE_SWING_MODEL_IDS);
function isActiveSwingModelId(value) {
  const key = String(value ?? "").split(/[:|]/, 1)[0].trim();
  return ACTIVE_SWING_MODEL_SET.has(key);
}
__name(isActiveSwingModelId, "isActiveSwingModelId");
function filterActiveSwingSetups(setups) {
  return Array.isArray(setups) ? setups.filter((x) => isActiveSwingModelId(x?.model)) : [];
}
__name(filterActiveSwingSetups, "filterActiveSwingSetups");
function filterActiveSwingDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.slice(-25).map((raw) => {
    const d = raw ?? {}, td = d.timeframeDiagnostics && typeof d.timeframeDiagnostics === "object" ? d.timeframeDiagnostics : {};
    const timeframeDiagnostics = {}, rejectionSummary = { ...(d.rejectionSummary ?? {}) };
    if (!Object.keys(rejectionSummary).length) for (const value of Object.values(td)) for (const [reason, count] of Object.entries(value?.rejections ?? {})) rejectionSummary[reason] = (rejectionSummary[reason] ?? 0) + Math.max(0, Number(count) || 0);
    for (const [key, value] of Object.entries(td)) { if (!isActiveSwingModelId(key)) continue; const count = Math.max(0, Number(value?.setups) || 0); if (count > 0) timeframeDiagnostics[key] = { setups: count }; }
    const setupDetails = Array.isArray(d.setupDetails) ? d.setupDetails.filter((item) => isActiveSwingModelId(item?.model)).map((item) => ({
      model: item.model, tradeStyle: item.tradeStyle, entryTimeframe: item.entryTimeframe, setupTimeframe: item.setupTimeframe, side: item.side,
      score: item.score, status: item.status, reason: String(item.reason ?? "").slice(0, 200), entry: item.entry, stopLoss: item.stopLoss, takeProfit: item.takeProfit,
      tp1: item.tp1, tp2: item.tp2, tp3: item.tp3, confidence: item.confidence, confidenceStatus: item.confidenceStatus, confidenceSampleSize: item.confidenceSampleSize, riskReward: item.riskReward
    })) : [];
    return { symbol: d.symbol, scannedAt: d.scannedAt, status: d.status, setups: Number(d.setups) || setupDetails.length, missingCandleFrames: Array.isArray(d.missingCandleFrames) ? d.missingCandleFrames : [], engineAvailability: d.engineAvailability ?? null, timeframeDiagnostics, rejectionSummary, setupDetails, activityMetrics: d.activityMetrics ?? null, activityDataStatus: d.activityDataStatus ?? null, candleDiagnostics: d.candleDiagnostics ?? null };
  });
}
__name(filterActiveSwingDiagnostics, "filterActiveSwingDiagnostics");
function filterActiveSwingModelTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return void 0;
  const s = telemetry, filterMap = /* @__PURE__ */ __name((v) => v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([key]) => isActiveSwingModelId(key))) : v, "filterMap");
  const recentDecisions = Array.isArray(s.recentDecisions) ? s.recentDecisions.filter((x) => isActiveSwingModelId(x?.model)) : s.recentDecisions;
  const volumeShadow = s.volumeShadow && typeof s.volumeShadow === "object" ? { ...s.volumeShadow, byModel: filterMap(s.volumeShadow.byModel), byModelTimeframe: filterMap(s.volumeShadow.byModelTimeframe) } : s.volumeShadow;
  return { ...s, byModel: filterMap(s.byModel), byModelTimeframe: filterMap(s.byModelTimeframe), executionByModel: filterMap(s.executionByModel), recentDecisions, volumeShadow };
}
__name(filterActiveSwingModelTelemetry, "filterActiveSwingModelTelemetry");

// src/scalp-swing-config.ts
var SCORE_BANDS = Object.freeze([
  { min: 0, max: 59, label: "RED" },
  { min: 60, max: 64, label: "WAIT" },
  { min: 65, max: 69, label: "WATCH" },
  { min: 70, max: 83, label: "QUALIFIED" },
  { min: 84, max: 100, label: "HIGH_QUALITY" }
]);
var ENGINE_CONFIG = Object.freeze({
  SCALP: Object.freeze({
    id: "SCALP",
    directionTimeframe: "1h",
    zoneTimeframe: "15m",
    setupTimeframe: "5m",
    entryTimeframe: "5m",
    scoreWeights: Object.freeze({ htf: 15, liquidity: 20, marketStructure: 20, zone: 15, entryConfirmation: 20, volume: 10 }),
    setups: Object.freeze([
      "S01_SWEEP_MSS_FVG",
      "S02_BREAKER_RETEST",
      "S03_BOS_DISPLACEMENT",
      "S04_RANGE_DEVIATION",
      "S05_FAILED_BREAKOUT",
      "S06_OB_REACTION"
    ])
  }),
  SWING: Object.freeze({
    id: "SWING",
    directionTimeframe: "1d",
    zoneTimeframe: "4h",
    setupTimeframe: "1h",
    entryTimeframe: "15m",
    scoreWeights: Object.freeze({ htf: 20, liquidity: 15, marketStructure: 20, zone: 20, entryConfirmation: 15, volume: 10 }),
    setups: Object.freeze([
      "W01_HTF_OB_REVERSAL",
      "W02_SUPPLY_DEMAND_REVERSAL",
      "W03_SWEEP_CHOCH",
      "W04_BREAKER_RETEST",
      "W05_RANGE_DEVIATION",
      "W06_CRT",
      "W07_OTE",
      "W08_BOS_CONTINUATION"
    ])
  })
});
var RISK_CONFIG = Object.freeze({
  normalRiskPercentOfEquity: 2,
  reducedRiskPercentOfEquity: 1,
  minimumRiskReward: 1,
  standardTargetR: 3.5,
  extendedTargetRequiresHighQuality: true,
  extendedTargetRequiresVolumeAndLiquidity: true,
  includeFeesSlippageFunding: true,
  positionSizingSeparatesMarginFromMaxLoss: true
});
var SETUP_STATES = Object.freeze([
  "DETECTED",
  "WATCH",
  "QUALIFIED",
  "ENTRY_PENDING",
  "OPEN",
  "TP1_MANAGEMENT",
  "CLOSED",
  "INVALIDATED",
  "EXPIRED",
  "REJECTED"
]);
function scoreBand(score) {
  if (!Number.isFinite(score)) return "RED";
  const normalized = Math.max(0, Math.min(100, Math.floor(score)));
  return SCORE_BANDS.find((band) => normalized >= band.min && normalized <= band.max).label;
}
__name(scoreBand, "scoreBand");

// src/scalp-swing-engine.ts
function calibrateHistoricalConfidence(candidate, history, asOf = Date.now(), minimumSamples = 30) {
  const cohort = (history ?? []).filter((t) => {
    if (t.status !== "CLOSED" || !Number.isFinite(t.closedAt) || Number(t.closedAt) >= asOf || t.tradeStyle !== candidate.engine || t.model !== candidate.setupId || t.symbol !== candidate.symbol || t.side !== candidate.side) return false;
    const audit = t.audit ?? {};
    if (candidate.marketRegime === "UNAVAILABLE" || String(audit.marketRegime ?? "UNAVAILABLE") !== candidate.marketRegime || Boolean(audit.htfAligned) !== candidate.htfAligned) return false;
    const r = Number.isFinite(t.realizedR) ? Number(t.realizedR) : Number(t.initialRiskUsdt ?? t.riskUsdt) > 0 && Number.isFinite(t.pnlUsdt) ? Number(t.pnlUsdt) / Number(t.initialRiskUsdt ?? t.riskUsdt) : NaN;
    return Number.isFinite(r);
  }).map((t) => Number.isFinite(t.realizedR) ? Number(t.realizedR) : Number(t.pnlUsdt) / Number(t.initialRiskUsdt ?? t.riskUsdt));
  const sampleSize = cohort.length;
  if (sampleSize < minimumSamples) return { status: "INSUFFICIENT_DATA", confidence: null, sampleSize, winRate: null, averageR: null, profitFactor: null };
  const wins = cohort.filter((r) => r > 0), losses = cohort.filter((r) => r < 0), grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const winRate = wins.length / sampleSize * 100, averageR = cohort.reduce((a, b) => a + b, 0) / sampleSize, profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
  const confidence = (wins.length + 5) / (sampleSize + 10) * 100;
  return { status: "CALIBRATED", confidence: Number(confidence.toFixed(1)), sampleSize, winRate: Number(winRate.toFixed(1)), averageR: Number(averageR.toFixed(3)), profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)) };
}
__name(calibrateHistoricalConfidence, "calibrateHistoricalConfidence");
var valid = /* @__PURE__ */ __name((a) => Array.isArray(a) && a.length >= 20 && a.every((c, i) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.time >= 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && (c.volume === void 0 || Number.isFinite(c.volume) && c.volume >= 0) && (c.quoteVolume === void 0 || Number.isFinite(c.quoteVolume) && c.quoteVolume >= 0) && (i === 0 || c.time > a[i - 1].time)), "valid");
var last = /* @__PURE__ */ __name((a) => a[a.length - 1], "last");
var median = /* @__PURE__ */ __name((a) => {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  return x.length ? x[Math.floor(x.length / 2)] : null;
}, "median");
var hit = /* @__PURE__ */ __name((c, z) => c.low <= z.top && c.high >= z.bottom, "hit");
function isEntryConfirmed(c, side, zone, requireRetest = false) {
  if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high <= c.low) return false;
  const closeLocation = (c.close - c.low) / (c.high - c.low);
  const directional = side === "LONG" ? c.close > c.open && closeLocation >= 0.65 : c.close < c.open && closeLocation <= 0.35;
  return directional && (!requireRetest || !!zone && hit(c, zone));
}
__name(isEntryConfirmed, "isEntryConfirmed");
function equalLiquidityPool(swings, rows, kind, tf) {
  const candidates = swings.filter((x) => x.kind === kind && x.index >= Math.max(0, rows.length - 80) && x.confirmedAt < rows.length).slice(-8);
  for (let i = candidates.length - 1; i > 0; i--) {
    const anchor = candidates[i], peers = candidates.slice(0, i).filter((x) => Math.abs(x.price - anchor.price) / Math.max(anchor.price, 1e-12) <= 15e-4);
    if (peers.length) {
      const points = [...peers, anchor], level = points.reduce((sum, x) => sum + x.price, 0) / points.length, confirmedAt = Math.max(...points.map((x) => x.confirmedAt));
      return { kind: kind === "HIGH" ? "EQUAL_HIGH" : "EQUAL_LOW", side: kind === "HIGH" ? "SHORT" : "LONG", top: level, bottom: level, formedAt: rows[confirmedAt].time, sourceTimeframe: tf };
    }
  }
  return void 0;
}
__name(equalLiquidityPool, "equalLiquidityPool");
function zones(rows, tf) {
  const out = [], structure = analyzeMarketStructure(rows), breaks = new Map(structure.events.filter((e) => e.displacement).map((e) => [e.candleIndex, e])), equalHigh = equalLiquidityPool(structure.swings, rows, "HIGH", tf), equalLow = equalLiquidityPool(structure.swings, rows, "LOW", tf);
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i - 2], c = rows[i];
    if (c.low > a.high) out.push({ kind: "FVG", side: "LONG", bottom: a.high, top: c.low, formedAt: c.time, sourceTimeframe: tf });
    if (c.high < a.low) out.push({ kind: "FVG", side: "SHORT", bottom: c.high, top: a.low, formedAt: c.time, sourceTimeframe: tf });
    const base = rows.slice(Math.max(0, i - 4), i), m = median(base.map((x) => Math.abs(x.close - x.open)));
    if (m && Math.abs(c.close - c.open) > m * 1.8) {
      const bull = c.close > c.open, side = bull ? "LONG" : "SHORT", breakEvent = breaks.get(i), origin = [...base].reverse().find((x) => bull ? x.close < x.open : x.close > x.open);
      if (origin && breakEvent?.side === side && (breakEvent.type === "BOS" || breakEvent.type === "CHoCH" || breakEvent.type === "MSS" || breakEvent.type === "MSB")) out.push({ kind: "ORDER_BLOCK", side, bottom: origin.low, top: origin.high, formedAt: c.time, sourceTimeframe: tf });
    }
  }
  const orderBlocks = out.filter((z) => z.kind === "ORDER_BLOCK");
  for (const ob of orderBlocks) {
    out.push({ ...ob, kind: "SUPPLY_DEMAND" });
    const index = rows.findIndex((c) => c.time === ob.formedAt);
    if (index < 0) continue;
    const after = rows.slice(index + 1), brokenAt = after.findIndex((c) => ob.side === "LONG" ? c.close < ob.bottom : c.close > ob.top), firstMitigation = after.findIndex((c) => hit(c, ob));
    if (firstMitigation >= 0 && (brokenAt < 0 || firstMitigation < brokenAt)) out.push({ ...ob, kind: "MITIGATION", formedAt: after[firstMitigation].time });
    if (brokenAt >= 0 && after.length - brokenAt <= 30) out.push({ ...ob, kind: "BREAKER", side: ob.side === "LONG" ? "SHORT" : "LONG", formedAt: after[brokenAt].time });
  }
  if (equalHigh) out.push(equalHigh);
  if (equalLow) out.push(equalLow);
  const r = rows.slice(-40, -1), hi = Math.max(...r.map((x) => x.high)), lo = Math.min(...r.map((x) => x.low)), cl = last(rows).close;
  if (r.length >= 20 && (hi - lo) / cl <= 0.12) out.push({ kind: "RANGE", side: cl < (hi + lo) / 2 ? "LONG" : "SHORT", bottom: lo, top: hi, formedAt: last(r).time, sourceTimeframe: tf });
  return out.slice(-60);
}
__name(zones, "zones");
function classifyMarketRegime(structure, candles, timeframeZones) {
  const recentTransition = structure.events.some((event) => (event.type === "CHoCH" || event.type === "MSS") && event.candleIndex >= Math.max(0, candles.length - 3));
  if (recentTransition) return "TRANSITION";
  if (structure.trend === "LONG") return "BULLISH";
  if (structure.trend === "SHORT") return "BEARISH";
  if (timeframeZones.some((zone) => zone.kind === "RANGE")) return "RANGE";
  return "UNAVAILABLE";
}
__name(classifyMarketRegime, "classifyMarketRegime");
function volumePoints(rows, max) {
  const v = last(rows).volume, base = median(rows.slice(-21, -1).map((x) => Number(x.volume)));
  if (v === void 0 || base === null || base <= 0) return 0;
  return Math.min(max, v / base >= 1.8 ? max : v / base >= 1.2 ? Math.round(max * 0.7) : v / base >= 0.8 ? Math.round(max * 0.5) : Math.round(max * 0.2));
}
__name(volumePoints, "volumePoints");
function confirmedOteZone(side, rows, structure) {
  const swings = structure.swings.filter((x) => x.index >= 0 && x.index < rows.length && x.confirmedAt < rows.length).slice().sort((a, b) => a.index - b.index);
  if (side === "LONG") {
    const high2 = [...swings].reverse().find((x) => x.kind === "HIGH");
    if (!high2) return;
    const low2 = [...swings].reverse().find((x) => x.kind === "LOW" && x.index < high2.index);
    if (!low2 || high2.price <= low2.price) return;
    const range2 = high2.price - low2.price, top2 = high2.price - range2 * 0.62, bottom2 = high2.price - range2 * 0.79;
    return { kind: "OTE", side, top: top2, bottom: bottom2, formedAt: rows[high2.confirmedAt].time, sourceTimeframe: "4h" };
  }
  const low = [...swings].reverse().find((x) => x.kind === "LOW");
  if (!low) return;
  const high = [...swings].reverse().find((x) => x.kind === "HIGH" && x.index < low.index);
  if (!high || high.price <= low.price) return;
  const range = high.price - low.price, bottom = low.price + range * 0.62, top = low.price + range * 0.79;
  return { kind: "OTE", side, top, bottom, formedAt: rows[low.confirmedAt].time, sourceTimeframe: "4h" };
}
__name(confirmedOteZone, "confirmedOteZone");
function evaluatePattern(id, side, rows, st, z, htfStructure, htfRows, dailyRows) {
  const c = last(rows), p = rows.slice(-21, -1), hi = Math.max(...p.map((x) => x.high)), lo = Math.min(...p.map((x) => x.low)), equalHigh = z.find((x) => x.kind === "EQUAL_HIGH"), equalLow = z.find((x) => x.kind === "EQUAL_LOW");
  const sweep = side === "LONG" ? c.low < lo && c.close > lo || !!equalLow && c.low < equalLow.bottom && c.close > equalLow.top : c.high > hi && c.close < hi || !!equalHigh && c.high > equalHigh.top && c.close < equalHigh.bottom;
  const ev = [...st.events].reverse().find((x) => x.side === side && x.candleIndex >= rows.length - 4);
  const fvg = [...z].reverse().find((x) => x.kind === "FVG" && x.side === side && x.formedAt >= rows[rows.length - 8].time);
  const breaker = [...z].reverse().find((x) => x.kind === "BREAKER" && x.side === side && (id !== "W04_BREAKER_RETEST" || x.sourceTimeframe === "4h")), ob = [...z].reverse().find((x) => (x.kind === "ORDER_BLOCK" || x.kind === "MITIGATION") && x.side === side), htfOb = [...z].reverse().find((x) => x.kind === "ORDER_BLOCK" && x.side === side && x.sourceTimeframe === "4h"), supplyDemand = [...z].reverse().find((x) => x.kind === "SUPPLY_DEMAND" && x.side === side && x.sourceTimeframe === "4h"), range = z.find((x) => x.kind === "RANGE");
  const retest = /* @__PURE__ */ __name((x) => !!x && hit(c, x), "retest");
  switch (id) {
    case "S01_SWEEP_MSS_FVG":
      return { ok: sweep && ev?.type === "MSS" && !!fvg, zone: fvg, reason: "Sweep + MSS + FVG", liquiditySweep: sweep };
    case "W03_SWEEP_CHOCH":
      return { ok: sweep && (ev?.type === "CHoCH" || ev?.type === "MSS") && !!fvg, zone: fvg, reason: "Turtle Soup / Sweep + CHoCH + FVG", liquiditySweep: sweep };
    case "S02_BREAKER_RETEST":
    case "W04_BREAKER_RETEST":
      return { ok: retest(breaker), zone: breaker, reason: "Invalidated order block converted to breaker and retested" };
    case "S03_BOS_DISPLACEMENT":
    case "W08_BOS_CONTINUATION":
      return { ok: !!ev && (ev.type === "BOS" || ev.type === "MSB") && ev.displacement, zone: fvg, reason: "Close-confirmed BOS/MSB + displacement" };
    case "S04_RANGE_DEVIATION":
    case "W05_RANGE_DEVIATION":
      return { ok: !!range && sweep, zone: range, reason: "Range deviation and reclaim", liquiditySweep: sweep };
    case "S05_FAILED_BREAKOUT":
      return { ok: sweep && !!ev, zone: range, reason: "Failed breakout reclaim", liquiditySweep: sweep };
    case "S06_OB_REACTION":
      return { ok: retest(ob) && (side === "LONG" ? c.close > c.open : c.close < c.open), zone: ob, reason: "Order-block reaction" };
    case "W01_HTF_OB_REVERSAL":
      return { ok: retest(htfOb) && (side === "LONG" ? c.close > c.open : c.close < c.open), zone: htfOb, reason: "4H order-block reversal reaction" };
    case "W02_SUPPLY_DEMAND_REVERSAL":
      return { ok: retest(supplyDemand) && (side === "LONG" ? c.close > c.open : c.close < c.open), zone: supplyDemand, reason: "4H supply/demand reaction" };
    case "W06_CRT": {
      const reference = [...dailyRows ?? []].filter((x) => x.time + 864e5 <= c.time).at(-1);
      if (!reference) return { ok: false, reason: "CRT_REFERENCE_DAILY_CANDLE_UNAVAILABLE" };
      const crtRange = { kind: "RANGE", side, bottom: reference.low, top: reference.high, formedAt: reference.time + 864e5, sourceTimeframe: "1d" }, crtSweep = side === "LONG" ? c.low < reference.low && c.close > reference.low : c.high > reference.high && c.close < reference.high;
      return { ok: crtSweep && !!ev && (ev.type === "CHoCH" || ev.type === "MSS") && ev.displacement, zone: crtRange, reason: "Daily CRT range raid, reclaim and structural shift", liquiditySweep: crtSweep };
    }
    case "W07_OTE": {
      if (!htfStructure || !htfRows) return { ok: false, reason: "OTE_IMPULSE_UNAVAILABLE" };
      const ote = confirmedOteZone(side, htfRows, htfStructure);
      if (!ote) return { ok: false, reason: "OTE_IMPULSE_UNAVAILABLE" };
      return { ok: hit(c, ote), zone: ote, reason: "Confirmed 4H impulse 62\u201379% ICT OTE retracement" };
    }
    default:
      return { ok: false, reason: "Unknown setup" };
  }
}
__name(evaluatePattern, "evaluatePattern");
function makeSetup(engine, id, symbol, side, entryRows, setupRows, st, z, htfTrend, btcBias, reason, history, marketRegime, liquiditySweep) {
  const c = last(entryRows), w = setupRows.slice(-12), lo = Math.min(...w.map((x) => x.low)), hi = Math.max(...w.map((x) => x.high));
  const stop = side === "LONG" ? Math.min(lo, z?.bottom ?? lo) : Math.max(hi, z?.top ?? hi);
  if (!Number.isFinite(stop) || stop <= 0 || (side === "LONG" ? stop >= c.close : stop <= c.close)) return null;
  const risk = Math.abs(c.close - stop), weights = ENGINE_CONFIG[engine].scoreWeights, ev = st.events.at(-1), htfAligned = htfTrend === side, btcSide = btcBias === "BULLISH" ? "LONG" : btcBias === "BEARISH" ? "SHORT" : null, btcOpposing = btcSide !== null && btcSide !== side, htfOpposing = htfTrend !== "NEUTRAL" && !htfAligned, countertrend = htfOpposing || btcOpposing, btcContextStatus = btcBias === "UNAVAILABLE" ? "UNAVAILABLE" : btcBias === "NEUTRAL" ? "MIXED" : btcOpposing ? "OPPOSING" : "ALIGNED", confidenceStats = calibrateHistoricalConfidence({ engine, symbol, setupId: id, side, marketRegime, htfAligned }, history, c.time);
  const zoneQuality = z ? z.kind === "FVG" || z.kind === "BREAKER" || z.kind === "ORDER_BLOCK" || z.kind === "OTE" ? 1 : z.kind === "SUPPLY_DEMAND" ? 0.9 : 0.8 : 0, points = { htf: htfTrend === side ? btcOpposing ? Math.round(weights.htf * 0.6) : weights.htf : htfTrend === "NEUTRAL" ? Math.round(weights.htf * 0.7) : Math.round(weights.htf * 0.35), liquidity: liquiditySweep ? weights.liquidity : 0, marketStructure: ev?.side === side ? ev.displacement ? weights.marketStructure : Math.round(weights.marketStructure * 0.65) : 0, zone: Math.round(weights.zone * zoneQuality), entryConfirmation: weights.entryConfirmation, volume: volumePoints(entryRows, weights.volume) };
  const score = Object.values(points).reduce((a, b) => a + b, 0), band = scoreBand(score), tf = engine === "SCALP" ? "5m" : "1h", etf = engine === "SCALP" ? "5m" : "15m", riskMultiplier = countertrend || !htfAligned || score < 80 ? 0.5 : 1, status = countertrend ? score >= 84 ? "READY" : score >= 70 ? "WATCH" : score >= 60 ? "WAIT" : "REJECTED" : score >= 70 ? "READY" : score >= 65 ? "WATCH" : score >= 60 ? "WAIT" : "REJECTED", tp1 = c.close + (side === "LONG" ? 1 : -1) * risk, tp2 = c.close + (side === "LONG" ? 2 : -2) * risk, tp3 = c.close + (side === "LONG" ? 3.5 : -3.5) * risk;
  return { symbol, side, model: id, tradeStyle: engine, entryTimeframe: etf, setupTimeframe: tf, setupCandleTime: c.time, score, scoreBreakdown: points, entry: c.close, stopLoss: stop, takeProfit: tp3, tp1, tp2, tp3, riskReward: 3.5, confidence: confidenceStats.confidence, confidenceStatus: confidenceStats.status, confidenceSampleSize: confidenceStats.sampleSize, confidenceWinRate: confidenceStats.winRate, confidenceAverageR: confidenceStats.averageR, confidenceProfitFactor: confidenceStats.profitFactor, reason: id + ": " + reason + "; " + band + "; BTC " + btcContextStatus, candleTime: c.time, status, riskMultiplier, btcContextStatus, confirmations: [id, "CLOSED_CANDLE_CONFIRMATION", ...z ? [z.kind] : [], ...ev ? [ev.type] : []], audit: { engine, setupId: id, scoreBand: band, riskPercent: riskMultiplier * 2, confidence: confidenceStats.confidence, confidenceStatus: confidenceStats.status, confidenceSampleSize: confidenceStats.sampleSize, confidenceWinRate: confidenceStats.winRate, confidenceAverageR: confidenceStats.averageR, confidenceProfitFactor: confidenceStats.profitFactor, marketRegime, htfAligned, htfTrend, btcBias, countertrend, structureTrend: st.trend, structureEvent: ev ?? null, zone: z ?? null, closedCandleOnly: true, volume: c.volume === void 0 ? "UNAVAILABLE" : "AVAILABLE", funding: latestFundingSnapshots.has(symbol) ? "AVAILABLE" : "UNAVAILABLE", fundingRate: latestFundingSnapshots.get(symbol)?.rate ?? null, fundingNextTime: latestFundingSnapshots.get(symbol)?.nextFundingTime ?? null, openInterest: "UNAVAILABLE", btcDominance: "UNAVAILABLE", altcoinDominance: "UNAVAILABLE", usdtDominance: "UNAVAILABLE", aggressorFlow: "UNAVAILABLE" } };
}
__name(makeSetup, "makeSetup");
function requiresHtfDirectionalAlignment(id) {
  return id === "S02_BREAKER_RETEST" || id === "S03_BOS_DISPLACEMENT" || id === "W04_BREAKER_RETEST" || id === "W08_BOS_CONTINUATION";
}
__name(requiresHtfDirectionalAlignment, "requiresHtfDirectionalAlignment");
function evaluateEngine(engine, symbol, input, btcBias = "UNAVAILABLE", history = []) {
  const directionTf = engine === "SCALP" ? "1h" : "1d", zoneTf = engine === "SCALP" ? "15m" : "4h", setupTf = engine === "SCALP" ? "5m" : "1h", entryTf = engine === "SCALP" ? "5m" : "15m";
  const frames = [.../* @__PURE__ */ new Set([directionTf, zoneTf, setupTf, entryTf])], unavailable = frames.filter((tf) => !valid(input[tf]) || input[tf].length < (tf === "1d" ? 60 : 20));
  const structure = {}, allZones = [];
  for (const tf of frames) {
    const rows = input[tf];
    if (valid(rows)) {
      structure[tf] = analyzeMarketStructure(rows);
      allZones.push(...zones(rows, tf));
    }
  }
  const setups = [], diagnostics = [];
  if (unavailable.length) return { engine, symbol, setups, diagnostics, structure, zones: allZones, unavailable };
  const direction = structure[directionTf].trend, setupRows = input[setupTf], entryRows = input[entryTf], z = allZones.filter((x) => x.sourceTimeframe === zoneTf || x.sourceTimeframe === setupTf), ids = ENGINE_CONFIG[engine].setups;
  for (const side of ["LONG", "SHORT"]) for (const id of ids) {
    const sig = evaluatePattern(id, side, setupRows, structure[setupTf], z, engine === "SWING" ? structure[zoneTf] : void 0, engine === "SWING" ? input[zoneTf] : void 0, engine === "SWING" ? input["1d"] : void 0);
    if (!sig.ok) continue;
    if (requiresHtfDirectionalAlignment(id) && direction !== side) {
      diagnostics.push({ setupId: id, side, score: 0, band: "RED", reason: direction === "NEUTRAL" ? "HTF_DIRECTION_UNCLEAR" : "HTF_DIRECTION_OPPOSING" });
      continue;
    }
    const retestRequired = (/* @__PURE__ */ new Set(["S01_SWEEP_MSS_FVG", "S02_BREAKER_RETEST", "S04_RANGE_DEVIATION", "S06_OB_REACTION", "W01_HTF_OB_REVERSAL", "W02_SUPPLY_DEMAND_REVERSAL", "W03_SWEEP_CHOCH", "W04_BREAKER_RETEST", "W05_RANGE_DEVIATION", "W07_OTE"])).has(id);
    if (!isEntryConfirmed(last(entryRows), side, sig.zone, retestRequired)) {
      diagnostics.push({ setupId: id, side, score: 0, band: "RED", reason: retestRequired ? "ENTRY_RETEST_NOT_CONFIRMED" : "ENTRY_CLOSE_NOT_CONFIRMED" });
      continue;
    }
    const observedRegime = classifyMarketRegime(structure[directionTf], input[directionTf], allZones.filter((x) => x.sourceTimeframe === directionTf));
    const candidate = makeSetup(engine, id, symbol, side, entryRows, setupRows, structure[setupTf], sig.zone, direction, btcBias, sig.reason, history, observedRegime, sig.liquiditySweep === true);
    if (!candidate) {
      diagnostics.push({ setupId: id, side, score: 0, band: "RED", reason: "INVALID_STRUCTURAL_STOP" });
      continue;
    }
    setups.push(candidate);
    diagnostics.push({ setupId: id, side, score: candidate.score, band: scoreBand(candidate.score), reason: sig.reason });
  }
  return { engine, symbol, setups, diagnostics, structure, zones: allZones, unavailable };
}
__name(evaluateEngine, "evaluateEngine");

// src/bingx-demo.ts
var MIN_LEVERAGE = 20;
var RISKY_MIN_LEVERAGE = 5;
var RISKY_MAX_LEVERAGE = 10;
function nextLowerBingXLeverage(current, minimumLeverage = MIN_LEVERAGE) {
  const floor = Math.max(1, Math.floor(minimumLeverage));
  if (!Number.isFinite(current) || current <= floor) return null;
  return Math.max(floor, Math.floor(current / 2));
}
__name(nextLowerBingXLeverage, "nextLowerBingXLeverage");
var DEMO_BASE = "https://open-api-vst.bingx.com";
var MAKER_FEE_RATE = 2e-4;
var FEE_RATE = 5e-4;
var SLIPPAGE_RATE = 2e-4;
var MAX_LEVERAGE = 50;
var validSymbol = /^[A-Z0-9]{2,20}-USDT$/;
function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
__name(number, "number");
function asArray(value) {
  return Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
}
__name(asArray, "asArray");
function dataObject(value) {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] : {};
  return value && typeof value === "object" ? value : {};
}
__name(dataObject, "dataObject");
function nestedRecordArray(value, keys, isRecord) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!value || typeof value !== "object") return [];
  const row = value;
  for (const key of keys) if (Array.isArray(row[key])) return row[key].filter((item) => item && typeof item === "object" && !Array.isArray(item));
  return isRecord(row) ? [row] : [];
}
__name(nestedRecordArray, "nestedRecordArray");
function asBingXDemoOrders(value) {
  return nestedRecordArray(value, ["orders", "list", "data", "result"], (row) => typeof row.symbol === "string" && (row.orderID != null || row.orderId != null || row.clientOrderId != null || row.clientOrderID != null || row.type != null)).map((order) => ({ ...order, clientOrderId: String(order.clientOrderId ?? order.clientOrderID ?? "") || void 0 }));
}
__name(asBingXDemoOrders, "asBingXDemoOrders");
function asBingXDemoPositions(value) {
  return nestedRecordArray(value, ["positions", "list", "data", "result"], (row) => typeof row.symbol === "string" && row.positionAmt != null).map((position) => ({
    ...position,
    isolated: position.isolated == null && !String(position.marginType ?? "").trim() ? void 0 : position.isolated === true || String(position.isolated).toLowerCase() === "true" || String(position.marginType ?? "").toUpperCase() === "ISOLATED",
    marginType: String(position.marginType ?? "").toUpperCase() || void 0
  }));
}
__name(asBingXDemoPositions, "asBingXDemoPositions");
function normalizeBingXDemoBalance(value) {
  const findRows = /* @__PURE__ */ __name((input, depth = 0) => {
    if (depth > 4 || input == null) return [];
    if (Array.isArray(input)) return input.filter((row2) => row2 && typeof row2 === "object" && !Array.isArray(row2));
    if (typeof input !== "object") return [];
    const row = input;
    if (row.asset != null && (row.balance != null || row.equity != null)) return [row];
    for (const key of ["balance", "balances", "list", "data", "result"]) {
      if (row[key] != null) {
        const found = findRows(row[key], depth + 1);
        if (found.length) return found;
      }
    }
    return [];
  }, "findRows");
  const rows = findRows(value);
  const raw = rows.find((row) => String(row.asset ?? "").toUpperCase() === "USDT") ?? rows[0];
  if (!raw) return null;
  const balance = number(raw.balance, NaN);
  if (!Number.isFinite(balance)) return null;
  return {
    asset: String(raw.asset ?? "USDT"),
    balance,
    equity: number(raw.equity, balance),
    unrealizedProfit: number(raw.unrealizedProfit),
    realisedProfit: raw.realisedProfit == null && raw.realizedProfit == null ? null : number(raw.realisedProfit ?? raw.realizedProfit),
    availableMargin: number(raw.availableMargin, number(raw.availableBalance, number(raw.maxWithdrawAmount))),
    usedMargin: number(raw.usedMargin, number(raw.initialMargin)),
    freezedMargin: number(raw.freezedMargin, number(raw.frozenMargin))
  };
}
__name(normalizeBingXDemoBalance, "normalizeBingXDemoBalance");
async function hmacSha256Hex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(hmacSha256Hex, "hmacSha256Hex");
function encodeSignedParams(params) {
  return Object.keys(params).sort().map((key) => {
    const value = String(params[key]);
    return key + "=" + (/[{}[\]]/.test(value) ? encodeURIComponent(value) : value);
  }).join("&");
}
__name(encodeSignedParams, "encodeSignedParams");
var nextDemoRequestAt = 0;
async function waitForDemoRateLimit() {
  const now = Date.now();
  const wait = Math.max(0, nextDemoRequestAt - now);
  nextDemoRequestAt = Math.max(now, nextDemoRequestAt) + 500;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
__name(waitForDemoRateLimit, "waitForDemoRateLimit");
async function demoSnapshotRequest(apiKey, apiSecret, path) {
  try {
    return await demoRequest(apiKey, apiSecret, "GET", path);
  } catch (error) {
    const message = String(error);
    if (!/(HTTP 429|HTTP 5\d\d|fetch failed|timeout|timed out|network error)/i.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return demoRequest(apiKey, apiSecret, "GET", path);
  }
}
__name(demoSnapshotRequest, "demoSnapshotRequest");
async function demoRequest(apiKey, apiSecret, method, path, params = {}, allowNonJsonSuccess = false) {
  if (!apiKey.trim() || !apiSecret.trim()) throw new Error("BingX demo API credentials are missing.");
  await waitForDemoRateLimit();
  const allParams = { ...params, recvWindow: 5e3, timestamp: Date.now() };
  for (const [key, value] of Object.entries(allParams)) {
    const raw2 = String(value);
    if (/[&=?#\r\n]/.test(raw2) && !/[{}[\]]/.test(raw2)) {
      throw new Error("Invalid BingX request parameter: " + key);
    }
  }
  const canonical = Object.keys(allParams).sort().map((key) => key + "=" + String(allParams[key])).join("&");
  const signature = await hmacSha256Hex(apiSecret, canonical);
  const query = encodeSignedParams(allParams) + "&signature=" + signature;
  const formBody = canonical + "&signature=" + signature;
  const url = method === "GET" || method === "DELETE" ? DEMO_BASE + path + "?" + query : DEMO_BASE + path;
  const response = await fetch(url, {
    method,
    headers: {
      "X-BX-APIKEY": apiKey,
      "X-SOURCE-KEY": "BX-AI-SKILL",
      ...method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
      accept: "application/json"
    },
    ...method === "POST" ? { body: formBody } : {},
    signal: AbortSignal.timeout(12e3),
    cache: "no-store"
  });
  const raw = await response.text();
  let payload;
  try {
    const safeJson = raw.replace(/(:\s*|,\s*|\[\s*)(-?\d{16,})(?=\s*[,}\]])/g, (_match, prefix, id) => prefix + '"' + id + '"');
    payload = JSON.parse(safeJson);
  } catch {
    if (allowNonJsonSuccess && response.ok) return void 0;
    throw new Error("BingX demo returned a non-JSON response (HTTP " + response.status + ").");
  }
  if (!response.ok || payload.code !== 0) {
    throw new Error("BingX demo error " + String(payload.code ?? response.status) + " at " + method + " " + path + (params.type ? " type=" + String(params.type) : "") + ": " + String(payload.msg ?? raw).slice(0, 220));
  }
  return payload.data;
}
__name(demoRequest, "demoRequest");
function isBingXDemoConfigured(env) {
  return env.BINGX_TRADING_MODE === "demo" && env.DEMO_TRADING_ENABLED === "true" && env.PAPER_TRADING_ONLY === "true" && env.LIVE_TRADING_ENABLED !== "true" && !!env.BINGX_API_KEY && !!env.BINGX_API_SECRET;
}
__name(isBingXDemoConfigured, "isBingXDemoConfigured");
async function getBingXDemoClosedFills(apiKey, apiSecret) {
  const endTs = Date.now();
  const startTs = endTs - 90 * 24 * 60 * 60 * 1e3;
  const data = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/allFillOrders", {
    tradingUnit: "CONT",
    startTs,
    endTs,
    currency: "USDT"
  });
  return nestedRecordArray(data, ["list", "fills", "orders", "data", "result"], (row) => typeof row.symbol === "string" && row.price != null && row.qty != null && row.realizedPnl != null && row.time != null).filter((fill) => typeof fill.symbol === "string" && Number.isFinite(Number(fill.realizedPnl)) && Number.isFinite(Number(fill.price)) && Number.isFinite(Number(fill.qty)));
}
__name(getBingXDemoClosedFills, "getBingXDemoClosedFills");
function historicalOrderId(order) {
  const value = order.orderID ?? order.orderId;
  return value == null ? null : String(value);
}
__name(historicalOrderId, "historicalOrderId");
async function getBingXDemoOrderHistory(apiKey, apiSecret) {
  const now = Date.now(), windowMs = 7 * 24 * 60 * 60 * 1e3, start = now - windowMs;
  const byId = /* @__PURE__ */ new Map();
  for (let from = start; from < now; from += windowMs) {
    const end = Math.min(now, from + windowMs - 1);
    let cursor;
    for (let page = 0; page < 20; page++) {
      const params = { startTime: from, endTime: end, limit: 1e3, currency: "USDT" };
      if (cursor) params.orderId = cursor;
      const data = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/allOrders", params);
      const rows = nestedRecordArray(data, ["list", "orders", "data", "result"], (row) => (row.orderID != null || row.orderId != null) && typeof row.symbol === "string").filter((order) => historicalOrderId(order) !== null && typeof order.symbol === "string");
      for (const order of rows) byId.set(String(historicalOrderId(order)), order);
      if (rows.length < 1e3) break;
      const next = historicalOrderId(rows[rows.length - 1]);
      if (!next || next === cursor) break;
      cursor = next;
    }
  }
  return [...byId.values()];
}
__name(getBingXDemoOrderHistory, "getBingXDemoOrderHistory");
async function getBingXDemoPositions(apiKey, apiSecret) {
  const data = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/user/positions");
  return asBingXDemoPositions(data).filter((position) => Math.abs(number(position.positionAmt)) > 0);
}
__name(getBingXDemoPositions, "getBingXDemoPositions");
async function getBingXDemoOpenOrders(apiKey, apiSecret, knownSymbols = []) {
  try {
    return asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders"));
  } catch (error) {
    if (!/110206|TP\/SL orders has exceeded the limit/i.test(String(error))) throw error;
    const orders = [];
    for (const symbol of [...new Set(knownSymbols.filter((value) => validSymbol.test(value)))].sort()) {
      try {
        const rows = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol }));
        for (const order of rows) {
          const id = String(order.orderID ?? order.orderId ?? order.clientOrderId ?? order.clientOrderID ?? "");
          if (!id || !orders.some((existing) => String(existing.orderID ?? existing.orderId ?? existing.clientOrderId ?? existing.clientOrderID ?? "") === id)) orders.push(order);
        }
      } catch (orderError) {
        console.warn("BingX VST per-symbol open-order read failed", symbol, String(orderError).slice(0, 120));
      }
    }
    return orders;
  }
}
__name(getBingXDemoOpenOrders, "getBingXDemoOpenOrders");
async function getBingXDemoSnapshot(apiKey, apiSecret, knownSymbols = []) {
  const now = Date.now();
  const utcDayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const [balanceData, positionsData, modeData] = await Promise.all([
    demoSnapshotRequest(apiKey, apiSecret, "/openApi/swap/v3/user/balance"),
    demoSnapshotRequest(apiKey, apiSecret, "/openApi/swap/v2/user/positions"),
    demoSnapshotRequest(apiKey, apiSecret, "/openApi/swap/v1/positionSide/dual")
  ]);
  const positions = asBingXDemoPositions(positionsData).filter((p) => Math.abs(number(p.positionAmt)) > 0);
  let openOrders = [];
  let openOrdersComplete = true;
  try {
    openOrders = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders"));
  } catch (error) {
    if (!/110206|TP\/SL orders has exceeded the limit/i.test(String(error))) throw error;
    openOrdersComplete = false;
    const symbols = [.../* @__PURE__ */ new Set([...positions.map((position) => position.symbol), ...knownSymbols.filter((symbol) => validSymbol.test(symbol))])].sort();
    for (const symbol of symbols) {
      const rows = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol }));
      for (const order of rows) {
        const id = String(order.orderID ?? order.orderId ?? order.clientOrderId ?? order.clientOrderID ?? "");
        if (!id || !openOrders.some((existing) => String(existing.orderID ?? existing.orderId ?? existing.clientOrderId ?? existing.clientOrderID ?? "") === id)) openOrders.push(order);
      }
    }
    console.warn("BingX account-wide openOrders exceeded TP/SL slot limit; live-position and tracked-symbol books recovered for protection cleanup; new entries blocked", JSON.stringify({ symbols: symbols.length, orders: openOrders.length }));
  }
  let incomeData = [];
  let dailyIncomeAvailable = true;
  try {
    incomeData = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/user/income", { startTime: utcDayStart, endTime: now, limit: 1e3 });
  } catch {
    dailyIncomeAvailable = false;
  }
  const balance = normalizeBingXDemoBalance(balanceData);
  const mode = dataObject(modeData);
  return {
    mode: "bingx-demo",
    baseUrl: DEMO_BASE,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    balance,
    positions,
    openOrders,
    openOrdersComplete,
    dailyIncome: asArray(incomeData),
    dailyIncomeAvailable,
    hedgeMode: mode.dualSidePosition === true || mode.dualSidePosition === "true"
  };
}
__name(getBingXDemoSnapshot, "getBingXDemoSnapshot");
async function placeOrder(apiKey, apiSecret, params) {
  return dataObject(await demoRequest(apiKey, apiSecret, "POST", "/openApi/swap/v2/trade/order", params));
}
__name(placeOrder, "placeOrder");
function orderId(order, depth = 0) {
  const value = order.orderID ?? order.orderId;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (depth < 3) for (const key of ["order", "data", "result"]) {
    const nested = order[key];
    if (nested && typeof nested === "object") {
      const found = Array.isArray(nested) ? nested.map((item) => item && typeof item === "object" ? orderId(item, depth + 1) : null).find(Boolean) ?? null : orderId(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
__name(orderId, "orderId");
function protectiveClientOrderId(meta, kind) {
  const symbol = meta.symbol.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14);
  const nonce = Date.now().toString(36) + Math.floor(Math.random() * 16777215).toString(36);
  return ("smc-" + kind + "-" + symbol + "-" + nonce).slice(0, 40);
}
__name(protectiveClientOrderId, "protectiveClientOrderId");
async function resolveProtectiveOrderId(apiKey, apiSecret, symbol, clientOrderId, response) {
  const direct = orderId(response);
  if (direct) return direct;
  try {
    const detail = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/order", { symbol, clientOrderId });
    const found = orderId(dataObject(detail));
    if (found) return found;
  } catch {
  }
  try {
    const openOrders = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol });
    const match = asBingXDemoOrders(openOrders).find((order) => order.clientOrderId === clientOrderId);
    if (match) return orderId(match);
  } catch {
  }
  return null;
}
__name(resolveProtectiveOrderId, "resolveProtectiveOrderId");
function roundDown(value, precision) {
  const scale = 10 ** Math.max(0, Math.min(12, Math.floor(precision)));
  return Math.floor(value * scale + 1e-10) / scale;
}
__name(roundDown, "roundDown");
async function contractQuantityPrecision(symbol) {
  try {
    await waitForDemoRateLimit();
    const response = await fetch(DEMO_BASE + "/openApi/swap/v2/quote/contracts?symbol=" + encodeURIComponent(symbol), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(8e3),
      cache: "no-store"
    });
    if (!response.ok) return 8;
    const payload = await response.json();
    if (payload.code !== 0) return 8;
    return Math.max(0, Math.min(12, Math.floor(number(dataObject(payload.data).quantityPrecision, 8))));
  } catch {
    return 8;
  }
}
__name(contractQuantityPrecision, "contractQuantityPrecision");
function closeSide(side) {
  return side === "LONG" ? "SELL" : "BUY";
}
__name(closeSide, "closeSide");
function positionSide(side, hedgeMode) {
  return hedgeMode ? side : "BOTH";
}
__name(positionSide, "positionSide");
function commonCloseParams(meta) {
  return {
    symbol: meta.symbol,
    side: closeSide(meta.side),
    positionSide: meta.positionSide,
    ...!meta.hedgeMode ? { reduceOnly: "true" } : {}
  };
}
__name(commonCloseParams, "commonCloseParams");
async function placeStop(apiKey, apiSecret, meta, quantity, stopPrice) {
  const clientOrderId = protectiveClientOrderId(meta, "sl");
  const result = await placeOrder(apiKey, apiSecret, {
    symbol: meta.symbol,
    side: closeSide(meta.side),
    positionSide: meta.positionSide,
    type: "STOP_MARKET",
    quantity,
    stopPrice,
    workingType: "MARK_PRICE",
    closePosition: "true",
    clientOrderId
  });
  return resolveProtectiveOrderId(apiKey, apiSecret, meta.symbol, clientOrderId, result);
}
__name(placeStop, "placeStop");
async function placeTakeProfit(apiKey, apiSecret, meta, quantity, stopPrice, kind = "tp2") {
  const clientOrderId = protectiveClientOrderId(meta, kind);
  const result = await placeOrder(apiKey, apiSecret, {
    ...commonCloseParams(meta),
    type: "TAKE_PROFIT_MARKET",
    quantity,
    stopPrice,
    workingType: "MARK_PRICE",
    clientOrderId
  });
  return resolveProtectiveOrderId(apiKey, apiSecret, meta.symbol, clientOrderId, result);
}
__name(placeTakeProfit, "placeTakeProfit");
function findPositionStopOrder(snapshot, meta) {
  return snapshot.openOrders.find((order) => {
    const orderPositionSide = String(order.positionSide ?? "").toUpperCase();
    return String(order.symbol).toUpperCase() === meta.symbol.toUpperCase() && String(order.type).toUpperCase() === "STOP_MARKET" && String(order.side).toUpperCase() === closeSide(meta.side) && (!orderPositionSide || orderPositionSide === "BOTH" || orderPositionSide === meta.positionSide);
  }) ?? null;
}
__name(findPositionStopOrder, "findPositionStopOrder");
async function ensurePositionStop(apiKey, apiSecret, snapshot, meta, quantity, stopPrice) {
  const existing = findPositionStopOrder(snapshot, meta);
  const existingId = existing ? orderId(existing) : null;
  const existingPrice = existing ? number(existing.stopPrice, NaN) : NaN;
  const tolerance = Math.max(1e-8, Math.abs(stopPrice) * 1e-6);
  if (existingId && Number.isFinite(existingPrice) && Math.abs(existingPrice - stopPrice) <= tolerance) return existingId;
  if (existing) {
    if (!existingId || !Number.isFinite(existingPrice) || existingPrice <= 0) {
      throw new Error("An existing BingX position stop was found but its ID or trigger price could not be verified; it was left untouched.");
    }
    await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, existingId);
  }
  try {
    const replacementId = await placeStop(apiKey, apiSecret, meta, quantity, stopPrice);
    if (!replacementId) throw new Error("BingX did not return the position stop-order ID.");
    return replacementId;
  } catch (error) {
    const message = String(error);
    if (/110406|Position SL order already exists/i.test(message)) {
      const fresh = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol: meta.symbol });
      const recovered = findPositionStopOrder({ ...snapshot, openOrders: asBingXDemoOrders(fresh) }, meta);
      const recoveredId = recovered ? orderId(recovered) : null;
      const recoveredPrice = recovered ? number(recovered.stopPrice, NaN) : NaN;
      if (recoveredId && Number.isFinite(recoveredPrice) && Math.abs(recoveredPrice - stopPrice) <= tolerance) return recoveredId;
    }
    if (existing) {
      try {
        const restoredId = await placeStop(apiKey, apiSecret, meta, quantity, existingPrice);
        if (!restoredId) throw new Error("BingX did not return the restored stop-order ID.");
      } catch (restoreError) {
        throw new Error("Replacement stop failed and the previous stop could not be restored; position protection requires immediate review. " + String(restoreError).slice(0, 160));
      }
    }
    throw error;
  }
}
__name(ensurePositionStop, "ensurePositionStop");
function isBingXDemoOrderNotFoundError(error) {
  return /109400|order.{0,40}(not exist|does not exist|not found)/i.test(String(error));
}
__name(isBingXDemoOrderNotFoundError, "isBingXDemoOrderNotFoundError");
async function cancelBingXDemoOrder(apiKey, apiSecret, symbol, id) {
  if (!validSymbol.test(symbol) || !id) return;
  try {
    await demoRequest(apiKey, apiSecret, "DELETE", "/openApi/swap/v2/trade/order", { symbol, orderId: id });
  } catch (error) {
    if (!isBingXDemoOrderNotFoundError(error)) throw error;
    const openOrders = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol }));
    if (openOrders.some((order) => String(order.orderID ?? order.orderId ?? "") === String(id))) throw error;
  }
}
__name(cancelBingXDemoOrder, "cancelBingXDemoOrder");
var nextDemoCancelAt = 0;
async function waitForDemoCancelRateLimit() {
  const now = Date.now(), wait = Math.max(0, nextDemoCancelAt - now);
  nextDemoCancelAt = Math.max(now, nextDemoCancelAt) + 1e3;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
__name(waitForDemoCancelRateLimit, "waitForDemoCancelRateLimit");
async function cancelBingXDemoOrders(apiKey, apiSecret, symbol, ids) {
  if (!validSymbol.test(symbol)) return;
  const unique = [...new Set(ids.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 10) {
    const orderIdList = unique.slice(offset, offset + 10);
    await waitForDemoCancelRateLimit();
    try {
      await demoRequest(apiKey, apiSecret, "DELETE", "/openApi/swap/v2/trade/batchOrders", { symbol, orderIdList: JSON.stringify(orderIdList) });
    } catch (error) {
      if (!String(error).includes("109201") && !String(error).includes("109400")) throw error;
      for (const id of orderIdList) {
        await waitForDemoCancelRateLimit();
        await cancelBingXDemoOrder(apiKey, apiSecret, symbol, id);
      }
    }
  }
}
__name(cancelBingXDemoOrders, "cancelBingXDemoOrders");
async function closeBingXDemoPosition(apiKey, apiSecret, position, hedgeMode, fraction = 1, meta) {
  if (!validSymbol.test(position.symbol) || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error("Invalid BingX demo close request.");
  }
  const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && number(position.positionAmt) < 0 ? "SHORT" : "LONG";
  const previousStopOrderId = meta?.stopOrderId ?? null;
  if (meta) {
    const tpOrderIds = [meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId].filter((id) => !!id);
    for (const id of tpOrderIds) try {
      await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
    } catch {
    }
    if (tpOrderIds.length) {
      const remainingOrders = await getBingXDemoOpenOrders(apiKey, apiSecret, [meta.symbol]);
      const stillOpen = new Set(remainingOrders.map((order) => String(order.orderId ?? order.orderID ?? "")).filter(Boolean));
      const remainingTpIds = tpOrderIds.filter((id) => stillOpen.has(id));
      if (remainingTpIds.length) {
        meta.tp1OrderId = remainingTpIds.includes(String(meta.tp1OrderId ?? "")) ? meta.tp1OrderId : null;
        meta.tp2OrderId = remainingTpIds.includes(String(meta.tp2OrderId ?? "")) ? meta.tp2OrderId : null;
        meta.tp3OrderId = remainingTpIds.includes(String(meta.tp3OrderId ?? "")) ? meta.tp3OrderId : null;
        meta.tp4OrderId = remainingTpIds.includes(String(meta.tp4OrderId ?? "")) ? meta.tp4OrderId : null;
        throw new Error("BingX TP cancellation was not confirmed; no manual close order was submitted to avoid duplicate close quantity.");
      }
    }
    meta.tp1OrderId = null;
    meta.tp2OrderId = null;
    meta.tp3OrderId = null;
    meta.tp4OrderId = null;
  }
  const precision = await contractQuantityPrecision(position.symbol);
  let current = position;
  try {
    const fresh = await getBingXDemoPositions(apiKey, apiSecret);
    current = fresh.find((item) => item.symbol === position.symbol && (item.positionSide === position.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG"))) ?? position;
  } catch {
    current = position;
  }
  const currentQty = Math.abs(number(current.positionAmt));
  const available = number(current.availableAmt);
  const qty = roundDown(currentQty * fraction, precision);
  const restoreTargets = /* @__PURE__ */ __name(async (targetQty) => {
    if (!meta || targetQty <= 0) return;
    meta.targetCount = meta.targetCount === 3 || meta.targetCount === 4 ? meta.targetCount : meta.tp4 ? 4 : meta.tp3 ? 3 : 2;
    const targetPrice = meta.stage === 0 ? meta.tp1 : meta.stage === 1 ? meta.tp2 : meta.stage === 2 ? meta.tp3 ?? meta.tp2 : meta.tp4 ?? meta.tp3 ?? meta.tp2;
    const targetKind = "tp" + String(meta.stage + 1);
    const finalTarget = meta.stage + 1 >= meta.targetCount;
    const halfTargetQty = roundDown(targetQty * 0.5, precision);
    const targetQtyToPlace = finalTarget || halfTargetQty <= 0 ? targetQty : halfTargetQty;
    for (const key of ["tp1OrderId", "tp2OrderId", "tp3OrderId", "tp4OrderId"]) meta[key] = null;
    if (targetQtyToPlace <= 0) return;
    const id = await placeTakeProfit(apiKey, apiSecret, meta, targetQtyToPlace, targetPrice, targetKind);
    if (!id) throw new Error("BingX demo " + targetKind.toUpperCase() + " protection could not be restored.");
    if (meta.stage === 0) meta.tp1OrderId = id;
    else if (meta.stage === 1) meta.tp2OrderId = id;
    else if (meta.stage === 2) meta.tp3OrderId = id;
    else meta.tp4OrderId = id;
  }, "restoreTargets");
  if (available > 0 && available + Math.max(1e-10, qty * 1e-8) < qty) {
    try {
      await restoreTargets(currentQty);
    } catch (error) {
      throw new Error("Requested close quantity is not yet available and TP protection restoration failed: " + String(error).slice(0, 140));
    }
    throw new Error("BingX reports only " + available + " closeable units; requested " + qty + ". No close order was submitted.");
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    if (meta) try {
      await restoreTargets(currentQty);
    } catch (error) {
      throw new Error("No closeable quantity; TP protection restoration failed: " + String(error).slice(0, 160));
    }
    throw new Error("BingX demo position has no closeable quantity at the contract precision.");
  }
  let result = {};
  try {
    result = await placeOrder(apiKey, apiSecret, {
      symbol: position.symbol,
      side: closeSide(side),
      positionSide: positionSide(side, hedgeMode),
      type: "MARKET",
      quantity: qty,
      clientOrderId: protectiveClientOrderId({ symbol: position.symbol }, "close"),
      ...!hedgeMode ? { reduceOnly: "true" } : {}
    });
  } catch (error) {
    const originalError = String(error);
    if (fraction >= 1 && /101208|insufficient liquidity/i.test(originalError)) {
      let adaptiveRemaining = currentQty;
      let chunkQty = roundDown(currentQty / 2, precision);
      let sliceCount = 0;
      let fallbackError = "";
      try {
        const beforeAdaptive = (await getBingXDemoPositions(apiKey, apiSecret)).find((item) => item.symbol === position.symbol && (item.positionSide === current.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG")));
        adaptiveRemaining = beforeAdaptive ? Math.abs(number(beforeAdaptive.positionAmt)) : 0;
        if (adaptiveRemaining <= 0) {
          if (meta) {
            for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
              await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
            } catch {
            }
            meta.stopOrderId = null;
            meta.tp1OrderId = null;
            meta.tp2OrderId = null;
            meta.tp3OrderId = null;
            meta.tp4OrderId = null;
          }
          return { adaptiveClose: true, verifiedClosed: true, remainingQty: 0, closeMethod: "EXCHANGE_ALREADY_FLAT" };
        }
        chunkQty = roundDown(adaptiveRemaining / 2, precision);
        while (adaptiveRemaining > 0 && sliceCount < 40) {
          let attemptQty = roundDown(Math.min(adaptiveRemaining, chunkQty), precision);
          let accepted = false;
          while (attemptQty > 0) {
            try {
              const clientOrderId = ("smc-close-" + Date.now().toString(36) + "-" + sliceCount.toString(36)).slice(0, 40);
              result = await placeOrder(apiKey, apiSecret, {
                symbol: position.symbol,
                side: closeSide(side),
                positionSide: positionSide(side, hedgeMode),
                type: "MARKET",
                quantity: attemptQty,
                clientOrderId,
                ...!hedgeMode ? { reduceOnly: "true" } : {}
              });
              accepted = true;
              break;
            } catch (sliceError) {
              const message = String(sliceError);
              if (!/101208|insufficient liquidity/i.test(message)) throw sliceError;
              const smaller = roundDown(attemptQty / 2, precision);
              if (!(smaller > 0) || smaller >= attemptQty) throw sliceError;
              attemptQty = smaller;
            }
          }
          if (!accepted || !(attemptQty > 0)) {
            throw new Error("No executable close slice remained at the contract quantity precision.");
          }
          let observedQty = adaptiveRemaining;
          for (let poll = 0; poll < 6; poll++) {
            await new Promise((resolve) => setTimeout(resolve, 450));
            const fresh = await getBingXDemoPositions(apiKey, apiSecret);
            const residual = fresh.find((item) => item.symbol === position.symbol && (item.positionSide === current.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG")));
            observedQty = residual ? Math.abs(number(residual.positionAmt)) : 0;
            if (observedQty < adaptiveRemaining - Math.max(1e-10, adaptiveRemaining * 1e-9)) break;
          }
          if (observedQty >= adaptiveRemaining - Math.max(1e-10, adaptiveRemaining * 1e-9)) {
            throw new Error("BingX accepted a close slice but no position reduction was confirmed; further orders were stopped.");
          }
          adaptiveRemaining = observedQty;
          sliceCount++;
          if (adaptiveRemaining > 0) chunkQty = Math.min(attemptQty, adaptiveRemaining);
        }
        if (adaptiveRemaining > 0) {
          throw new Error("Adaptive close reached its safety limit with " + adaptiveRemaining + " units still open.");
        }
        if (meta) {
          for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
            await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
          } catch {
          }
          meta.stopOrderId = null;
          meta.tp1OrderId = null;
          meta.tp2OrderId = null;
          meta.tp3OrderId = null;
          meta.tp4OrderId = null;
        }
        return { ...result, adaptiveClose: true, verifiedClosed: true, remainingQty: 0, requestedCloseQty: currentQty, closeMethod: "ADAPTIVE_REDUCE_ONLY_MARKET_SLICES", slices: sliceCount };
      } catch (adaptiveFailure) {
        fallbackError = String(adaptiveFailure).slice(0, 200);
        try {
          const latest = (await getBingXDemoPositions(apiKey, apiSecret)).find((item) => item.symbol === position.symbol && (item.positionSide === current.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG")));
          adaptiveRemaining = latest ? Math.abs(number(latest.positionAmt)) : 0;
        } catch {
        }
        if (adaptiveRemaining <= 0) {
          if (meta) {
            for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
              await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
            } catch {
            }
            meta.stopOrderId = null;
            meta.tp1OrderId = null;
            meta.tp2OrderId = null;
            meta.tp3OrderId = null;
            meta.tp4OrderId = null;
          }
          return { adaptiveClose: true, verifiedClosed: true, remainingQty: 0, closeMethod: "EXCHANGE_CONFIRMED_FLAT_AFTER_ADAPTIVE_ERROR" };
        }
      }
      if (meta) try {
        await restoreTargets(adaptiveRemaining);
      } catch (restoreError) {
        throw new Error("Market close failed with 101208; adaptive close failed: " + fallbackError + "; remaining-position TP protection restoration failed: " + String(restoreError).slice(0, 120));
      }
      throw new Error("BingX market close failed with 101208 (Insufficient Liquidity); adaptive smaller-order close failed: " + fallbackError + ". Remaining quantity: " + adaptiveRemaining + ". Existing stop-loss protection was retained; TP protection was restored where possible.");
    }
    if (meta) try {
      await restoreTargets(currentQty);
    } catch (restoreError) {
      throw new Error("Demo close was rejected and TP protection restoration failed: " + String(restoreError).slice(0, 160));
    }
    throw error;
  }
  if (fraction >= 1) {
    let remainingPosition2;
    let remaining2 = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const fresh = await getBingXDemoPositions(apiKey, apiSecret);
      remainingPosition2 = fresh.find((item) => item.symbol === position.symbol && (item.positionSide === position.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG")));
      remaining2 = remainingPosition2 ? Math.abs(number(remainingPosition2.positionAmt)) : 0;
      if (remaining2 <= 0) break;
      if (attempt === 2) break;
      const retryQty = roundDown(remaining2, precision);
      if (retryQty <= 0) break;
      try {
        result = await placeOrder(apiKey, apiSecret, {
          symbol: position.symbol,
          side: closeSide(side),
          positionSide: positionSide(side, hedgeMode),
          type: "MARKET",
          quantity: retryQty,
          clientOrderId: protectiveClientOrderId({ symbol: position.symbol }, "close"),
          ...!hedgeMode ? { reduceOnly: "true" } : {}
        });
      } catch (retryError) {
        if (meta) try {
          await restoreTargets(remaining2);
        } catch (restoreError) {
          throw new Error("Demo close retry failed with " + remaining2 + " still open; TP protection restoration failed: " + String(restoreError).slice(0, 140));
        }
        throw new Error("Demo close retry failed with " + remaining2 + " still open; stop-loss protection remains active. " + String(retryError).slice(0, 160));
      }
    }
    if (remaining2 > 0) {
      if (meta) try {
        await restoreTargets(remaining2);
      } catch (restoreError) {
        throw new Error("BingX demo close left " + remaining2 + " open and TP protection restoration failed: " + String(restoreError).slice(0, 160));
      }
      throw new Error("BingX demo full close was not confirmed; remaining exchange quantity: " + remaining2 + ". Stop-loss protection was left in place and TP orders were restored.");
    }
    if (meta) {
      for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
        await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
      } catch {
      }
      meta.stopOrderId = null;
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
    }
    return { ...result, remainingQty: 0, requestedCloseQty: qty, verifiedClosed: true };
  }
  if (!meta) return result;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const after = await getBingXDemoPositions(apiKey, apiSecret);
  const remainingPosition = after.find((item) => item.symbol === position.symbol && (item.positionSide === position.positionSide || item.positionSide === "BOTH" && side === (number(item.positionAmt) < 0 ? "SHORT" : "LONG")));
  const remaining = remainingPosition ? Math.abs(number(remainingPosition.positionAmt)) : 0;
  if (!remainingPosition || remaining <= 0) {
    if (meta) {
      for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
        await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
      } catch {
      }
    }
    if (meta) {
      meta.stopOrderId = null;
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
    }
    return { ...result, requestedCloseQty: qty, remainingQty: 0, verifiedClosed: true };
  }
  if (remaining >= currentQty - Math.max(1e-10, currentQty * 1e-8)) {
    if (meta) try {
      await restoreTargets(currentQty);
    } catch (error) {
      throw new Error("BingX did not confirm a partial position reduction and TP protection restoration failed: " + String(error).slice(0, 140));
    }
    throw new Error("BingX accepted the partial close request but the exchange position quantity did not decrease.");
  }
  if (!meta) return { ...result, requestedCloseQty: qty, remainingQty: remaining, verifiedReduction: true };
  try {
    if (meta.stage === 0) meta.initialQty = remaining;
    meta.stageBaseQty = remaining;
    const openOrders = await getBingXDemoOpenOrders(apiKey, apiSecret, [position.symbol]);
    const stopSnapshot = { openOrders };
    const replacementStopOrderId = await ensurePositionStop(apiKey, apiSecret, stopSnapshot, meta, remaining, meta.stage >= 1 ? meta.entry : meta.stopLoss);
    if (!replacementStopOrderId) throw new Error("BingX did not return the active stop-order ID.");
    meta.stopOrderId = replacementStopOrderId;
    await restoreTargets(remaining);
    return { ...result, requestedCloseQty: qty, remainingQty: remaining, verifiedReduction: true, metadata: meta };
  } catch (protectionError) {
    for (const id of [meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
      await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
    } catch {
    }
    let activeStopOrderId = null;
    try {
      const activeOrders = await getBingXDemoOpenOrders(apiKey, apiSecret, [meta.symbol]);
      const activeStop = findPositionStopOrder({ openOrders: activeOrders }, meta);
      if (activeStop) activeStopOrderId = String(activeStop.orderId ?? activeStop.orderID ?? "") || null;
    } catch {
    }
    meta.stopOrderId = activeStopOrderId;
    try {
      await closeBingXDemoPosition(apiKey, apiSecret, remainingPosition, hedgeMode, 1);
      for (const id of [activeStopOrderId, previousStopOrderId]) if (id) try {
        await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
      } catch {
      }
      meta.stopOrderId = null;
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
    } catch (error) {
      meta.stopOrderId = activeStopOrderId;
      const protection = activeStopOrderId ? "An active stop order was verified and retained." : "The active stop could not be verified; immediate manual exchange review is required.";
      throw new Error("Partial close protection failed and emergency reduce-only close was not confirmed. " + protection + " " + String(error).slice(0, 180));
    }
    throw new Error("Partial close protection could not be restored; remaining demo position was emergency-closed. " + String(protectionError).slice(0, 160));
  }
}
__name(closeBingXDemoPosition, "closeBingXDemoPosition");
async function openBingXDemoPosition(apiKey, apiSecret, setup, snapshot, setupKey, requireCurrentPriceInsideZone = false) {
  try {
    if (setup.entryConfirmed !== true) return { ok: false, code: "ENTRY_NOT_CONFIRMED", error: "Setup is WAIT: required closed-candle entry confirmation is not complete; no demo order was sent." };
    if (!validSymbol.test(setup.symbol) || ![setup.entry, setup.stopLoss, setup.tp1, setup.tp2, setup.score].every(Number.isFinite)) {
      return { ok: false, code: "INVALID_SETUP", error: "BingX demo setup data is invalid." };
    }
    const existingSide = /* @__PURE__ */ __name((p) => p.positionSide === "BOTH" ? number(p.positionAmt) < 0 ? "SHORT" : "LONG" : p.positionSide, "existingSide");
    const orderSide = /* @__PURE__ */ __name((o) => String(o.positionSide ?? "").toUpperCase() === "LONG" ? "LONG" : String(o.positionSide ?? "").toUpperCase() === "SHORT" ? "SHORT" : String(o.side ?? "").toUpperCase() === "BUY" ? "LONG" : "SHORT", "orderSide");
    const sameSidePosition = snapshot.positions.some((p) => p.symbol === setup.symbol && existingSide(p) === setup.side);
    const oppositeSidePosition = snapshot.positions.some((p) => p.symbol === setup.symbol && existingSide(p) !== setup.side);
    const sameSideEntryOrder = snapshot.openOrders.some((o) => o.symbol === setup.symbol && String(o.type).toUpperCase() === "LIMIT" && orderSide(o) === setup.side);
    const oppositeSideEntryOrder = snapshot.openOrders.some((o) => o.symbol === setup.symbol && String(o.type).toUpperCase() === "LIMIT" && orderSide(o) !== setup.side);
    if (sameSidePosition || sameSideEntryOrder) return { ok: false, code: "ENGINE_SIDE_ALREADY_OPEN", error: "A BingX demo position or pending entry already exists on this direction." };
    if ((oppositeSidePosition || oppositeSideEntryOrder) && !snapshot.hedgeMode) return { ok: false, code: "HEDGE_MODE_REQUIRED", error: "Opposite Scalp/Swing positions on one symbol require BingX hedge mode." };
    const balance = snapshot.balance;
    if (!balance || balance.equity <= 0 || balance.availableMargin <= 0) {
      return { ok: false, code: "DEMO_BALANCE_UNAVAILABLE", error: "BingX demo USDT equity or available margin is unavailable." };
    }
    const long = setup.side === "LONG";
    const plannedStopDistance = Math.abs(setup.entry - setup.stopLoss);
    if (!(plannedStopDistance > 0 && (long ? setup.stopLoss < setup.entry && setup.tp1 > setup.entry && setup.tp2 > setup.tp1 : setup.stopLoss > setup.entry && setup.tp1 < setup.entry && setup.tp2 < setup.tp1))) {
      return { ok: false, code: "INVALID_SL_TP", error: "BingX demo setup has invalid SL/TP direction." };
    }
    let entryReferencePrice = 0;
    try {
      await waitForDemoRateLimit();
      const priceResponse = await fetch(DEMO_BASE + "/openApi/swap/v2/quote/price?symbol=" + encodeURIComponent(setup.symbol), {
        headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
        signal: AbortSignal.timeout(8e3),
        cache: "no-store"
      });
      if (!priceResponse.ok) throw new Error("BingX current price HTTP " + priceResponse.status);
      const pricePayload = await priceResponse.json();
      if (pricePayload.code !== 0) throw new Error(String(pricePayload.msg ?? "price endpoint unavailable"));
      const priceRows = Array.isArray(pricePayload.data) ? pricePayload.data : [pricePayload.data];
      const priceRow = priceRows.map(dataObject).find((row) => !row.symbol || row.symbol === setup.symbol) ?? {};
      entryReferencePrice = number(priceRow.price);
      if (!(entryReferencePrice > 0)) throw new Error("BingX current price is missing or invalid");
      if (requireCurrentPriceInsideZone) {
        const audit = setup.audit && typeof setup.audit === "object" ? setup.audit : {};
        const execution = audit.entryExecution && typeof audit.entryExecution === "object" ? audit.entryExecution : {};
        const zone = execution.entryZone && typeof execution.entryZone === "object" ? execution.entryZone : {};
        const bottom = Number(zone.bottom), top = Number(zone.top);
        if (!Number.isFinite(bottom) || !Number.isFinite(top) || entryReferencePrice < bottom || entryReferencePrice > top)
          return { ok: false, code: "MARKET_PRICE_LEFT_ENTRY_ZONE", error: "BingX price moved outside the audited entry zone before market execution; no order was sent." };
      }
    } catch (error) {
      return { ok: false, code: "MARKET_PRICE_UNAVAILABLE", error: "Current BingX demo price could not be verified; no market order was sent. " + String(error).slice(0, 180) };
    }
    const marketTargets = calculateBingXDemoFilledTargets({ side: setup.side, entry: entryReferencePrice, stopLoss: setup.stopLoss, referenceEntry: setup.entry, targetPrices: [setup.tp1, setup.tp2, setup.tp3, setup.tp4].filter((v) => Number.isFinite(v)) });
    if (!marketTargets) {
      return { ok: false, code: "MARKET_MOVED_OUTSIDE_SL_TP", error: "BingX demo price " + entryReferencePrice + " is on the wrong side of the structural stop; no market order was sent." };
    }
    const stopDistance = Math.abs(entryReferencePrice - setup.stopLoss);
    const riskMultiplier = Number.isFinite(Number(setup.riskMultiplier)) ? Math.min(1, Math.max(0.5, Number(setup.riskMultiplier))) : 1;
    const riskBudget = round(Number(balance.equity) * 0.02 * riskMultiplier, 8);
    if (!Number.isFinite(riskBudget) || riskBudget <= 0) return { ok: false, code: "VST_RISK_BASELINE_UNAVAILABLE", error: "Fixed VST 1R baseline is unavailable; no order was sent." };
    const marginBudget = balance.availableMargin;
    const minimumLeverage = riskMultiplier < 1 ? RISKY_MIN_LEVERAGE : MIN_LEVERAGE;
    const maximumLeverage = riskMultiplier < 1 ? RISKY_MAX_LEVERAGE : MAX_LEVERAGE;
    const unitRiskFraction = (stopDistance + entryReferencePrice * (FEE_RATE + SLIPPAGE_RATE) + setup.stopLoss * (FEE_RATE + SLIPPAGE_RATE)) / entryReferencePrice;
    if (unitRiskFraction > 1 / minimumLeverage * 0.8) {
      return { ok: false, code: "STOP_DISTANCE_EXCEEDS_MIN_LEVERAGE_SAFETY", error: "The structural stop is too wide to preserve a liquidation cushion at the minimum permitted " + minimumLeverage + "x isolated leverage; no order was sent." };
    }
    let leverage = Math.max(minimumLeverage, Math.min(maximumLeverage, Math.floor((riskMultiplier < 1 ? 0.4 : 0.8) / unitRiskFraction)));
    await waitForDemoRateLimit();
    const contractResponse = await fetch(DEMO_BASE + "/openApi/swap/v2/quote/contracts?symbol=" + encodeURIComponent(setup.symbol), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(1e4),
      cache: "no-store"
    });
    if (!contractResponse.ok) throw new Error("BingX demo contract metadata HTTP " + contractResponse.status);
    const contractPayload = await contractResponse.json();
    if (contractPayload.code !== 0) throw new Error("BingX demo contract metadata: " + String(contractPayload.msg ?? "unavailable"));
    const contract = dataObject(contractPayload.data);
    const precision = Math.max(0, Math.min(12, Math.floor(number(contract.quantityPrecision, 8))));
    const minQty = number(contract.tradeMinQuantity ?? contract.minQty, 0);
    const calculateSizing = /* @__PURE__ */ __name((targetLeverage) => {
      const riskLimitedNotional = riskBudget / unitRiskFraction;
      const targetNotional = Math.min(marginBudget * targetLeverage, riskLimitedNotional);
      const qty = roundDown(targetNotional / entryReferencePrice, precision);
      const value = qty * entryReferencePrice;
      const margin = value / targetLeverage;
      const stopRisk2 = qty * (stopDistance + entryReferencePrice * (FEE_RATE + SLIPPAGE_RATE) + setup.stopLoss * (FEE_RATE + SLIPPAGE_RATE));
      return { quantity: qty, notional: value, marginUsdt: margin, stopRisk: stopRisk2 };
    }, "calculateSizing");
    let sizing = calculateSizing(leverage);
    let { quantity, notional, marginUsdt, stopRisk } = sizing;
    const validSizing = /* @__PURE__ */ __name(() => quantity > 0 && quantity >= minQty && marginUsdt > 0 && marginUsdt <= balance.availableMargin && stopRisk <= riskBudget + 1e-6, "validSizing");
    if (!validSizing()) {
      return { ok: false, code: "ALLOCATION_OR_MINIMUM_QUANTITY", error: "BingX demo order could not use the exact 2% account allocation or meet the contract minimum; no order was sent." };
    }
    const side = long ? "BUY" : "SELL";
    const posSide = positionSide(setup.side, snapshot.hedgeMode);
    try {
      await demoRequest(apiKey, apiSecret, "POST", "/openApi/swap/v2/trade/marginType", { symbol: setup.symbol, marginType: "ISOLATED" });
    } catch (error) {
      if (!/same|already|unchanged|no need/i.test(String(error))) throw error;
    }
    const entryParams = /* @__PURE__ */ __name(() => ({
      symbol: setup.symbol,
      side,
      positionSide: posSide,
      type: "MARKET",
      quantity,
      clientOrderId: ("smc-bb-" + setup.symbol.toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + String(setup.candleTime)).slice(0, 40)
    }), "entryParams");
    let entryOrder = null;
    let tierError = "";
    let lastTierMaxValue = null;
    let lastTriedLeverage = leverage;
    for (let attempt = 0; attempt < 6 && !entryOrder; attempt++) {
      lastTriedLeverage = leverage;
      await demoRequest(apiKey, apiSecret, "POST", "/openApi/swap/v2/trade/leverage", { symbol: setup.symbol, side: posSide, leverage });
      try {
        entryOrder = await placeOrder(apiKey, apiSecret, entryParams());
      } catch (error) {
        const message = String(error);
        if (!/101209|maximum position value/i.test(message)) throw error;
        tierError = message;
        const capMatch = message.match(/maximum position value for this leverage is\s*([0-9,.]+)\s*USDT/i);
        const maxValue = capMatch ? Number(capMatch[1].replace(/,/g, "")) : Number.NaN;
        if (Number.isFinite(maxValue) && maxValue > 0) lastTierMaxValue = maxValue;
        const nextLeverage = nextLowerBingXLeverage(leverage, minimumLeverage);
        if (nextLeverage === null) break;
        leverage = nextLeverage;
        sizing = calculateSizing(leverage);
        quantity = sizing.quantity;
        notional = sizing.notional;
        marginUsdt = sizing.marginUsdt;
        stopRisk = sizing.stopRisk;
        if (!validSizing()) break;
      }
    }
    if (!entryOrder) {
      return {
        ok: false,
        code: tierError ? "EXCHANGE_MAX_POSITION_VALUE" : "ALLOCATION_OR_MINIMUM_QUANTITY",
        error: tierError ? "BingX rejected the order at the current leverage tiers down to " + lastTriedLeverage + "x" + (lastTierMaxValue !== null ? "; last reported tier cap: " + lastTierMaxValue + " USDT" : "") + "; available-margin cap and 1R stop-risk ceiling were preserved, and no order was opened. " + tierError.slice(0, 180) : "BingX minimum quantity could not be satisfied within available margin and the 1R stop-risk ceiling after leverage adjustment; no order was opened."
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
    let position;
    try {
      const positionsData = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/user/positions", { symbol: setup.symbol });
      const matchedPosition = asArray(positionsData).find((p) => p.symbol === setup.symbol && (p.positionSide === setup.side || p.positionSide === "BOTH") && Math.abs(number(p.positionAmt)) > 0);
      if (!matchedPosition) throw new Error("No matching exchange position was returned after the market order.");
      const reportedMarginType = String(matchedPosition.marginType ?? "").toUpperCase();
      position = {
        ...matchedPosition,
        isolated: matchedPosition.isolated == null && !reportedMarginType ? void 0 : matchedPosition.isolated === true || String(matchedPosition.isolated).toLowerCase() === "true" || reportedMarginType === "ISOLATED",
        marginType: reportedMarginType || void 0
      };
    } catch (positionSyncError) {
      const emergencyPosition = {
        symbol: setup.symbol,
        positionSide: posSide,
        isolated: true,
        positionAmt: String(snapshot.hedgeMode || long ? quantity : -quantity),
        availableAmt: String(quantity),
        unrealizedProfit: "0",
        initialMargin: String(marginUsdt),
        liquidationPrice: 0,
        avgPrice: String(entryReferencePrice),
        leverage,
        positionValue: String(notional),
        currency: "USDT"
      };
      let emergencyCloseError = "";
      try {
        await closeBingXDemoPosition(apiKey, apiSecret, emergencyPosition, snapshot.hedgeMode, 1);
      } catch (error) {
        emergencyCloseError = String(error).slice(0, 180);
      }
      throw new Error("Demo market entry was accepted but position confirmation failed. Emergency reduce-only close was " + (emergencyCloseError ? "not confirmed: " + emergencyCloseError : "requested") + "; verify the demo account immediately. " + String(positionSyncError).slice(0, 140));
    }
    if (position.isolated === false || position.marginType === "CROSS") {
      let emergencyCloseError = "";
      try {
        await closeBingXDemoPosition(apiKey, apiSecret, position, snapshot.hedgeMode, 1);
      } catch (error) {
        emergencyCloseError = String(error).slice(0, 180);
      }
      throw new Error("BINGX_POSITION_NOT_ISOLATED: exchange reported CROSS margin; emergency close was " + (emergencyCloseError ? "not confirmed: " + emergencyCloseError : "requested") + ".");
    }
    const actualQty = Math.abs(number(position.positionAmt));
    const actualEntry = number(position.avgPrice, entryReferencePrice);
    const filledTargets = calculateBingXDemoFilledTargets({ side: setup.side, entry: actualEntry, stopLoss: setup.stopLoss, referenceEntry: setup.entry, targetPrices: [setup.tp1, setup.tp2, setup.tp3, setup.tp4].filter((v) => Number.isFinite(v)) });
    if (!filledTargets) {
      let emergencyCloseError = "";
      try {
        await closeBingXDemoPosition(apiKey, apiSecret, position, snapshot.hedgeMode, 1);
      } catch (error) {
        emergencyCloseError = String(error).slice(0, 180);
      }
      throw new Error("BingX market fill moved to the wrong side of the structural stop; emergency reduce-only close was " + (emergencyCloseError ? "not confirmed: " + emergencyCloseError : "requested") + ".");
    }
    const meta = {
      setupKey,
      symbol: setup.symbol,
      side: setup.side,
      positionSide: posSide,
      hedgeMode: snapshot.hedgeMode,
      entry: actualEntry,
      stopLoss: setup.stopLoss,
      tp1: filledTargets.tp1,
      tp2: filledTargets.tp2,
      tp3: filledTargets.tp3,
      tp4: filledTargets.tp4,
      targetCount: filledTargets.targetCount,
      stageBaseQty: actualQty,
      initialQty: actualQty,
      initialRiskUsdt: actualQty * (Math.abs(actualEntry - setup.stopLoss) + actualEntry * (FEE_RATE + SLIPPAGE_RATE) + setup.stopLoss * (FEE_RATE + SLIPPAGE_RATE)),
      leverage: number(position.leverage, leverage),
      score: setup.score,
      model: setup.model,
      tradeStyle: setup.tradeStyle ?? "SWING",
      setupTimeframe: setup.setupTimeframe ?? "4h",
      entryTimeframe: setup.entryTimeframe ?? "1h",
      setupReason: setup.setupReason ?? "",
      confirmations: Array.isArray(setup.confirmations) ? setup.confirmations : [],
      scoreBreakdown: setup.scoreBreakdown ?? {},
      riskReward: filledTargets.riskReward,
      audit: setup.audit ?? null,
      marginUsdt: number(position.initialMargin, marginUsdt),
      notionalUsdt: number(position.positionValue, actualQty * actualEntry),
      entryOrderId: orderId(entryOrder),
      stopOrderId: null,
      tp1OrderId: null,
      tp2OrderId: null,
      tp3OrderId: null,
      tp4OrderId: null,
      stage: 0,
      openedAt: Date.now(),
      maxHoldHours: Number.isFinite(setup.maxHoldHours) ? setup.maxHoldHours : void 0
    };
    try {
      meta.stopOrderId = await placeStop(apiKey, apiSecret, meta, actualQty, setup.stopLoss);
      const half = roundDown(actualQty / 2, precision);
      const firstTargetQty = half > 0 ? half : actualQty;
      meta.tp1OrderId = await placeTakeProfit(apiKey, apiSecret, meta, firstTargetQty, meta.tp1, "tp1");
      if (!meta.stopOrderId || !meta.tp1OrderId) {
        throw new Error("BingX demo did not return IDs for every protective order.");
      }
    } catch (protectionError) {
      for (const id of [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId]) if (id) try {
        await cancelBingXDemoOrder(apiKey, apiSecret, meta.symbol, id);
      } catch {
      }
      let emergencyCloseError = "";
      try {
        await closeBingXDemoPosition(apiKey, apiSecret, position, snapshot.hedgeMode, 1);
      } catch (error) {
        emergencyCloseError = String(error).slice(0, 180);
      }
      throw new Error("Demo position opened but protective orders failed; emergency close was " + (emergencyCloseError ? "not confirmed: " + emergencyCloseError : "requested") + ". " + String(protectionError).slice(0, 180));
    }
    return { ok: true, position: meta, order: entryOrder };
  } catch (error) {
    const message = String(error);
    const unprotected = /emergency close was not confirmed|emergency reduce-only close was not confirmed/i.test(message);
    return { ok: false, code: unprotected ? "UNPROTECTED_POSITION_REQUIRES_ACTION" : "BINGX_DEMO_ORDER_FAILED", error: message.slice(0, 360) };
  }
}
__name(openBingXDemoPosition, "openBingXDemoPosition");
async function placeBingXDemoEntry(apiKey, apiSecret, setup, snapshot, setupKey) {
  if (setup.entryConfirmed !== true) return { ok: false, code: "ENTRY_NOT_CONFIRMED", error: "The order-flow setup is not fully confirmed." };
  const zoneValidation = validateBingXDemoEntryZone(setup);
  if (!zoneValidation.ok) return zoneValidation;
  const audit = setup.audit && typeof setup.audit === "object" ? setup.audit : {};
  const execution = audit.entryExecution && typeof audit.entryExecution === "object" ? audit.entryExecution : {};
  const zone = execution.entryZone && typeof execution.entryZone === "object" ? execution.entryZone : {};
  const bottom = Number(zone.bottom), top = Number(zone.top);
  let currentPrice = 0;
  try {
    await waitForDemoRateLimit();
    const response = await fetch(DEMO_BASE + "/openApi/swap/v2/quote/price?symbol=" + encodeURIComponent(setup.symbol), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(8e3),
      cache: "no-store"
    });
    if (!response.ok) throw new Error("BingX current price HTTP " + response.status);
    const payload = await response.json();
    if (payload.code !== 0) throw new Error(String(payload.msg ?? "price endpoint unavailable"));
    const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
    const row = rows.map(dataObject).find((item) => !item.symbol || item.symbol === setup.symbol) ?? {};
    currentPrice = number(row.price);
    if (!(currentPrice > 0)) throw new Error("BingX current price is missing or invalid");
  } catch (error) {
    return { ok: false, code: "MARKET_PRICE_UNAVAILABLE", error: "Current BingX VST price could not be verified; no order was sent. " + String(error).slice(0, 180) };
  }
  if (currentPrice >= bottom && currentPrice <= top) {
    const market = await openBingXDemoPosition(apiKey, apiSecret, setup, snapshot, setupKey, true);
    return market.ok ? { ok: true, mode: "MARKET", position: market.position, order: market.order } : market;
  }
  const waitingForPullback = setup.side === "LONG" ? currentPrice > top : currentPrice < bottom;
  if (!waitingForPullback)
    return { ok: false, code: "ENTRY_ZONE_ALREADY_PASSED", error: "Live price has crossed through the setup's entry zone; the setup is stale and no order was sent." };
  const limit = await placeBingXDemoLimitEntry(apiKey, apiSecret, setup, snapshot, setupKey);
  return limit.ok ? { ok: true, mode: "LIMIT", pending: limit.pending } : limit;
}
__name(placeBingXDemoEntry, "placeBingXDemoEntry");
function findOrphanBingXDemoEntryOrders(snapshot, pendingEntries) {
  if (snapshot.openOrdersComplete === false) return [];
  const trackedIds = /* @__PURE__ */ new Set();
  for (const pending of pendingEntries) {
    trackedIds.add(String(pending.orderId ?? ""));
    trackedIds.add(String(pending.clientOrderId ?? "").toLowerCase());
  }
  return snapshot.openOrders.filter((order) => {
    if (String(order.type).toUpperCase() !== "LIMIT") return false;
    const clientId = String(order.clientOrderId ?? order.clientOrderID ?? "").toLowerCase();
    if (!clientId.startsWith("of-")) return false;
    const id = String(order.orderID ?? order.orderId ?? "");
    if (id && trackedIds.has(id) || trackedIds.has(clientId)) return false;
    return !snapshot.positions.some((position) => position.symbol === order.symbol && Math.abs(number(position.positionAmt)) > 1e-12);
  });
}
__name(findOrphanBingXDemoEntryOrders, "findOrphanBingXDemoEntryOrders");
async function cleanupOrphanBingXDemoEntryOrders(apiKey, apiSecret, snapshot, pendingEntries, knownSymbols = []) {
  if (snapshot.openOrdersComplete === false) return { snapshot, cancelAttempts: 0, cleanupPending: true, remaining: 0 };
  const orphanOrders = findOrphanBingXDemoEntryOrders(snapshot, pendingEntries);
  if (!orphanOrders.length) return { snapshot, cancelAttempts: 0, cleanupPending: false, remaining: 0 };
  const idsBySymbol = /* @__PURE__ */ new Map();
  let missingOrderId = false;
  for (const order of orphanOrders) {
    const id = String(order.orderID ?? order.orderId ?? "");
    if (!id) {
      missingOrderId = true;
      continue;
    }
    const ids = idsBySymbol.get(order.symbol) ?? [];
    ids.push(id);
    idsBySymbol.set(order.symbol, ids);
  }
  let cancelAttempts = 0;
  for (const [symbol, ids] of idsBySymbol) {
    await cancelBingXDemoOrders(apiKey, apiSecret, symbol, ids);
    cancelAttempts += ids.length;
  }
  const symbols = [.../* @__PURE__ */ new Set([...knownSymbols, ...orphanOrders.map((order) => order.symbol)])];
  let refreshed = await getBingXDemoSnapshot(apiKey, apiSecret, symbols);
  if (refreshed.openOrdersComplete === false) return { snapshot: refreshed, cancelAttempts, cleanupPending: true, remaining: 0 };
  let remainingOrders = findOrphanBingXDemoEntryOrders(refreshed, pendingEntries);
  for (const order of remainingOrders) {
    const id = String(order.orderID ?? order.orderId ?? "");
    if (!id) {
      missingOrderId = true;
      continue;
    }
    await cancelBingXDemoOrder(apiKey, apiSecret, order.symbol, id);
    cancelAttempts++;
  }
  if (remainingOrders.length) {
    refreshed = await getBingXDemoSnapshot(apiKey, apiSecret, symbols);
    if (refreshed.openOrdersComplete === false) return { snapshot: refreshed, cancelAttempts, cleanupPending: true, remaining: 0 };
    remainingOrders = findOrphanBingXDemoEntryOrders(refreshed, pendingEntries);
  }
  const remaining = remainingOrders.length;
  return { snapshot: refreshed, cancelAttempts, cleanupPending: missingOrderId || remaining > 0, remaining };
}
__name(cleanupOrphanBingXDemoEntryOrders, "cleanupOrphanBingXDemoEntryOrders");
var BINGX_DEMO_PENDING_CANCEL_RETRY_MS = 9 * 60 * 1e3;
function shouldRetryBingXDemoPendingCancel(pending, now = Date.now()) {
  const last2 = Number(pending.cancelAttemptAt ?? 0);
  return !Number.isFinite(last2) || last2 <= 0 || now - last2 >= BINGX_DEMO_PENDING_CANCEL_RETRY_MS;
}
__name(shouldRetryBingXDemoPendingCancel, "shouldRetryBingXDemoPendingCancel");
function isBingXDemoPendingEntryAbsentFromSnapshot(pending, snapshot, now = Date.now()) {
  if (snapshot.openOrdersComplete !== true || now - Number(pending.placedAt || 0) < 6e4) return false;
  const pendingOrderIds = new Set([pending.orderId, pending.clientOrderId].filter(Boolean).map(String));
  const orderStillOpen = snapshot.openOrders.some((order) => pendingOrderIds.has(String(order.orderID ?? order.orderId ?? order.clientOrderId ?? order.clientOrderID ?? "")));
  const matchingPositionOpen = snapshot.positions.some((position) => {
    const side = position.positionSide === "BOTH" ? Number(position.positionAmt) < 0 ? "SHORT" : "LONG" : position.positionSide;
    return position.symbol === pending.setup.symbol && side === pending.setup.side;
  });
  return !orderStillOpen && !matchingPositionOpen;
}
__name(isBingXDemoPendingEntryAbsentFromSnapshot, "isBingXDemoPendingEntryAbsentFromSnapshot");
function validateBingXDemoEntryZone(setup) {
  const audit = setup.audit && typeof setup.audit === "object" ? setup.audit : {};
  const execution = audit.entryExecution && typeof audit.entryExecution === "object" ? audit.entryExecution : {};
  const zone = execution.entryZone && typeof execution.entryZone === "object" ? execution.entryZone : audit.zone && typeof audit.zone === "object" ? audit.zone : null;
  if (!zone) return { ok: false, code: "ENTRY_ZONE_AUDIT_MISSING", error: "A generic, auditable entry zone is required before a VST limit order can be submitted." };
  const top = Number(zone.top), bottom = Number(zone.bottom), entry = Number(setup.entry);
  if (![top, bottom, entry].every(Number.isFinite) || bottom <= 0 || top <= bottom || entry <= 0)
    return { ok: false, code: "ENTRY_ZONE_AUDIT_INVALID", error: "The audited entry zone or proposed limit price is invalid." };
  const tolerance = Math.max(51e-10, Math.abs(entry) * 1e-10);
  if (entry < bottom - tolerance || entry > top + tolerance)
    return { ok: false, code: "ENTRY_PRICE_OUTSIDE_MODEL_ZONE", error: "The proposed limit price is outside the audited structural zone." };
  const close = Number(execution.confirmationCandleClose);
  if (Number.isFinite(close) && close > 0 && (setup.side === "LONG" ? entry >= close : entry <= close))
    return { ok: false, code: "ENTRY_ZONE_NOT_PASSIVE", error: "The entry level is no longer passive relative to its confirmation close; market chasing is forbidden." };
  return { ok: true };
}
__name(validateBingXDemoEntryZone, "validateBingXDemoEntryZone");
function calculateBingXDemoEntrySizing(input) {
  const { entry, stopLoss, equity, availableMargin, precision, minQty } = input;
  if (![entry, stopLoss, equity, availableMargin].every(Number.isFinite) || entry <= 0 || equity <= 0 || availableMargin <= 0 || !Number.isFinite(Number(input.fixedRiskUnitUsdt)) || Number(input.fixedRiskUnitUsdt) <= 0 || precision < 0 || precision > 12)
    return { ok: false, code: "DEMO_BALANCE_UNAVAILABLE", error: "BingX VST equity or available margin is unavailable." };
  const riskMultiplier = Number.isFinite(Number(input.riskMultiplier)) ? Math.min(1, Math.max(0.5, Number(input.riskMultiplier))) : 1;
  const distance = Math.abs(entry - stopLoss), riskBudget = Number(input.fixedRiskUnitUsdt) * riskMultiplier;
  if (!Number.isFinite(riskBudget) || riskBudget <= 0) return { ok: false, code: "VST_RISK_BASELINE_UNAVAILABLE", error: "Fixed VST 1R baseline is unavailable; no order was sent." };
  const marginBudget = availableMargin, minimumLeverage = riskMultiplier < 1 ? RISKY_MIN_LEVERAGE : MIN_LEVERAGE;
  const maximumLeverage = riskMultiplier < 1 ? RISKY_MAX_LEVERAGE : MAX_LEVERAGE;
  const liquidationBufferFraction = 5e-3;
  const costFraction = distance / entry + 2 * (FEE_RATE + SLIPPAGE_RATE);
  if (!(distance > 0 && costFraction > 0 && marginBudget > 0))
    return { ok: false, code: "INVALID_RISK_DISTANCE", error: "Order-flow stop distance is invalid." };
  if (costFraction > 1 / minimumLeverage * 0.8)
    return { ok: false, code: "STOP_DISTANCE_EXCEEDS_MIN_LEVERAGE_SAFETY", error: "The stop distance is too wide for a safe isolated position at the minimum permitted " + minimumLeverage + "x leverage." };
  const maxLeverageByLiquidationBuffer = Math.floor(1 / (distance / entry + DEFAULT_MAINTENANCE_MARGIN_RATE + liquidationBufferFraction));
  if (maxLeverageByLiquidationBuffer < minimumLeverage)
    return { ok: false, code: "LIQUIDATION_BUFFER_INSUFFICIENT", error: "The stop cannot maintain a 0.5% liquidation cushion at the minimum permitted leverage." };
  const riskAdjustedLeverageTarget = riskMultiplier < 1 ? Math.max(minimumLeverage, Math.min(maximumLeverage, Math.floor(0.4 / costFraction))) : Math.max(minimumLeverage, Math.floor(0.8 / costFraction));
  const leverage = Math.min(maximumLeverage, maxLeverageByLiquidationBuffer, riskAdjustedLeverageTarget);
  const liquidationCushionUsdt = entry * (1 / leverage - DEFAULT_MAINTENANCE_MARGIN_RATE) - distance;
  if (liquidationCushionUsdt < entry * liquidationBufferFraction)
    return { ok: false, code: "LIQUIDATION_BUFFER_INSUFFICIENT", error: "Selected leverage does not leave the required 0.5% liquidation cushion beyond the stop." };
  const riskSizedNotional = riskBudget / costFraction;
  const marginCappedNotional = marginBudget * leverage;
  const targetNotional = Math.min(riskSizedNotional, marginCappedNotional);
  const quantity = roundDown(targetNotional / entry, precision);
  const notionalUsdt = quantity * entry, marginUsdt = notionalUsdt / leverage;
  const estimatedLoss = quantity * (distance + entry * (FEE_RATE + SLIPPAGE_RATE) + stopLoss * (FEE_RATE + SLIPPAGE_RATE));
  const tp1Qty = roundDown(quantity * 0.5, precision), tp2Qty = roundDown(quantity - tp1Qty, precision);
  if (!(quantity > 0) || quantity < minQty || tp1Qty < minQty || tp2Qty < minQty || marginUsdt > marginBudget + 1e-8 || estimatedLoss > riskBudget + 1e-6)
    return { ok: false, code: "RISK_OR_MINIMUM_QUANTITY", error: "The setup risk tier and margin budgets cannot satisfy BingX minimum quantity and the 50/50 TP split; no order was sent." };
  return { ok: true, quantity, leverage, notionalUsdt, marginUsdt, estimatedLoss, riskBudget, marginBudget, liquidationCushionUsdt, liquidationCushionPercent: liquidationCushionUsdt / entry * 100 };
}
__name(calculateBingXDemoEntrySizing, "calculateBingXDemoEntrySizing");
async function placeBingXDemoLimitEntry(apiKey, apiSecret, setup, snapshot, setupKey) {
  let failureStage = "SETUP_VALIDATION";
  try {
    if (setup.entryConfirmed !== true) return { ok: false, code: "ENTRY_NOT_CONFIRMED", error: "The order-flow setup is not fully confirmed." };
    setup = { ...setup, entry: Number(setup.entry), stopLoss: Number(setup.stopLoss), tp1: Number(setup.tp1), tp2: Number(setup.tp2), score: Number(setup.score) };
    if (!validSymbol.test(setup.symbol) || ![setup.entry, setup.stopLoss, setup.tp1, setup.tp2, setup.score].every(Number.isFinite))
      return { ok: false, code: "INVALID_SETUP", error: "Invalid VST setup numbers: " + ["entry", "stopLoss", "tp1", "tp2", "score"].filter((key) => !Number.isFinite(Number(setup[key]))).join(", ") };
    const zoneValidation = validateBingXDemoEntryZone(setup);
    if (!zoneValidation.ok) return zoneValidation;
    if (snapshot.openOrdersComplete === false) return { ok: false, code: "ACCOUNT_OPEN_ORDERS_INCOMPLETE", error: "The account-wide order list is incomplete after TP/SL slot pressure; existing positions can be managed, but new entries are blocked." };
    const sideOfPosition = /* @__PURE__ */ __name((p) => p.positionSide === "BOTH" ? number(p.positionAmt) < 0 ? "SHORT" : "LONG" : p.positionSide, "sideOfPosition");
    const sameSidePosition = snapshot.positions.some((p) => p.symbol === setup.symbol && sideOfPosition(p) === setup.side);
    const oppositeSidePosition = snapshot.positions.some((p) => p.symbol === setup.symbol && sideOfPosition(p) !== setup.side);
    const sideOfOrder = /* @__PURE__ */ __name((o) => String(o.positionSide ?? "").toUpperCase() === "LONG" ? "LONG" : String(o.positionSide ?? "").toUpperCase() === "SHORT" ? "SHORT" : String(o.side ?? "").toUpperCase() === "BUY" ? "LONG" : "SHORT", "sideOfOrder");
    const sameSideLimit = snapshot.openOrders.some((o) => o.symbol === setup.symbol && String(o.type).toUpperCase() === "LIMIT" && sideOfOrder(o) === setup.side);
    const oppositeSideLimit = snapshot.openOrders.some((o) => o.symbol === setup.symbol && String(o.type).toUpperCase() === "LIMIT" && sideOfOrder(o) !== setup.side);
    if (sameSidePosition || sameSideLimit) return { ok: false, code: "ENGINE_SIDE_ALREADY_ACTIVE", error: "This engine direction already has a position or pending limit order." };
    if ((oppositeSidePosition || oppositeSideLimit) && !snapshot.hedgeMode) return { ok: false, code: "HEDGE_MODE_REQUIRED", error: "Opposite Scalp/Swing entries on one symbol require BingX hedge mode." };
    const balance = snapshot.balance;
    if (!balance || balance.equity <= 0 || balance.availableMargin <= 0) return { ok: false, code: "DEMO_BALANCE_UNAVAILABLE", error: "BingX VST equity or available margin is unavailable." };
    const long = setup.side === "LONG";
    const levelsValid = long ? setup.stopLoss < setup.entry && setup.entry < setup.tp1 && setup.tp2 > setup.tp1 : setup.stopLoss > setup.entry && setup.entry > setup.tp1 && setup.tp2 < setup.tp1;
    if (!levelsValid) return { ok: false, code: "INVALID_SL_TP", error: "Order-flow limit setup has invalid stop/target direction." };
    failureStage = "CONTRACT_METADATA";
    await waitForDemoRateLimit();
    const contractResponse = await fetch(DEMO_BASE + "/openApi/swap/v2/quote/contracts?symbol=" + encodeURIComponent(setup.symbol), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(1e4),
      cache: "no-store"
    });
    if (!contractResponse.ok) throw new Error("BingX contract metadata HTTP " + contractResponse.status);
    const contractPayload = await contractResponse.json();
    if (contractPayload.code !== 0) throw new Error("BingX contract metadata: " + String(contractPayload.msg ?? "unavailable"));
    const contract = dataObject(contractPayload.data), precision = Math.max(0, Math.min(12, Math.floor(number(contract.quantityPrecision, 8))));
    const minQty = number(contract.tradeMinQuantity ?? contract.minQty, 0);
    const finalSizing = calculateBingXDemoEntrySizing({
      entry: setup.entry,
      stopLoss: setup.stopLoss,
      equity: balance.equity,
      availableMargin: balance.availableMargin,
      precision,
      minQty,
      riskMultiplier: setup.riskMultiplier,
      fixedRiskUnitUsdt: round(Number(balance.equity) * 0.02, 8)
    });
    if (!finalSizing.ok) return finalSizing;
    let { quantity, leverage, notionalUsdt: notional, marginUsdt } = finalSizing;
    const riskBudget = finalSizing.riskBudget;
    const distance = Math.abs(setup.entry - setup.stopLoss);
    const tp1Qty = roundDown(quantity * 0.5, precision), tp2Qty = roundDown(quantity - tp1Qty, precision);
    const posSide = positionSide(setup.side, snapshot.hedgeMode);
    failureStage = "MARGIN_MODE";
    try {
      await demoRequest(apiKey, apiSecret, "POST", "/openApi/swap/v2/trade/marginType", { symbol: setup.symbol, marginType: "ISOLATED" });
    } catch (error) {
      if (!/same|already|unchanged|no need/i.test(String(error))) throw error;
    }
    failureStage = "LEVERAGE";
    await demoRequest(apiKey, apiSecret, "POST", "/openApi/swap/v2/trade/leverage", { symbol: setup.symbol, side: posSide, leverage });
    let clientOrderId = ("of-" + setup.symbol.toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36)).slice(0, 40);
    const attachedStop = JSON.stringify({ type: "STOP_MARKET", stopPrice: setup.stopLoss, workingType: "MARK_PRICE" });
    let order;
    failureStage = "POST_ONLY_LIMIT_ORDER";
    try {
      order = await placeOrder(apiKey, apiSecret, {
        symbol: setup.symbol,
        side: long ? "BUY" : "SELL",
        positionSide: posSide,
        type: "LIMIT",
        quantity,
        price: setup.entry,
        timeInForce: "PostOnly",
        stopLoss: attachedStop,
        clientOrderId
      });
    } catch (firstError) {
      const message = String(firstError);
      const capMatch = message.match(/maximum position value for this leverage is\s*([0-9,.]+)\s*USDT/i);
      const exchangeMaxNotional = capMatch ? Number(capMatch[1]) : Number.NaN;
      if (!/101209/.test(message) || !Number.isFinite(exchangeMaxNotional) || exchangeMaxNotional <= 0) throw firstError;
      const cappedQuantity = roundDown(Math.min(quantity, exchangeMaxNotional / setup.entry), precision);
      const cappedNotional = cappedQuantity * setup.entry;
      const cappedMargin = cappedNotional / leverage;
      const cappedRisk = cappedQuantity * (distance + setup.entry * (FEE_RATE + SLIPPAGE_RATE) + setup.stopLoss * (FEE_RATE + SLIPPAGE_RATE));
      const cappedTp1 = roundDown(cappedQuantity * 0.5, precision), cappedTp2 = roundDown(cappedQuantity - cappedTp1, precision);
      if (cappedQuantity < minQty || cappedTp1 < minQty || cappedTp2 < minQty || cappedMargin > balance.availableMargin || cappedRisk > riskBudget + 1e-6)
        throw new Error("BingX leverage-tier cap " + exchangeMaxNotional + " USDT leaves insufficient quantity for the 50/50 TP plan within available margin and 2% risk; no order was retried.");
      quantity = cappedQuantity;
      notional = cappedNotional;
      marginUsdt = cappedMargin;
      clientOrderId = ("of-" + setup.symbol.toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + Date.now().toString(36) + "r").slice(0, 40);
      order = await placeOrder(apiKey, apiSecret, {
        symbol: setup.symbol,
        side: long ? "BUY" : "SELL",
        positionSide: posSide,
        type: "LIMIT",
        quantity,
        price: setup.entry,
        timeInForce: "PostOnly",
        stopLoss: attachedStop,
        clientOrderId
      });
    }
    let id = orderId(order);
    failureStage = "ORDER_ID_CONFIRMATION";
    if (!id) {
      try {
        const detail = await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/order", { symbol: setup.symbol, clientOrderId });
        id = orderId(dataObject(detail));
      } catch {
      }
    }
    if (!id) {
      try {
        await demoRequest(apiKey, apiSecret, "DELETE", "/openApi/swap/v2/trade/order", { symbol: setup.symbol, clientOrderId });
      } catch {
      }
      throw new Error("BingX accepted the maker order but its ID could not be verified; cancellation by clientOrderId was attempted.");
    }
    return { ok: true, pending: {
      orderId: id,
      clientOrderId,
      setupKey,
      setup,
      quantity,
      leverage,
      marginUsdt,
      notionalUsdt: notional,
      hedgeMode: snapshot.hedgeMode,
      positionSide: posSide,
      placedAt: Date.now()
    } };
  } catch (error) {
    return { ok: false, code: "BINGX_DEMO_LIMIT_ORDER_FAILED", error: "stage=" + failureStage + "; " + String(error).slice(0, 320) };
  }
}
__name(placeBingXDemoLimitEntry, "placeBingXDemoLimitEntry");
function makerFillTimeMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1e3 : numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
__name(makerFillTimeMs, "makerFillTimeMs");
async function closedMakerEntryResult(apiKey, apiSecret, pending, reason) {
  try {
    const fills = await getBingXDemoClosedFills(apiKey, apiSecret);
    const relevant = fills.filter((fill) => fill.symbol === pending.setup.symbol && makerFillTimeMs(fill.time) >= pending.placedAt - 3e4);
    const pnl = relevant.reduce((sum, fill) => sum + Number(fill.realizedPnl || 0), 0);
    if (relevant.length >= 2 || relevant.length >= 1 && Math.abs(pnl) > 1e-10) {
      const stopOut = pnl < 0 && relevant.some((fill) => Math.abs(Number(fill.price) - pending.setup.stopLoss) / Math.max(pending.setup.stopLoss, 1e-12) <= 3e-3);
      return { status: "CLOSED", reason, realizedPnl: pnl, stopOut };
    }
  } catch {
  }
  return { status: "WAIT_POSITION_SYNC", pending };
}
__name(closedMakerEntryResult, "closedMakerEntryResult");
function calculateBingXDemoFilledTargets(input) {
  const { side, entry, stopLoss } = input;
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0) return null;
  if (side === "LONG" ? stopLoss >= entry : stopLoss <= entry) return null;
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0)) return null;
  const refs = input.targetPrices?.filter((v) => Number.isFinite(v) && v > 0) ?? [];
  let targets;
  if (refs.length >= 2 && Number.isFinite(input.referenceEntry) && Number(input.referenceEntry) > 0) {
    const referenceRisk = Math.abs(Number(input.referenceEntry) - stopLoss);
    if (!(referenceRisk > 0)) return null;
    targets = refs.map((price) => {
      const multiple = Math.abs(price - Number(input.referenceEntry)) / referenceRisk;
      return side === "LONG" ? entry + risk * multiple : entry - risk * multiple;
    });
  } else targets = [side === "LONG" ? entry + risk : entry - risk, side === "LONG" ? entry + 2 * risk : entry - 2 * risk];
  if (targets.length < 2 || targets.some((v, i) => !(v > 0) && i >= 0)) return null;
  for (let i = 1; i < targets.length; i++) if (side === "LONG" ? targets[i] <= targets[i - 1] : targets[i] >= targets[i - 1]) return null;
  const targetCount = Math.min(4, Math.max(2, targets.length));
  return { tp1: targets[0], tp2: targets[1], ...targetCount >= 3 ? { tp3: targets[2] } : {}, ...targetCount >= 4 ? { tp4: targets[3] } : {}, targetCount, riskReward: Math.abs(targets[targetCount - 1] - entry) / risk };
}
__name(calculateBingXDemoFilledTargets, "calculateBingXDemoFilledTargets");
async function reconcileBingXDemoLimitEntry(apiKey, apiSecret, pending) {
  const detail = dataObject(await demoRequest(
    apiKey,
    apiSecret,
    "GET",
    "/openApi/swap/v2/trade/order",
    { symbol: pending.setup.symbol, orderId: pending.orderId }
  ));
  const status = String(detail.status ?? detail.orderStatus ?? "").toUpperCase();
  const executed = number(detail.executedQty ?? detail.cumExecQty ?? detail.filledQty, status === "FILLED" ? pending.quantity : 0);
  const terminal = ["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(status);
  if (executed <= 0) {
    if (terminal) return { status: "CANCELED", reason: "LIMIT_ORDER_" + (status || "TERMINAL") };
    return { status: "PENDING", pending };
  }
  if (status !== "FILLED" && status !== "CANCELED" && status !== "CANCELLED" && status !== "EXPIRED") {
    if (!shouldRetryBingXDemoPendingCancel(pending) && pending.cancelAttemptSucceeded !== true)
      return { status: "PENDING", pending };
    if (shouldRetryBingXDemoPendingCancel(pending)) {
      pending.cancelAttemptAt = Date.now();
      pending.cancelAttemptSucceeded = false;
      try {
        await cancelBingXDemoOrder(apiKey, apiSecret, pending.setup.symbol, pending.orderId);
        pending.cancelAttemptSucceeded = true;
      } catch (error) {
        return { status: "PENDING", pending };
      }
    }
  }
  const positions = await getBingXDemoPositions(apiKey, apiSecret);
  const position = positions.find((p) => p.symbol === pending.setup.symbol && (p.positionSide === pending.setup.side || p.positionSide === "BOTH" && pending.setup.side === (number(p.positionAmt) < 0 ? "SHORT" : "LONG")));
  if (!position) return await closedMakerEntryResult(apiKey, apiSecret, pending, "MAKER_POSITION_CLOSED_BEFORE_RECONCILIATION");
  const qty = Math.abs(number(position.positionAmt)), actualEntry = number(position.avgPrice, pending.setup.entry);
  if (!(qty > 0)) return { status: "WAIT_POSITION_SYNC", pending };
  const setup = pending.setup, long = setup.side === "LONG";
  const filledTargets = calculateBingXDemoFilledTargets({ side: setup.side, entry: actualEntry, stopLoss: setup.stopLoss, referenceEntry: setup.entry, targetPrices: [setup.tp1, setup.tp2, setup.tp3, setup.tp4].filter((v) => Number.isFinite(v)) });
  const valid2 = filledTargets !== null;
  const actualTp1 = filledTargets?.tp1 ?? 0, actualTp2 = filledTargets?.tp2 ?? 0;
  if (!valid2) {
    await closeBingXDemoPosition(apiKey, apiSecret, position, pending.hedgeMode, 1);
    const stillOpen = (await getBingXDemoPositions(apiKey, apiSecret)).some((p) => p.symbol === setup.symbol);
    if (!stillOpen) {
      const orders = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol: setup.symbol }));
      for (const order of orders) if (["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(String(order.type).toUpperCase())) {
        const id = orderId(order);
        if (id) try {
          await cancelBingXDemoOrder(apiKey, apiSecret, setup.symbol, id);
        } catch {
        }
      }
      return await closedMakerEntryResult(apiKey, apiSecret, pending, "FILL_MOVED_OUTSIDE_STOP_TARGET_CORRIDOR_POSITION_CLOSED");
    }
    return { status: "WAIT_POSITION_SYNC", pending };
  }
  const meta = {
    setupKey: pending.setupKey,
    symbol: setup.symbol,
    side: setup.side,
    positionSide: pending.positionSide,
    hedgeMode: pending.hedgeMode,
    entry: actualEntry,
    stopLoss: setup.stopLoss,
    tp1: actualTp1,
    tp2: actualTp2,
    tp3: filledTargets?.tp3,
    tp4: filledTargets?.tp4,
    targetCount: filledTargets?.targetCount ?? 2,
    stageBaseQty: qty,
    initialQty: qty,
    initialRiskUsdt: qty * (Math.abs(actualEntry - setup.stopLoss) + actualEntry * (FEE_RATE + SLIPPAGE_RATE) + setup.stopLoss * (FEE_RATE + SLIPPAGE_RATE)),
    leverage: number(position.leverage, pending.leverage),
    score: setup.score,
    model: setup.model,
    tradeStyle: setup.tradeStyle ?? "SWING",
    setupTimeframe: setup.setupTimeframe ?? "4h",
    entryTimeframe: setup.entryTimeframe ?? "1h",
    setupReason: setup.setupReason ?? "Confirmed strategy setup; maker limit entry.",
    confirmations: setup.confirmations ?? [],
    scoreBreakdown: setup.scoreBreakdown ?? {},
    riskReward: filledTargets.riskReward,
    audit: setup.audit ?? null,
    marginUsdt: number(position.initialMargin, pending.marginUsdt),
    notionalUsdt: number(position.positionValue, qty * actualEntry),
    entryOrderId: pending.orderId,
    stopOrderId: null,
    tp1OrderId: null,
    tp2OrderId: null,
    tp3OrderId: null,
    tp4OrderId: null,
    stage: 0,
    openedAt: Date.now(),
    maxHoldHours: setup.maxHoldHours
  };
  const openOrders = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol: setup.symbol }));
  const snapshot = {
    mode: "bingx-demo",
    baseUrl: DEMO_BASE,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    balance: null,
    positions,
    openOrders,
    dailyIncome: [],
    dailyIncomeAvailable: false,
    hedgeMode: pending.hedgeMode
  };
  const existingStop = findPositionStopOrder(snapshot, meta);
  meta.stopOrderId = existingStop ? orderId(existingStop) : null;
  if (!meta.stopOrderId) meta.stopOrderId = await placeStop(apiKey, apiSecret, meta, qty, meta.stopLoss);
  if (!meta.stopOrderId) {
    await closeBingXDemoPosition(apiKey, apiSecret, position, pending.hedgeMode, 1);
    const stillOpen = (await getBingXDemoPositions(apiKey, apiSecret)).some((p) => p.symbol === setup.symbol);
    if (stillOpen) throw new Error("Maker fill remains open without a verifiable stop-loss; emergency close did not confirm flat.");
    const orphanOrders = asBingXDemoOrders(await demoRequest(apiKey, apiSecret, "GET", "/openApi/swap/v2/trade/openOrders", { symbol: setup.symbol }));
    for (const order of orphanOrders) if (["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(String(order.type).toUpperCase())) {
      const id = orderId(order);
      if (id) try {
        await cancelBingXDemoOrder(apiKey, apiSecret, setup.symbol, id);
      } catch {
      }
    }
    return await closedMakerEntryResult(apiKey, apiSecret, pending, "NO_VERIFIABLE_STOP_LOSS_POSITION_EMERGENCY_CLOSED");
  }
  const precision = await contractQuantityPrecision(setup.symbol), half = roundDown(qty * 0.5, precision);
  let tpOk = true;
  try {
    meta.tp1OrderId = await placeTakeProfit(apiKey, apiSecret, meta, half > 0 ? half : qty, meta.tp1, "tp1");
    if (!meta.tp1OrderId) tpOk = false;
  } catch {
    tpOk = false;
  }
  return { status: "PROTECTED", meta, takeProfitProtection: tpOk ? "COMPLETE" : "REPAIR_REQUIRED" };
}
__name(reconcileBingXDemoLimitEntry, "reconcileBingXDemoLimitEntry");
function samePositionOrder(order, meta) {
  const side = String(order.side).toUpperCase() === closeSide(meta.side);
  const orderPositionSide = String(order.positionSide ?? "").toUpperCase();
  return String(order.symbol).toUpperCase() === meta.symbol.toUpperCase() && side && (!orderPositionSide || orderPositionSide === "BOTH" || orderPositionSide === meta.positionSide);
}
__name(samePositionOrder, "samePositionOrder");
function sameTargetPrice(order, target) {
  const price = number(order.stopPrice, NaN);
  return Number.isFinite(price) && Math.abs(price - target) <= Math.max(1e-8, Math.abs(target) * 1e-6);
}
__name(sameTargetPrice, "sameTargetPrice");
function isManagedProtectionOrder(order, meta) {
  const id = orderId(order);
  if (id && [meta.stopOrderId, meta.tp1OrderId, meta.tp2OrderId, meta.tp3OrderId, meta.tp4OrderId].includes(id)) return true;
  const client = String(order.clientOrderId ?? order.clientOrderID ?? "").toLowerCase();
  if (client.startsWith("smc-sl-") || /^smc-tp[1-4]-/.test(client)) return true;
  const type = String(order.type).toUpperCase();
  return type.includes("TAKE_PROFIT") && [meta.tp1, meta.tp2, meta.tp3, meta.tp4].some((target) => Number.isFinite(target) && sameTargetPrice(order, Number(target)));
}
__name(isManagedProtectionOrder, "isManagedProtectionOrder");
async function manageBingXDemoProtection(apiKey, apiSecret, snapshot, metadata) {
  const remaining = [];
  const closed = [], closedMetadata = [];
  let updated = 0;
  let cleanupPending = false;
  let cancellationBudget = 50;
  const attemptedCancelIds = /* @__PURE__ */ new Set();
  for (const meta of metadata) {
    meta.targetCount = meta.targetCount === 3 || meta.targetCount === 4 ? meta.targetCount : meta.tp4 ? 4 : meta.tp3 ? 3 : 2;
    meta.stage = Math.max(0, Math.min(Number(meta.stage) || 0, meta.targetCount - 1));
    const position = snapshot.positions.find((p) => p.symbol === meta.symbol && (p.positionSide === meta.side || p.positionSide === "BOTH"));
    const currentQty = position ? Math.abs(number(position.positionAmt)) : 0;
    if (!Number.isFinite(meta.stageBaseQty) || Number(meta.stageBaseQty) <= 0) meta.stageBaseQty = meta.stage === 0 ? meta.initialQty : currentQty;
    const positionOrders = snapshot.openOrders.filter((order) => samePositionOrder(order, meta));
    if (!position || currentQty <= 0) {
      const orphanOrders = positionOrders.filter((order) => ["STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT"].includes(String(order.type).toUpperCase()) && isManagedProtectionOrder(order, meta));
      const ids = orphanOrders.map((order) => orderId(order)).filter((id) => !!id && !attemptedCancelIds.has(id));
      if (orphanOrders.some((order) => !orderId(order))) {
        cleanupPending = true;
        remaining.push(meta);
        continue;
      }
      if (orphanOrders.length) {
        const batch = ids.slice(0, cancellationBudget);
        if (batch.length) {
          for (const id of batch) attemptedCancelIds.add(id);
          await cancelBingXDemoOrders(apiKey, apiSecret, meta.symbol, batch);
          cancellationBudget -= batch.length;
          updated += batch.length;
        }
        cleanupPending = true;
        remaining.push(meta);
        continue;
      }
      closed.push(meta.symbol);
      closedMetadata.push({ ...meta, closedAt: Date.now() });
      continue;
    }
    if (Number.isFinite(meta.maxHoldHours) && Number(meta.maxHoldHours) > 0 && Date.now() - meta.openedAt >= Number(meta.maxHoldHours) * 60 * 60 * 1e3) {
      await closeBingXDemoPosition(apiKey, apiSecret, position, snapshot.hedgeMode, 1, meta);
      closed.push(meta.symbol);
      closedMetadata.push({ ...meta, closedAt: Date.now() });
      updated++;
      continue;
    }
    const stageReached = meta.stage < meta.targetCount - 1 && currentQty <= Number(meta.stageBaseQty) * 0.65;
    if (stageReached) {
      meta.stage = meta.stage + 1;
      meta.stageBaseQty = currentQty;
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
      updated++;
    }
    const intendedStop = meta.stage >= 1 ? meta.entry : meta.stopLoss;
    const existingStop = findPositionStopOrder(snapshot, meta);
    const existingStopId = existingStop ? orderId(existingStop) : null;
    const existingStopPrice = existingStop ? number(existingStop.stopPrice, NaN) : NaN;
    const stopTolerance = Math.max(1e-8, Math.abs(intendedStop) * 1e-6);
    if (existingStopId && Number.isFinite(existingStopPrice) && Math.abs(existingStopPrice - intendedStop) <= stopTolerance) {
      if (meta.stopOrderId !== existingStopId) {
        meta.stopOrderId = existingStopId;
        updated++;
      }
    } else {
      meta.stopOrderId = await ensurePositionStop(apiKey, apiSecret, snapshot, meta, currentQty, intendedStop);
      updated++;
    }
    const targetPrice = meta.stage === 0 ? meta.tp1 : meta.stage === 1 ? meta.tp2 : meta.stage === 2 ? meta.tp3 ?? meta.tp2 : meta.tp4 ?? meta.tp3 ?? meta.tp2;
    const targetKind = "tp" + String(meta.stage + 1);
    const activeTargetId = meta.stage === 0 ? meta.tp1OrderId : meta.stage === 1 ? meta.tp2OrderId : meta.stage === 2 ? meta.tp3OrderId : meta.tp4OrderId;
    const targetIsFinal = meta.stage + 1 >= meta.targetCount;
    const halfTargetQty = roundDown(currentQty * 0.5, await contractQuantityPrecision(meta.symbol));
    const quantity = targetIsFinal || halfTargetQty <= 0 ? currentQty : halfTargetQty;
    const positionTpOrders = positionOrders.filter((order) => String(order.type).toUpperCase().includes("TAKE_PROFIT"));
    const managedTpOrders = positionTpOrders.filter((order) => isManagedProtectionOrder(order, meta));
    const unownedTpOrders = positionTpOrders.filter((order) => !isManagedProtectionOrder(order, meta));
    const targetCandidates = managedTpOrders.filter((order) => sameTargetPrice(order, targetPrice));
    const keepOrder = targetCandidates[0] ?? null;
    const cancelOrders = managedTpOrders.filter((order) => order !== keepOrder);
    const cancelIds = cancelOrders.map((order) => orderId(order)).filter((id) => !!id && !attemptedCancelIds.has(id));
    const missingCancelId = cancelOrders.some((order) => !orderId(order));
    if (missingCancelId || cancelOrders.some((order) => {
      const id = orderId(order);
      return !!id && attemptedCancelIds.has(id);
    })) {
      cleanupPending = true;
      remaining.push(meta);
      continue;
    }
    if (cancelIds.length) {
      const batch = cancelIds.slice(0, cancellationBudget);
      if (batch.length) {
        for (const id of batch) attemptedCancelIds.add(id);
        await cancelBingXDemoOrders(apiKey, apiSecret, meta.symbol, batch);
        cancellationBudget -= batch.length;
        updated += batch.length;
      }
      cleanupPending = true;
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
      if (meta.stage === 0) meta.tp1OrderId = keepOrder ? orderId(keepOrder) : null;
      else if (meta.stage === 1) meta.tp2OrderId = keepOrder ? orderId(keepOrder) : null;
      else if (meta.stage === 2) meta.tp3OrderId = keepOrder ? orderId(keepOrder) : null;
      else meta.tp4OrderId = keepOrder ? orderId(keepOrder) : null;
      remaining.push(meta);
      continue;
    }
    if (unownedTpOrders.length) {
      cleanupPending = true;
      console.warn("BingX unmanaged TP orders detected; preserving them and blocking new entries", meta.symbol, unownedTpOrders.length);
      remaining.push(meta);
      continue;
    }
    if (keepOrder) {
      const keepId = orderId(keepOrder);
      meta.tp1OrderId = null;
      meta.tp2OrderId = null;
      meta.tp3OrderId = null;
      meta.tp4OrderId = null;
      if (meta.stage === 0) meta.tp1OrderId = keepId;
      else if (meta.stage === 1) meta.tp2OrderId = keepId;
      else if (meta.stage === 2) meta.tp3OrderId = keepId;
      else meta.tp4OrderId = keepId;
      if (keepId && keepId !== activeTargetId) updated++;
    } else {
      if (unownedTpOrders.length) {
        cleanupPending = true;
        remaining.push(meta);
        continue;
      }
      if (cancellationBudget <= 0) {
        cleanupPending = true;
        remaining.push(meta);
        continue;
      }
      if (quantity > 0) {
        const id = await placeTakeProfit(apiKey, apiSecret, meta, quantity, targetPrice, targetKind);
        if (!id) throw new Error("BingX demo " + targetKind.toUpperCase() + " protection did not return an order ID.");
        meta.tp1OrderId = null;
        meta.tp2OrderId = null;
        meta.tp3OrderId = null;
        meta.tp4OrderId = null;
        if (meta.stage === 0) meta.tp1OrderId = id;
        else if (meta.stage === 1) meta.tp2OrderId = id;
        else if (meta.stage === 2) meta.tp3OrderId = id;
        else meta.tp4OrderId = id;
        updated++;
      }
    }
    remaining.push(meta);
  }
  const untrackedLivePositions = snapshot.positions.filter((position) => {
    const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && number(position.positionAmt) < 0 ? "SHORT" : "LONG";
    return !metadata.some((meta) => meta.symbol === position.symbol && meta.side === side);
  });
  if (untrackedLivePositions.length) {
    cleanupPending = true;
    console.warn("Untracked BingX VST live positions preserved; new entries remain blocked", JSON.stringify({
      positions: untrackedLivePositions.map((position) => ({ symbol: position.symbol, side: position.positionSide === "SHORT" || position.positionSide === "BOTH" && number(position.positionAmt) < 0 ? "SHORT" : "LONG" }))
    }));
  }
  const botOwnedProtectionOrders = snapshot.openOrders.filter((order) => {
    const clientId = String(order.clientOrderId ?? order.clientOrderID ?? "").toLowerCase();
    return (clientId.startsWith("smc-sl-") || /^smc-tp[1-4]-/.test(clientId)) && ["STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT"].includes(String(order.type).toUpperCase());
  });
  const orphanIdsBySymbol = /* @__PURE__ */ new Map();
  let orphanOrderIdMissing = false, untrackedPositionProtectionCount = 0;
  for (const order of botOwnedProtectionOrders) {
    const hasExchangePosition = snapshot.positions.some((position) => {
      const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && number(position.positionAmt) < 0 ? "SHORT" : "LONG";
      const orderPositionSide = String(order.positionSide ?? "").toUpperCase();
      return position.symbol === order.symbol && String(order.side).toUpperCase() === closeSide(side) && (!orderPositionSide || orderPositionSide === "BOTH" || orderPositionSide === position.positionSide);
    });
    if (hasExchangePosition) {
      const hasTrackedMeta = metadata.some((meta) => {
        const position = snapshot.positions.find((p) => p.symbol === meta.symbol && (p.positionSide === meta.side || p.positionSide === "BOTH"));
        if (!position || position.symbol !== order.symbol) return false;
        const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && number(position.positionAmt) < 0 ? "SHORT" : "LONG";
        return side === meta.side && String(order.side).toUpperCase() === closeSide(side);
      });
      if (!hasTrackedMeta) untrackedPositionProtectionCount++;
      continue;
    }
    const id = orderId(order);
    if (!id) {
      orphanOrderIdMissing = true;
      continue;
    }
    if (attemptedCancelIds.has(id)) continue;
    const ids = orphanIdsBySymbol.get(order.symbol) ?? [];
    ids.push(id);
    orphanIdsBySymbol.set(order.symbol, ids);
  }
  let orphanProtectionOrdersCanceled = 0;
  for (const [symbol, ids] of orphanIdsBySymbol) {
    if (cancellationBudget <= 0) {
      cleanupPending = true;
      break;
    }
    const batch = [...new Set(ids)].slice(0, Math.min(10, cancellationBudget));
    if (!batch.length) continue;
    for (const id of batch) attemptedCancelIds.add(id);
    await cancelBingXDemoOrders(apiKey, apiSecret, symbol, batch);
    cancellationBudget -= batch.length;
    orphanProtectionOrdersCanceled += batch.length;
    updated += batch.length;
    cleanupPending = true;
  }
  if (orphanOrderIdMissing || untrackedPositionProtectionCount > 0) {
    cleanupPending = true;
    console.warn("BingX bot protection orders require reconciliation; untracked live positions are preserved", JSON.stringify({ orphanOrderIdMissing, untrackedPositionProtectionCount }));
  }
  if (orphanProtectionOrdersCanceled > 0) {
    console.warn("BingX orphan bot-owned protection orders canceled; new entries remain blocked until the next complete exchange snapshot", JSON.stringify({ canceled: orphanProtectionOrdersCanceled, remainingSymbols: orphanIdsBySymbol.size }));
  }
  const totalTpOrders = snapshot.openOrders.filter((order) => String(order.type).toUpperCase().includes("TAKE_PROFIT")).length;
  if (snapshot.openOrders.length >= 150 || totalTpOrders >= 50) {
    cleanupPending = true;
    console.warn("BingX VST order count is above the safe entry threshold; new entries remain blocked", JSON.stringify({ openOrders: snapshot.openOrders.length, takeProfitOrders: totalTpOrders }));
  }
  return { snapshot, metadata: remaining, updated, closed, closedMetadata, cleanupPending };
}
__name(manageBingXDemoProtection, "manageBingXDemoProtection");

// src/market-data-utils.ts
function aggregateClosedCandles(source, targetMs, sourceMs) {
  if (!Number.isFinite(targetMs) || !Number.isFinite(sourceMs) || targetMs <= sourceMs || targetMs % sourceMs !== 0) return [];
  const expected = targetMs / sourceMs;
  const groups = /* @__PURE__ */ new Map();
  for (const candle of source.slice().sort((a, b) => a.time - b.time)) {
    if (!Number.isFinite(candle.time) || candle.time % sourceMs !== 0) continue;
    const start = Math.floor(candle.time / targetMs) * targetMs;
    const rows = groups.get(start) ?? [];
    rows.push(candle);
    groups.set(start, rows);
  }
  const result = [];
  for (const [start, rows] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.time - b.time);
    if (rows.length !== expected || rows[0].time !== start || rows[rows.length - 1].time + sourceMs !== start + targetMs) continue;
    if (rows.some((row, i) => row.time !== start + i * sourceMs)) continue;
    const sumOptional = /* @__PURE__ */ __name((key) => {
      const values = rows.map((row) => row[key]);
      return values.every((value) => value !== void 0 && Number.isFinite(Number(value))) ? values.reduce((sum, value) => sum + Number(value), 0) : void 0;
    }, "sumOptional");
    result.push({
      time: start,
      open: rows[0].open,
      high: Math.max(...rows.map((row) => row.high)),
      low: Math.min(...rows.map((row) => row.low)),
      close: rows[rows.length - 1].close,
      volume: sumOptional("volume"),
      quoteVolume: sumOptional("quoteVolume"),
      takerBuyVolume: sumOptional("takerBuyVolume"),
      takerBuyQuoteVolume: sumOptional("takerBuyQuoteVolume")
    });
  }
  return result;
}
__name(aggregateClosedCandles, "aggregateClosedCandles");

// src/bingx-trade-history.ts
function finite(value) {
  if (value === null || value === void 0 || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
__name(finite, "finite");
function timestamp(value) {
  const n = finite(value);
  if (n !== null) return n < 1e12 ? n * 1e3 : n;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
__name(timestamp, "timestamp");
function truthy(value) {
  return value === true || String(value ?? "").toLowerCase() === "true" || String(value ?? "") === "1";
}
__name(truthy, "truthy");
function closeReason(type) {
  if (["TAKE_PROFIT_MARKET", "TAKE_PROFIT"].includes(type)) return "TP";
  if (["STOP_MARKET", "STOP"].includes(type)) return "SL";
  if (["LIQUIDATION", "ADL"].includes(type)) return "LIQUIDATION";
  return null;
}
__name(closeReason, "closeReason");
function buildBingXOrderHistoryClosedTrades(orders) {
  const entries = /* @__PURE__ */ new Map();
  const isClose = /* @__PURE__ */ __name((order) => {
    const type = String(order.type ?? "").toUpperCase();
    return !!closeReason(type) || truthy(order.reduceOnly) || truthy(order.closePosition);
  }, "isClose");
  for (const order of orders) {
    const status = String(order.status ?? "").toUpperCase();
    const qty = finite(order.executedQty) ?? 0, price = finite(order.avgPrice) ?? 0;
    const positionId = order.positionID == null ? "" : String(order.positionID);
    if (!positionId || !order.symbol || !["FILLED", "PARTIALLY_FILLED", "PARTIALLYFILLED"].includes(status) || isClose(order) || qty <= 0 || price <= 0) continue;
    const key = String(order.symbol) + "|" + positionId, entry = entries.get(key) ?? { qty: 0, quote: 0 };
    entry.qty += qty;
    entry.quote += qty * price;
    entries.set(key, entry);
  }
  const byId = /* @__PURE__ */ new Map();
  for (const order of orders) {
    const status = String(order.status ?? "").toUpperCase();
    const qty = finite(order.executedQty) ?? 0, exitPrice = finite(order.avgPrice);
    const type = String(order.type ?? "").toUpperCase();
    const mappedReason = closeReason(type);
    if (!order.symbol || !["FILLED", "PARTIALLY_FILLED", "PARTIALLYFILLED"].includes(status) || qty <= 0 || !mappedReason && !truthy(order.reduceOnly) && !truthy(order.closePosition)) continue;
    const rawId = order.orderID ?? order.orderId;
    if (rawId == null) continue;
    const grossPnl = finite(order.profit ?? order.realizedPnl);
    if (grossPnl === null) continue;
    const sideText = String(order.positionSide ?? "").toUpperCase();
    const fillSide = String(order.side ?? "").toUpperCase();
    const side = sideText === "LONG" ? "LONG" : sideText === "SHORT" ? "SHORT" : fillSide === "SELL" ? "LONG" : "SHORT";
    const positionId = order.positionID == null ? null : String(order.positionID);
    const entry = positionId ? entries.get(String(order.symbol) + "|" + positionId) : void 0;
    const commission = finite(order.commission) ?? 0;
    const reason = mappedReason ?? "MANUAL_CLOSE";
    const id = "bingx-vst-" + order.symbol + "-" + String(rawId);
    byId.set(id, {
      id,
      symbol: order.symbol,
      side,
      model: "BingX VST",
      entry: entry && entry.qty > 0 ? entry.quote / entry.qty : null,
      exitPrice,
      qty,
      feesPaidUsdt: Number(Math.abs(commission).toFixed(8)),
      pnlUsdt: Number((grossPnl - Math.abs(commission)).toFixed(8)),
      closeReason: reason,
      orderType: type || "MARKET",
      closedAt: timestamp(order.updateTime ?? order.time),
      positionId,
      executionEvents: [{ event: "BINGX_ORDER_HISTORY", qty, executionPrice: exitPrice ?? 0, at: timestamp(order.updateTime ?? order.time), orderType: type || "MARKET" }],
      source: "BINGX_VST_ORDER_HISTORY_FALLBACK"
    });
  }
  return [...byId.values()].sort((a, b) => b.closedAt - a.closedAt);
}
__name(buildBingXOrderHistoryClosedTrades, "buildBingXOrderHistoryClosedTrades");
function mergeBingXOrderHistorySnapshots(stale, fresh, limit = 3e3) {
  const byId = /* @__PURE__ */ new Map();
  for (const order of stale) {
    const id = order.orderID ?? order.orderId;
    if (order.symbol && id != null) byId.set(String(order.symbol) + "|" + String(id), order);
  }
  for (const order of fresh) {
    const id = order.orderID ?? order.orderId;
    if (order.symbol && id != null) byId.set(String(order.symbol) + "|" + String(id), order);
  }
  return [...byId.values()].sort((a, b) => timestamp(b.updateTime ?? b.time) - timestamp(a.updateTime ?? a.time)).slice(0, Math.max(1, Math.min(3e3, Math.trunc(limit) || 3e3)));
}
__name(mergeBingXOrderHistorySnapshots, "mergeBingXOrderHistorySnapshots");

// src/cloudflare-usage.ts
function rowString(row, key) {
  return String(row[key] ?? "").toLowerCase();
}
__name(rowString, "rowString");
function rowQuantity(row) {
  const value = Number(row.ConsumedQuantity);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
__name(rowQuantity, "rowQuantity");
function summarizeCloudflareBillableUsage(rows) {
  const groups = {
    workersRequests: [],
    workersDurationGbSeconds: [],
    workersKVReads: [],
    workersKVWrites: [],
    durableObjectSqlRowsRead: [],
    durableObjectSqlRowsWritten: []
  };
  const availableMetrics = /* @__PURE__ */ new Set();
  for (const value2 of rows) {
    if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) continue;
    const row = value2;
    const id = rowString(row, "x_BillableMetricId");
    const name = rowString(row, "x_BillableMetricName");
    const description = rowString(row, "ChargeDescription");
    const familyId = rowString(row, "x_ProductFamilyId");
    const familyName = rowString(row, "x_ProductFamilyName");
    const unit = rowString(row, "ConsumedUnit");
    const metric = [id, name, description].join(" ");
    const family = [familyId, familyName].join(" ");
    const descriptor = `${metric} ${family}`;
    const isDurableObject = descriptor.includes("durable_objects") || descriptor.includes("durable objects");
    const isWorkersKv = descriptor.includes("workers_kv") || descriptor.includes("workers kv");
    const isWorkers = !isDurableObject && (family.includes("workers") || metric.includes("workers"));
    const isSqlRows = isDurableObject && metric.includes("sql") && (metric.includes("row") || unit.includes("row"));
    const key = id || name || description || "unknown";
    availableMetrics.add(`${key}${name ? ` \xB7 ${row.x_BillableMetricName}` : ""}`);
    if (isSqlRows && metric.includes("read")) groups.durableObjectSqlRowsRead.push(row);
    else if (isSqlRows && metric.includes("writ")) groups.durableObjectSqlRowsWritten.push(row);
    else if (isWorkersKv && (metric.includes("read") || metric.includes("class b"))) groups.workersKVReads.push(row);
    else if (isWorkersKv && (metric.includes("writ") || metric.includes("class a"))) groups.workersKVWrites.push(row);
    else if (isWorkers && !isWorkersKv && metric.includes("request")) groups.workersRequests.push(row);
    else if (isWorkers && !isWorkersKv && (metric.includes("duration") || unit.includes("gb-sec") || unit.includes("gb second"))) {
      groups.workersDurationGbSeconds.push(row);
    }
  }
  const total = /* @__PURE__ */ __name((items) => items.reduce((sum, row) => sum + rowQuantity(row), 0), "total");
  const metricNames = /* @__PURE__ */ __name((items) => [...new Set(items.map(
    (row) => String(row.x_BillableMetricId || row.x_BillableMetricName || row.ChargeDescription || "unknown")
  ))], "metricNames");
  const daily = /* @__PURE__ */ new Map();
  const addSamples = /* @__PURE__ */ __name((items, key) => {
    for (const row of items) {
      const rawDate = String(row.ChargePeriodStart ?? "");
      const date = rawDate ? rawDate.slice(0, 10) : null;
      const sampleKey = date ?? "unknown";
      const sample = daily.get(sampleKey) ?? {
        date,
        workersRequests: 0,
        workersDurationGbSeconds: 0,
        workersKVReads: 0,
        workersKVWrites: 0,
        durableObjectSqlRowsRead: 0,
        durableObjectSqlRowsWritten: 0
      };
      sample[key] += rowQuantity(row);
      daily.set(sampleKey, sample);
    }
  }, "addSamples");
  for (const key of Object.keys(groups)) addSamples(groups[key], key);
  const value = /* @__PURE__ */ __name((key) => groups[key].length ? total(groups[key]) : null, "value");
  return {
    workersRequests: value("workersRequests"),
    workersDurationGbSeconds: value("workersDurationGbSeconds"),
    workersKVReads: value("workersKVReads"),
    workersKVWrites: value("workersKVWrites"),
    durableObjectSqlRowsRead: value("durableObjectSqlRowsRead"),
    durableObjectSqlRowsWritten: value("durableObjectSqlRowsWritten"),
    matchedMetrics: {
      workersRequests: metricNames(groups.workersRequests),
      workersDurationGbSeconds: metricNames(groups.workersDurationGbSeconds),
      workersKVReads: metricNames(groups.workersKVReads),
      workersKVWrites: metricNames(groups.workersKVWrites),
      durableObjectSqlRowsRead: metricNames(groups.durableObjectSqlRowsRead),
      durableObjectSqlRowsWritten: metricNames(groups.durableObjectSqlRowsWritten)
    },
    availableMetrics: [...availableMetrics].sort(),
    samples: [...daily.values()].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")))
  };
}
__name(summarizeCloudflareBillableUsage, "summarizeCloudflareBillableUsage");

// src/activity-ranking.ts
var MINIMUM_CANDLES = 31;
var MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1e3;
var ACTIVITY_MINIMUM_COVERAGE_PCT = 90;
var ACTIVITY_PRIORITY_MINIMUM_COVERAGE_PCT = 25;
var ACTIVITY_MINIMUM_PERCENTILE = 20;
function average(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}
__name(average, "average");
function percentileRank(value, population) {
  if (!population.length || !Number.isFinite(value)) return 0;
  let below = 0, equal = 0;
  for (const x of population) {
    if (x < value) below++;
    else if (x === value) equal++;
  }
  return (below + equal / 2) / population.length * 100;
}
__name(percentileRank, "percentileRank");
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
__name(positive, "positive");
function buildActivitySnapshot(symbol, candles, n, quote = {}, measuredAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!Array.isArray(candles) || candles.length < MINIMUM_CANDLES || !positive(n)) return null;
  const rows = candles.slice(-MINIMUM_CANDLES);
  if (!rows.every((x) => Number.isFinite(x.time) && Number.isFinite(x.high) && Number.isFinite(x.low) && Number.isFinite(x.close) && x.low > 0 && x.high >= x.low && x.close > 0)) return null;
  const tr = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i], p = rows[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const close = rows[rows.length - 1].close, r7 = average(tr.slice(-7)), r30 = average(tr.slice(-30));
  if (![close, r7, r30].every(Number.isFinite) || close <= 0 || r30 <= 0) return null;
  const volumes = rows.slice(-30).map((c) => positive(c.quoteVolume) ? c.quoteVolume : positive(c.volume) ? c.volume * c.close : null).filter((v) => v !== null && Number.isFinite(v));
  const average30dQuoteVolume = volumes.length >= 25 ? average(volumes) : null;
  const bid = Number(quote.bidPrice), ask = Number(quote.askPrice);
  const spreadPct = positive(bid) && positive(ask) && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 100 : null;
  const tickerVolume = Number(quote.quoteVolume24h), lastVolume = Number(rows[rows.length - 1].quoteVolume);
  const quoteVolume24h = positive(tickerVolume) ? tickerVolume : positive(lastVolume) ? lastVolume : null;
  const volumeExpansion24h30d = positive(quoteVolume24h) && positive(average30dQuoteVolume) ? quoteVolume24h / average30dQuoteVolume : null;
  return { symbol: symbol.toUpperCase(), measuredAt, nPct: n / close * 100, expansion7d30d: r7 / r30, quoteVolume24h, average30dQuoteVolume, volumeExpansion24h30d, spreadPct };
}
__name(buildActivitySnapshot, "buildActivitySnapshot");
function rankActivitySnapshots(snapshots, universeSymbols, now = Date.now()) {
  const universe = new Set(universeSymbols.map((x) => x.toUpperCase()));
  const valid2 = Object.values(snapshots).filter((x) => {
    const age = now - Date.parse(x.measuredAt);
    return universe.has(x.symbol.toUpperCase()) && Object.prototype.hasOwnProperty.call(x, "average30dQuoteVolume") && Object.prototype.hasOwnProperty.call(x, "spreadPct") && positive(x.nPct) && positive(x.expansion7d30d) && Number.isFinite(age) && age >= 0 && age <= MAX_SNAPSHOT_AGE_MS;
  });
  const nVals = valid2.map((x) => x.nPct), expVals = valid2.map((x) => x.expansion7d30d);
  const volVals = valid2.map((x) => x.average30dQuoteVolume).filter((v) => positive(v));
  const volumeExpansionValues = valid2.map((x) => x.volumeExpansion24h30d).filter((v) => positive(v));
  const spreadVals = valid2.map((x) => x.spreadPct).filter((v) => v !== null && Number.isFinite(v) && v >= 0);
  const partial = valid2.map((snapshot) => {
    const nRank = percentileRank(snapshot.nPct, nVals), expRank = percentileRank(snapshot.expansion7d30d, expVals);
    const hasVol = positive(snapshot.average30dQuoteVolume) && volVals.length > 0;
    const volRank = hasVol ? percentileRank(snapshot.average30dQuoteVolume, volVals) : null;
    const volumeExpansionRank = positive(snapshot.volumeExpansion24h30d) && volumeExpansionValues.length ? percentileRank(snapshot.volumeExpansion24h30d, volumeExpansionValues) : null;
    const score = volumeExpansionRank !== null ? nRank * 0.55 + expRank * 0.3 + volumeExpansionRank * 0.15 : nRank * (0.55 / 0.85) + expRank * (0.3 / 0.85);
    const hasSpread = snapshot.spreadPct !== null && Number.isFinite(snapshot.spreadPct) && snapshot.spreadPct >= 0 && spreadVals.length > 0;
    const spreadQualityPercentile = hasSpread ? 100 - percentileRank(snapshot.spreadPct, spreadVals) : null;
    const liquidityParts = [...volRank !== null ? [volRank] : [], ...spreadQualityPercentile !== null ? [spreadQualityPercentile] : []];
    const liquidityPercentile = liquidityParts.length ? average(liquidityParts) : null;
    const liquidityStatus = liquidityPercentile === null ? "UNVERIFIED" : liquidityPercentile >= 80 ? "GOOD" : liquidityPercentile >= 20 ? "ACCEPTABLE" : "POOR";
    return { snapshot, nRank, expRank, volRank, volumeExpansionRank, spreadQualityPercentile, score, liquidityPercentile, liquidityStatus };
  });
  const scoreVals = partial.map((x) => x.score), coveragePct = universe.size ? valid2.length / universe.size * 100 : 0;
  const coverageReady = universe.size > 0 && coveragePct >= ACTIVITY_MINIMUM_COVERAGE_PCT;
  const bySymbol = {};
  let eligibleSymbols = 0, lowActivitySymbols = 0, lowQuoteVolumeSymbols = 0, wideSpreadSymbols = 0;
  for (const x of partial) {
    const activityPercentile = percentileRank(x.score, scoreVals);
    const lowActivity = activityPercentile < ACTIVITY_MINIMUM_PERCENTILE;
    const lowQuoteVolume = x.volRank !== null && x.volRank < ACTIVITY_MINIMUM_PERCENTILE;
    const wideSpread = x.spreadQualityPercentile !== null && x.spreadQualityPercentile < ACTIVITY_MINIMUM_PERCENTILE;
    const pairEligible = !lowActivity && !lowQuoteVolume && !wideSpread;
    const eligible = pairEligible;
    const pairReason = lowActivity ? "LOW_RELATIVE_ACTIVITY" : lowQuoteVolume ? "LOW_QUOTE_VOLUME" : wideSpread ? "WIDE_SPREAD" : "READY";
    const tier = activityPercentile >= 80 ? "TOP_20" : activityPercentile >= 20 ? "MIDDLE_60" : "BOTTOM_20";
    const reason = !coverageReady ? "UNIVERSE_COVERAGE_INCOMPLETE" : lowActivity ? "LOW_RELATIVE_ACTIVITY" : lowQuoteVolume ? "LOW_QUOTE_VOLUME" : wideSpread ? "WIDE_SPREAD" : "READY";
    if (eligible) eligibleSymbols++;
    else if (lowActivity) lowActivitySymbols++;
    else if (lowQuoteVolume) lowQuoteVolumeSymbols++;
    else if (wideSpread) wideSpreadSymbols++;
    const priorityScore = activityPercentile * 0.8 + (x.liquidityPercentile ?? 50) * 0.2;
    const priorityTier = priorityScore >= 70 ? "HIGH" : priorityScore >= 20 ? "NORMAL" : "LOW";
    bySymbol[x.snapshot.symbol] = {
      ...x.snapshot,
      nPctPercentile: Number(x.nRank.toFixed(2)),
      expansionPercentile: Number(x.expRank.toFixed(2)),
      quoteVolumePercentile: x.volRank === null ? null : Number(x.volRank.toFixed(2)),
      volumeExpansionPercentile: x.volumeExpansionRank === null ? null : Number(x.volumeExpansionRank.toFixed(2)),
      spreadQualityPercentile: x.spreadQualityPercentile === null ? null : Number(x.spreadQualityPercentile.toFixed(2)),
      activityPercentile: Number(activityPercentile.toFixed(2)),
      liquidityPercentile: x.liquidityPercentile === null ? null : Number(x.liquidityPercentile.toFixed(2)),
      liquidityStatus: x.liquidityStatus,
      priorityScore: Number(priorityScore.toFixed(2)),
      priorityTier,
      coveragePct: Number(coveragePct.toFixed(2)),
      coverageReady,
      pairEligible,
      pairReason,
      eligible,
      tier,
      reason
    };
  }
  return { bySymbol, summary: {
    measuredAt: new Date(now).toISOString(),
    universeSize: universe.size,
    coveredSymbols: valid2.length,
    coveragePct: Number(coveragePct.toFixed(2)),
    minimumCoveragePct: ACTIVITY_MINIMUM_COVERAGE_PCT,
    minimumPriorityCoveragePct: ACTIVITY_PRIORITY_MINIMUM_COVERAGE_PCT,
    minimumActivityPercentile: ACTIVITY_MINIMUM_PERCENTILE,
    priorityReady: coveragePct >= ACTIVITY_PRIORITY_MINIMUM_COVERAGE_PCT,
    ready: coverageReady,
    eligibleSymbols,
    lowActivitySymbols,
    lowQuoteVolumeSymbols,
    wideSpreadSymbols,
    spreadDataAvailable: spreadVals.length > 0,
    averageVolumeDataAvailable: volVals.length > 0
  } };
}
__name(rankActivitySnapshots, "rankActivitySnapshots");
function buildActivityPriorityBatch(universeSymbols, ranking, cursor, batchSize = 25, prioritySlots = 5, forcedPrioritySymbols = []) {
  if (!universeSymbols.length || batchSize <= 0) return { symbols: [], prioritySymbols: [], rotatingSymbols: [], nextCursor: 0, rotationAdvance: 0 };
  const size = Math.min(Math.floor(batchSize), universeSymbols.length), slots = Math.min(Math.max(0, Math.floor(prioritySlots)), Math.max(0, size - 1));
  const universe = new Set(universeSymbols);
  const forced = [...new Set(forcedPrioritySymbols.filter((symbol) => universe.has(symbol)))].slice(0, slots);
  const forcedSet = new Set(forced);
  const ranked = Object.values(ranking).filter((row) => universe.has(row.symbol) && !forcedSet.has(row.symbol) && Number.isFinite(row.coveragePct) && row.coveragePct >= ACTIVITY_PRIORITY_MINIMUM_COVERAGE_PCT && Number.isFinite(row.activityPercentile) && row.activityPercentile > 0 && Number.isFinite(row.priorityScore) && row.priorityScore > 0).sort((a, b) => b.priorityScore - a.priorityScore || b.activityPercentile - a.activityPercentile).map((row) => row.symbol);
  const prioritySymbols = [...forced, ...ranked].slice(0, slots);
  const prioritySet = new Set(prioritySymbols), rotatingSymbols = [];
  const rotationSlots = Math.min(size - prioritySymbols.length, universeSymbols.length - prioritySymbols.length);
  let rotationAdvance = 0;
  while (rotatingSymbols.length < rotationSlots && rotationAdvance < universeSymbols.length) {
    const symbol = universeSymbols[(Math.max(0, Math.floor(cursor)) + rotationAdvance) % universeSymbols.length];
    rotationAdvance++;
    if (!prioritySet.has(symbol)) rotatingSymbols.push(symbol);
  }
  return {
    symbols: [...prioritySymbols, ...rotatingSymbols],
    prioritySymbols,
    rotatingSymbols,
    nextCursor: (Math.max(0, Math.floor(cursor)) + rotationAdvance) % universeSymbols.length,
    rotationAdvance
  };
}
__name(buildActivityPriorityBatch, "buildActivityPriorityBatch");

// src/scanner-policy.ts
var MARKET_DATA_REQUEST_TIMEOUT_MS = 7e3;
var MARKET_DATA_MAX_ATTEMPTS = 2;
var MARKET_DATA_REQUEST_SPACING_MS = 1100;
function resolveClosedCandleCacheTtlMs(latestClosedCandleOpenTime, durationMs, now = Date.now(), settleDelayMs = 1e3) {
  if (!Number.isFinite(latestClosedCandleOpenTime) || !Number.isFinite(durationMs) || durationMs <= 0) return 1e3;
  const nextClosedCandleAt = latestClosedCandleOpenTime + durationMs * 2;
  return Math.max(1e3, nextClosedCandleAt + settleDelayMs - now);
}
__name(resolveClosedCandleCacheTtlMs, "resolveClosedCandleCacheTtlMs");
function marketDataRetryDelayMs(attempt) {
  return Math.min(5e3, 1e3 * 2 ** Math.max(0, attempt));
}
__name(marketDataRetryDelayMs, "marketDataRetryDelayMs");
function isRetryableMarketDataFailure(status, code, networkError = false) {
  return networkError || status === 408 || status === 425 || status === 429 || typeof status === "number" && status >= 500 || code === 100410 || code === 100500 || code === 109500;
}
__name(isRetryableMarketDataFailure, "isRetryableMarketDataFailure");
var VALID_USDT_PERPETUAL_SYMBOL = /^[A-Z0-9]{1,20}-USDT$/;
var NON_CRYPTO_UNDERLYING = /(?:NCFX|ALUMINIUM|ALUMINUM|COPPER|GOLD|XAU|SILVER|XAG|PLATINUM|PALLADIUM|IRONORE|LITHIUM|NICKEL|ZINC|LEAD|TIN|URANIUM|MINING|CRUDEOIL|NATURALGAS|NATGAS|GASOLINE|BRENT|WTI|USOIL|UKOIL|WHEAT|CORN|SOYBEAN|SUGAR|COFFEE|COTTON|COCOA)/i;
var NON_CRYPTO_SYMBOL_ALIAS = /^(?:NCSK|NCSI|NCCO|NCFX|4STOCK$)/i;
var NON_CRYPTO_INDEX = /^(?:US30|US100|US500|SP500|SPX500|NAS100|NASDAQ100|GER40|DE40|DAX|UK100|FTSE100|JP225|NIKKEI225|HK50|AUS200|EU50|FRA40|VIX|DJI|NDX|RUSSELL2000|US2000)$/i;
var FIAT_CODES = /* @__PURE__ */ new Set(["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "CNH", "HKD", "SGD", "TRY", "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RUB", "BRL", "INR", "KRW", "TWD", "THB", "IDR", "MYR", "PHP", "SAR", "AED", "ILS", "QAR", "KWD", "BHD", "OMR", "PKR"]);
var EQUITY_UNDERLYINGS = /* @__PURE__ */ new Set(["AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "BRK", "AVGO", "LLY", "TSM", "JPM", "V", "MA", "UNH", "XOM", "KO", "PEP", "COST", "WMT", "DIS", "NFLX", "ADBE", "CRM", "ORCL", "INTC", "AMD", "IBM", "GE", "BA", "PLTR", "COIN", "MSTR", "HOOD", "UBER", "ABNB", "SHOP", "SPOT", "QQQ", "SPY", "IVV", "VOO", "IWM", "AEM", "BHP", "RIO", "VALE", "FCX", "SCCO", "TECK", "GDX", "GDXJ", "WPM", "PAAS", "AG", "HL", "KGC"]);
var NON_CRYPTO_CONTRACT_NAME = /(?:FOREX|FX PAIR|CFD|COMMODITY|STOCK|EQUITY|SHARES|ETF|INDEX|NASDAQ|DOW JONES|S&P 500|GOLD|SILVER|PLATINUM|PALLADIUM|CRUDE OIL|NATURAL GAS|WHEAT|CORN|SOYBEAN|MINING|INCORPORATED|\bINC\b|\bCORP\b|\bPLC\b|\bLTD\b)/i;
function isFiatCross(base) {
  return base.length === 6 && FIAT_CODES.has(base.slice(0, 3)) && FIAT_CODES.has(base.slice(3, 6));
}
__name(isFiatCross, "isFiatCross");
function isSyntheticFiatReference(base) {
  const fiatSuffix = [...FIAT_CODES].sort((a, b) => b.length - a.length).find((code) => base.endsWith(code));
  if (!fiatSuffix) return false;
  const underlying = base.slice(0, -fiatSuffix.length);
  return /\d$/.test(underlying) || /^(?:NCSK|NCSI|NCCO|NCFX)/i.test(base);
}
__name(isSyntheticFiatReference, "isSyntheticFiatReference");
function isEligibleUsdtPerpetualSymbol(value) {
  const symbol = String(value ?? "").toUpperCase();
  if (!VALID_USDT_PERPETUAL_SYMBOL.test(symbol)) return false;
  const base = symbol.slice(0, -5);
  if (NON_CRYPTO_UNDERLYING.test(base) || NON_CRYPTO_SYMBOL_ALIAS.test(base) || NON_CRYPTO_INDEX.test(base) || EQUITY_UNDERLYINGS.has(base) || isFiatCross(base) || isSyntheticFiatReference(base)) return false;
  if (/^(?:NCCO)?[A-Z]+\d+USD$/.test(base)) return false;
  return true;
}
__name(isEligibleUsdtPerpetualSymbol, "isEligibleUsdtPerpetualSymbol");
function isEligibleUsdtPerpetualContract(value) {
  const contract = typeof value === "object" && value !== null ? value : { symbol: value };
  const symbol = String(contract.symbol ?? "").toUpperCase();
  if (!isEligibleUsdtPerpetualSymbol(symbol)) return false;
  const base = symbol.slice(0, -5);
  const currency = String(contract.currency ?? "").toUpperCase();
  if (currency !== "USDT") return false;
  const asset = String(contract.asset ?? "").toUpperCase();
  const multiplierBase = base.replace(/^\d+(?=[A-Z])/, "");
  if (asset && asset !== base && asset !== multiplierBase) return false;
  const status = contract.status;
  if (status !== void 0 && status !== null && Number(status) !== 1) return false;
  const apiStateOpen = String(contract.apiStateOpen ?? "").toLowerCase();
  if (apiStateOpen === "false" || apiStateOpen === "0") return false;
  const name = String(contract.name ?? "").toUpperCase();
  const displayName = String(contract.displayName ?? "").toUpperCase();
  const contractLabel = [name, displayName].filter(Boolean).join(" ");
  if (NON_CRYPTO_UNDERLYING.test(asset + " " + contractLabel) || NON_CRYPTO_CONTRACT_NAME.test(contractLabel)) return false;
  if (NON_CRYPTO_INDEX.test(asset) || EQUITY_UNDERLYINGS.has(base) || isFiatCross(base) || isSyntheticFiatReference(base)) return false;
  return true;
}
__name(isEligibleUsdtPerpetualContract, "isEligibleUsdtPerpetualContract");
function buildEligibleCryptoUsdtPerpetualUniverse(contracts, limit = 544) {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Universe limit must be a non-negative integer.");
  const eligible = (Array.isArray(contracts) ? contracts : []).filter(isEligibleUsdtPerpetualContract).map((contract) => String(contract.symbol ?? "").toUpperCase());
  const unique = [...new Set(eligible)];
  return [...unique.filter((symbol) => symbol === "BTC-USDT"), ...unique.filter((symbol) => symbol !== "BTC-USDT")].slice(0, limit);
}
__name(buildEligibleCryptoUsdtPerpetualUniverse, "buildEligibleCryptoUsdtPerpetualUniverse");
function resetScanRotationProgress(previous, at = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    universeKey: previous?.universeKey ?? "",
    universeSize: previous?.universeSize ?? 0,
    generation: Math.max(0, Number(previous?.generation) || 0) + 1,
    seenSymbols: [],
    startedAt: at,
    lastCompletedAt: previous?.lastCompletedAt ?? null,
    completedCount: Math.max(0, Number(previous?.completedCount) || 0),
    lastCompletedUniverseSize: previous?.lastCompletedUniverseSize ?? 0,
    lastCompletedUniverseKey: previous?.lastCompletedUniverseKey ?? null
  };
}
__name(resetScanRotationProgress, "resetScanRotationProgress");
function updateScanRotationProgress(previous, universeSymbols, successfullyScannedSymbols, at = (/* @__PURE__ */ new Date()).toISOString(), expectedGeneration) {
  const universe = [...new Set(universeSymbols.map((symbol) => String(symbol).toUpperCase()))];
  const universeKey = universe.join(",");
  if (!universe.length) {
    return previous ?? {
      universeKey,
      universeSize: 0,
      generation: 0,
      seenSymbols: [],
      startedAt: at,
      lastCompletedAt: null,
      completedCount: 0,
      lastCompletedUniverseSize: 0,
      lastCompletedUniverseKey: null
    };
  }
  const sameUniverse = previous?.universeKey === universeKey && previous.universeSize === universe.length;
  const generation = Math.max(0, Number(previous?.generation) || 0);
  const generationMatches = expectedGeneration === void 0 || expectedGeneration === generation;
  const seen = new Set(sameUniverse ? previous.seenSymbols.filter((symbol) => universe.includes(symbol)) : []);
  for (const raw of generationMatches ? successfullyScannedSymbols : []) {
    const symbol = String(raw).toUpperCase();
    if (universe.includes(symbol)) seen.add(symbol);
  }
  const completed = seen.size === universe.length;
  const completedCount = Math.max(0, Number(previous?.completedCount) || 0) + (completed ? 1 : 0);
  return {
    universeKey,
    universeSize: universe.length,
    generation,
    seenSymbols: completed ? [] : universe.filter((symbol) => seen.has(symbol)),
    startedAt: completed || !sameUniverse ? at : previous.startedAt,
    lastCompletedAt: completed ? at : previous?.lastCompletedAt ?? null,
    completedCount,
    lastCompletedUniverseSize: completed ? universe.length : previous?.lastCompletedUniverseSize ?? 0,
    lastCompletedUniverseKey: completed ? universeKey : previous?.lastCompletedUniverseKey ?? null
  };
}
__name(updateScanRotationProgress, "updateScanRotationProgress");
function reconcileScanRotationProgress(latest, local, universeSymbols, successfullyScannedSymbols, at, expectedGeneration) {
  const latestGeneration = Math.max(0, Number(latest?.generation) || 0);
  const localGeneration = Math.max(0, Number(local?.generation) || 0);
  if (latestGeneration === expectedGeneration) {
    return updateScanRotationProgress(latest, universeSymbols, successfullyScannedSymbols, at, expectedGeneration);
  }
  if (local && localGeneration === expectedGeneration && localGeneration > latestGeneration) return local;
  return latest;
}
__name(reconcileScanRotationProgress, "reconcileScanRotationProgress");
function isTrustedManualCloseOrigin(origin, appOrigin) {
  return Boolean(origin && appOrigin && origin === appOrigin);
}
__name(isTrustedManualCloseOrigin, "isTrustedManualCloseOrigin");

// src/index.ts
function markBingXPendingSetupOpened(ledger, pending, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const source = pending.setup;
  const candidate = ledger.setups.find((item) => item.symbol === source.symbol && item.side === source.side && item.model === source.model && item.candleTime === source.candleTime && (item.setupCandleTime ?? item.candleTime) === (source.setupCandleTime ?? source.candleTime) && item.setupTimeframe === source.setupTimeframe && item.entryTimeframe === source.entryTimeframe);
  if (candidate) {
    candidate.status = "OPENED";
    candidate.executionDecisionCode = "OPENED";
    candidate.executionDecisionReason = "BingX VST PostOnly limit emir doldu; pozisyon ve koruma emirleri borsada do\u011Fruland\u0131.";
    candidate.executionDecisionAt = at;
    candidate.reason = (candidate.reason || source.setupReason || "") + " | A\xC7ILDI: BingX VST dolumu ve pozisyon korumas\u0131 do\u011Fruland\u0131.";
  }
  for (const diagnostic of ledger.scanDiagnostics ?? []) {
    if (diagnostic.symbol !== source.symbol) continue;
    for (const detail of diagnostic.setupDetails ?? []) {
      if (detail.model === source.model && detail.side === source.side && detail.candleTime === source.candleTime) detail.status = "OPENED";
    }
  }
  const telemetrySetup = {
    symbol: source.symbol,
    side: source.side,
    model: source.model,
    entryTimeframe: source.entryTimeframe ?? "1h",
    setupTimeframe: source.setupTimeframe,
    score: source.score
  };
  ledger.modelTelemetry = recordModelExecutionDecision(ledger.modelTelemetry, telemetrySetup, "OPENED", "OPENED", at);
}
__name(markBingXPendingSetupOpened, "markBingXPendingSetupOpened");
function markBingXDirectSetupOpened(ledger, source, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const candidate = ledger.setups.find((item) => item.symbol === source.symbol && item.side === source.side && item.model === source.model && item.candleTime === source.candleTime && (item.setupCandleTime ?? item.candleTime) === (source.setupCandleTime ?? source.candleTime) && item.setupTimeframe === source.setupTimeframe && item.entryTimeframe === source.entryTimeframe);
  if (candidate) {
    candidate.status = "OPENED";
    candidate.executionDecisionCode = "OPENED";
    candidate.executionDecisionReason = "BingX VST canl\u0131 fiyat\u0131 do\u011Frulanm\u0131\u015F giri\u015F b\xF6lgesindeydi; piyasa emri ve koruma emirleri do\u011Fruland\u0131.";
    candidate.executionDecisionAt = at;
    candidate.reason = (candidate.reason || source.reason || "") + " | A\xC7ILDI: giri\u015F b\xF6lgesi i\xE7inde anl\u0131k VST dolumu ve koruma do\u011Fruland\u0131.";
  }
  for (const diagnostic of ledger.scanDiagnostics ?? []) {
    if (diagnostic.symbol !== source.symbol) continue;
    for (const detail of diagnostic.setupDetails ?? [])
      if (detail.model === source.model && detail.side === source.side && detail.candleTime === source.candleTime) detail.status = "OPENED";
  }
  const telemetrySetup = {
    symbol: source.symbol,
    side: source.side,
    model: source.model,
    entryTimeframe: source.entryTimeframe,
    setupTimeframe: source.setupTimeframe,
    score: source.score
  };
  ledger.modelTelemetry = recordModelExecutionDecision(ledger.modelTelemetry, telemetrySetup, "OPENED", "OPENED", at);
}
__name(markBingXDirectSetupOpened, "markBingXDirectSetupOpened");
var DEFAULT_STATE = {
  paperBalanceUsdt: 1e3,
  positions: [],
  closedTrades: [],
  lastScanAt: null,
  lastScannedSymbol: null,
  runnerEnabled: true,
  paperLedger: { balance: 1e3, equity: 1e3, positions: [], closedTrades: [], setups: [], scannedSymbols: [], lastScanAt: null, runnerEnabled: true, cursor: 0, dailyPnl: 0, dayKey: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), maxOpenPositions: 10 }
};
var SQL_CANDLE_INSERT_CHUNK = 10;
var SQL_HISTORY_TASK_INSERT_CHUNK = 15;
var SQL_ARCHIVE_TASK_INSERT_CHUNK = 40;
var EngineState = class {
  static {
    __name(this, "EngineState");
  }
  state;
  env;
  usageCounters = { requests: 0, reads: 0, writes: 0, sqlRowsRead: 0, sqlRowsWritten: 0, deduplicatedWrites: 0 };
  lastQuotaSnapshot = { requests: 0, reads: 0, writes: 0, deduplicatedWrites: 0, sqlRowsRead: 0, sqlRowsWritten: 0 };
  // Per-isolate last-value caches avoid repeat KV/DO writes when state is unchanged.
  // These are optimization hints only; persistent storage remains the source of truth.
  lastPaperValues = /* @__PURE__ */ new Map();
  lastStorageValues = /* @__PURE__ */ new Map();
  // Short read-through cache coalesces repeated Dashboard/status reads without keeping trading state stale for long.
  paperReadCache = /* @__PURE__ */ new Map();
  // A read that began before a write must never repopulate the cache with its stale snapshot.
  paperValueVersions = /* @__PURE__ */ new Map();
  // Serialize ledger-mutating requests (especially scanner vs manual close) per Durable Object.
  stateMutationTail = Promise.resolve();
  paperReadCacheHits = 0;
  recoveryCheckComplete = false;
  recoveryPending = false;
  recoveryNotice = null;
  // When legacy storage is quota-blocked, avoid retrying the same expensive read on every Dashboard request.
  recoveryRetryAfter = 0;
  recoveryLastError = null;
  recoveryBackoffLoaded = false;
  // Read the legacy SQL fallback marker once per isolate, not on every scan/status request.
  kvWriteFallbackActive = null;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.scanInProgress = false;
    this.scanStartedAt = 0;
    this.state.blockConcurrencyWhile(async () => {
      try {
        const engine = await this.readEngineState();
        if (engine.runnerEnabled && !AUTOMATION_STOP) {
          const alarm = await this.state.storage.getAlarm();
          if (alarm === null) await this.setDurableAlarm(Date.now() + 15e3);
        }
      } catch (error) {
        console.error("Paper state migration deferred; legacy storage unavailable", String(error));
        try {
          const retryAt = Math.max(Date.now() + 18e4, this.recoveryRetryAfter || 0);
          const existingAlarm = await this.state.storage.getAlarm();
          if (existingAlarm === null || existingAlarm < retryAt) await this.setDurableAlarm(retryAt);
        } catch (alarmError) {
          console.error("Could not schedule automatic paper-ledger recovery retry", String(alarmError));
        }
      }
    });
  }
  isKvQuotaFailure(error) {
    return /quota|limit exceeded|exceeded for the day|too many requests|\b429\b/i.test(String(error));
  }
  async readPaperState(key, type) {
    const cached = this.paperReadCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.paperReadCacheHits++;
      return cached.value;
    }
    const versionAtReadStart = this.paperValueVersions.get(key) ?? 0;
    let value = null;
    if (this.kvWriteFallbackActive === true) {
      const durable = await this.readStorage("paper-state:" + key);
      if (durable !== void 0) value = type === "json" ? JSON.parse(durable) : durable;
      else value = type === "json" ? await this.env.PAPER_STATE.get(key, "json") : await this.env.PAPER_STATE.get(key);
    } else {
      try {
        this.usageCounters.reads++;
        value = type === "json" ? await this.env.PAPER_STATE.get(key, "json") : await this.env.PAPER_STATE.get(key);
      } catch (error) {
        if (!this.isKvQuotaFailure(error)) throw error;
        this.kvWriteFallbackActive = true;
        await this.writeStorage("paper-ledger-kv-write-blocked", true);
        const durable = await this.readStorage("paper-state:" + key);
        value = durable === void 0 ? null : type === "json" ? JSON.parse(durable) : durable;
      }
    }
    if ((this.paperValueVersions.get(key) ?? 0) === versionAtReadStart) {
      const encoded = value === null ? "__NULL__" : type === "json" ? JSON.stringify(value) ?? "__UNDEFINED__" : String(value);
      this.lastPaperValues.set(key, encoded);
      this.paperReadCache.set(key, { expiresAt: Date.now() + 1500, value });
      if (this.paperReadCache.size > 100) {
        for (const [cacheKey, entry] of this.paperReadCache) if (entry.expiresAt <= Date.now()) this.paperReadCache.delete(cacheKey);
        while (this.paperReadCache.size > 100) this.paperReadCache.delete(this.paperReadCache.keys().next().value);
      }
    }
    return value;
  }
  async writePaperState(key, value) {
    if (key === "engine-state") { const state = JSON.parse(value); if (state?.paperLedger && Array.isArray(state.paperLedger.scanDiagnostics)) state.paperLedger.scanDiagnostics = filterActiveSwingDiagnostics(state.paperLedger.scanDiagnostics); value = JSON.stringify(state); }
    if (this.lastPaperValues.get(key) === value) { this.usageCounters.deduplicatedWrites++; return; }
    this.paperValueVersions.set(key, (this.paperValueVersions.get(key) ?? 0) + 1); this.usageCounters.writes++;
    if (this.kvWriteFallbackActive === true) {
      if (key === "engine-state") await this.writeStorage("engine-state", JSON.parse(value)); else await this.writeStorage("paper-state:" + key, value);
    } else {
      try { await this.env.PAPER_STATE.put(key, value); }
      catch (error) {
        this.kvWriteFallbackActive = true; await this.writeStorage("paper-ledger-kv-write-blocked", true);
        if (key === "engine-state") await this.writeStorage("engine-state", JSON.parse(value)); else await this.writeStorage("paper-state:" + key, value);
        console.error(this.isKvQuotaFailure(error) ? "Paper state KV quota reached; Durable Object state fallback active" : "Paper state KV write failed; Durable Object state fallback active", String(error).slice(0, 180));
      }
    }
    this.lastPaperValues.set(key, value); this.paperReadCache.set(key, { expiresAt: Date.now() + 1500, value: key === "engine-state" ? JSON.parse(value) : value });
  }
  updateQuotaTelemetry(ledger) {
    const quotaNow = Date.now();
    const quotaDayKey = new Date(quotaNow).toISOString().slice(0, 10);
    const priorQuota = ledger.quotaTelemetry ?? {};
    const sameQuotaDay = priorQuota.dayKey === quotaDayKey;
    const quotaDelta = {
      requests: Math.max(0, this.usageCounters.requests - this.lastQuotaSnapshot.requests),
      reads: Math.max(0, this.usageCounters.reads - this.lastQuotaSnapshot.reads),
      writes: Math.max(0, this.usageCounters.writes - this.lastQuotaSnapshot.writes),
      sqlRowsRead: Math.max(0, this.usageCounters.sqlRowsRead - this.lastQuotaSnapshot.sqlRowsRead),
      sqlRowsWritten: Math.max(0, this.usageCounters.sqlRowsWritten - this.lastQuotaSnapshot.sqlRowsWritten)
    };
    const quotaSamples = [
      ...sameQuotaDay && Array.isArray(priorQuota.samples) ? priorQuota.samples : [],
      { at: quotaNow, ...quotaDelta }
    ].filter((sample) => Number(sample.at) >= quotaNow - 60 * 60 * 1e3).slice(-90);
    const quotaSum = /* @__PURE__ */ __name((key) => quotaSamples.reduce((sum, sample) => sum + Math.max(0, Number(sample[key]) || 0), 0), "quotaSum");
    const observedSqlRowsReadToday = (sameQuotaDay ? Number(priorQuota.observedSqlRowsReadToday) || 0 : 0) + quotaDelta.sqlRowsRead;
    const observedSqlRowsWrittenToday = (sameQuotaDay ? Number(priorQuota.observedSqlRowsWrittenToday) || 0 : 0) + quotaDelta.sqlRowsWritten;
    const observedDoRequestsToday = (sameQuotaDay ? Number(priorQuota.observedDoRequestsToday) || 0 : 0) + quotaDelta.requests;
    const coverageStartedAt = sameQuotaDay && Number.isFinite(Number(priorQuota.coverageStartedAt)) ? Number(priorQuota.coverageStartedAt) : quotaNow;
    const coverageMinutes = Math.max(1, Math.min(1440, (quotaNow - coverageStartedAt) / 6e4));
    const quotaEstimateReady = coverageMinutes >= 15;
    const estimatedDailySqlRowsRead = quotaEstimateReady ? Math.ceil(observedSqlRowsReadToday / coverageMinutes * 1440) : null;
    const estimatedDailySqlRowsWritten = quotaEstimateReady ? Math.ceil(observedSqlRowsWrittenToday / coverageMinutes * 1440) : null;
    const pressurePercent = quotaEstimateReady ? Math.min(100, Math.ceil(Math.max(estimatedDailySqlRowsRead / 5e6, estimatedDailySqlRowsWritten / 1e5) * 100)) : 100;
    ledger.quotaTelemetry = {
      dayKey: quotaDayKey,
      measuredAt: new Date(quotaNow).toISOString(),
      pressurePercent,
      pressureSource: "do-sql-row-observed-projection",
      coverageStartedAt,
      quotaEstimateReady,
      coverageMinutes: Math.round(coverageMinutes * 10) / 10,
      observedSqlRowsReadToday,
      observedSqlRowsWrittenToday,
      observedDoRequestsToday,
      estimatedDailySqlRowsRead,
      estimatedDailySqlRowsWritten,
      sqlRowsReadLastHour: quotaSum("sqlRowsRead"),
      sqlRowsWrittenLastHour: quotaSum("sqlRowsWritten"),
      doRequestsLastHour: quotaSum("requests"),
      applicationReadsLastHour: quotaSum("reads"),
      applicationWritesLastHour: quotaSum("writes"),
      samples: quotaSamples
    };
    this.lastQuotaSnapshot = { ...this.usageCounters };
  }
  async withStateMutationLock(work) {
    let release;
    const turn = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.stateMutationTail;
    this.stateMutationTail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async readStorage(key) {
    this.usageCounters.reads++;
    let value;
    const chunkable = key === "engine-state" || key === "paper-state:engine-state";
    const manifest = chunkable ? await this.state.storage.get(key + ":__chunks") : void 0;
    if (manifest && manifest.format === "json-chunks-v1") {
      if (typeof manifest.prefix !== "string" || !Number.isInteger(manifest.count) || manifest.count < 1 || !Number.isInteger(manifest.byteLength) || manifest.byteLength < 0) throw new Error("Invalid durable-state chunk manifest for " + key);
      const chunkKeys = Array.from({ length: manifest.count }, (_, index) => manifest.prefix + index);
      const stored = await this.state.storage.get(chunkKeys);
      const bytes = new Uint8Array(manifest.byteLength);
      let offset = 0;
      for (const chunkKey of chunkKeys) {
        const chunk = stored instanceof Map ? stored.get(chunkKey) : stored[chunkKey];
        if (chunk === void 0) throw new Error("Durable-state chunk missing for " + key);
        const part = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
        if (offset + part.byteLength > bytes.byteLength) throw new Error("Durable-state chunk length overflow for " + key);
        bytes.set(part, offset); offset += part.byteLength;
      }
      if (offset !== bytes.byteLength) throw new Error("Durable-state chunk length mismatch for " + key);
      const encoded = new TextDecoder().decode(bytes);
      value = encoded === "__UNDEFINED__" ? void 0 : JSON.parse(encoded);
      this.usageCounters.sqlRowsRead += chunkKeys.length + 1;
    } else { value = await this.state.storage.get(key); if (value !== void 0) this.usageCounters.sqlRowsRead++; }
    this.lastStorageValues.set(key, value === void 0 ? "__UNDEFINED__" : JSON.stringify(value) ?? "__UNDEFINED__");
    return value;
  }
  async writeStorage(key, value) {
    const encoded = JSON.stringify(value) ?? "__UNDEFINED__";
    if (this.lastStorageValues.get(key) === encoded) { this.usageCounters.deduplicatedWrites++; return; }
    this.usageCounters.writes++;
    const chunkable = key === "engine-state" || key === "paper-state:engine-state";
    if (chunkable) {
      const manifestKey = key + ":__chunks", oldManifest = await this.state.storage.get(manifestKey), bytes = new TextEncoder().encode(encoded);
      if (bytes.byteLength > 64 * 1024) {
        const prefix = key + ":chunk:" + Date.now() + ":" + crypto.randomUUID() + ":", entries = new Map();
        for (let offset = 0, index = 0; offset < bytes.byteLength; offset += 64 * 1024, index++) entries.set(prefix + index, bytes.slice(offset, Math.min(bytes.byteLength, offset + 64 * 1024)));
        await this.state.storage.put(entries);
        await this.state.storage.put(manifestKey, { format: "json-chunks-v1", prefix, count: entries.size, byteLength: bytes.byteLength });
        await this.state.storage.delete(key); this.usageCounters.sqlRowsWritten += entries.size + 2;
        if (oldManifest?.format === "json-chunks-v1" && Number.isInteger(oldManifest.count) && typeof oldManifest.prefix === "string") { const oldKeys = Array.from({ length: oldManifest.count }, (_, index) => oldManifest.prefix + index); if (oldKeys.length) { await this.state.storage.delete(oldKeys); this.usageCounters.sqlRowsWritten += oldKeys.length; } }
      } else {
        await this.state.storage.put(key, value); this.usageCounters.sqlRowsWritten++;
        if (oldManifest?.format === "json-chunks-v1" && Number.isInteger(oldManifest.count) && typeof oldManifest.prefix === "string") { await this.state.storage.delete(manifestKey); const oldKeys = Array.from({ length: oldManifest.count }, (_, index) => oldManifest.prefix + index); if (oldKeys.length) { await this.state.storage.delete(oldKeys); this.usageCounters.sqlRowsWritten += oldKeys.length + 1; } }
      }
    } else { this.usageCounters.sqlRowsWritten++; await this.state.storage.put(key, value); }
    this.lastStorageValues.set(key, encoded);
  }
  async setDurableAlarm(timestamp2) {
    this.usageCounters.writes++;
    this.usageCounters.sqlRowsWritten++;
    await this.state.storage.setAlarm(timestamp2);
  }
  async deleteDurableAlarm() {
    this.usageCounters.writes++;
    this.usageCounters.sqlRowsWritten++;
    await this.state.storage.deleteAlarm();
  }
  execSql(query, ...bindings) {
    const result = this.state.storage.sql.exec(query, ...bindings);
    this.usageCounters.sqlRowsRead += result.rowsRead;
    this.usageCounters.sqlRowsWritten += result.rowsWritten;
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) this.usageCounters.reads += result.rowsRead;
    else this.usageCounters.writes += result.rowsWritten;
    return result;
  }
  async loadRecoveryBackoff() {
    if (this.recoveryBackoffLoaded) return;
    this.recoveryBackoffLoaded = true;
    try {
      const raw = await this.readPaperState("state-recovery-retry");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.retryAfter === "number" && Number.isFinite(saved.retryAfter) && saved.retryAfter > Date.now()) {
        this.recoveryRetryAfter = saved.retryAfter;
        this.recoveryLastError = typeof saved.error === "string" ? saved.error : "Legacy-ledger recovery is pending; the next storage retry is backoff-limited.";
      }
    } catch (error) {
      console.error("Could not load persisted legacy-ledger retry window", String(error));
    }
  }
  async deferLegacyRecovery(message) {
    this.recoveryRetryAfter = Date.now() + 18e4;
    this.recoveryLastError = message;
    try {
      await this.writePaperState("state-recovery-retry", JSON.stringify({
        retryAfter: this.recoveryRetryAfter,
        error: this.recoveryLastError
      }));
    } catch (error) {
      console.error("Could not persist legacy-ledger retry window", String(error));
    }
    return new Error(message);
  }
  async readEngineState() {
    if (!this.recoveryCheckComplete) {
      if (this.kvWriteFallbackActive === null) {
        try {
          this.kvWriteFallbackActive = await this.readStorage("paper-ledger-kv-write-blocked") ?? false;
        } catch {
          this.kvWriteFallbackActive = false;
        }
      }
      this.recoveryNotice = await this.readPaperState("state-recovery-notice");
      this.recoveryPending = !!this.recoveryNotice;
      this.recoveryCheckComplete = true;
    }
    if (this.recoveryPending) {
      await this.loadRecoveryBackoff();
      if (Date.now() < this.recoveryRetryAfter) {
        throw new Error(this.recoveryLastError ?? "Legacy-ledger recovery is pending; the next storage retry is backoff-limited.");
      }
      let legacy;
      try {
        legacy = await this.readStorage("engine-state");
      } catch (error) {
        throw await this.deferLegacyRecovery(
          "A legacy-ledger recovery is pending: original positions/history are not readable yet; retry is limited to once every 3 minutes. " + String(error).slice(0, 180)
        );
      }
      if (!legacy) {
        throw await this.deferLegacyRecovery(
          "A legacy-ledger recovery marker exists but the original ledger was not found; refusing to display or trade on a replacement balance. Retry is limited to once every 3 minutes."
        );
      }
      if (!legacy.paperLedger) {
        if (typeof legacy.paperBalanceUsdt !== "number" || !Number.isFinite(legacy.paperBalanceUsdt)) {
          throw await this.deferLegacyRecovery("Original ledger has no verifiable stored balance; refusing to synthesize a replacement paper ledger.");
        }
        legacy.paperLedger = {
          balance: legacy.paperBalanceUsdt,
          equity: legacy.paperBalanceUsdt,
          positions: Array.isArray(legacy.positions) ? legacy.positions : [],
          closedTrades: Array.isArray(legacy.closedTrades) ? legacy.closedTrades : [],
          setups: [],
          scannedSymbols: [],
          lastScanAt: legacy.lastScanAt,
          runnerEnabled: legacy.runnerEnabled,
          cursor: 0,
          dailyPnl: 0,
          dayKey: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
        };
      }
      legacy.runnerEnabled = true;
      if (legacy.paperLedger) legacy.paperLedger.runnerEnabled = true;
      await this.writePaperState("paper-runner-explicitly-paused", "false");
      await this.writePaperState("engine-state", JSON.stringify(legacy));
      await this.env.PAPER_STATE.delete("state-recovery-notice");
      await this.env.PAPER_STATE.delete("state-recovery-retry");
      await this.state.storage.delete("paper-state:state-recovery-notice");
      await this.state.storage.delete("paper-state:state-recovery-retry");
      this.paperReadCache.delete("state-recovery-notice");
      this.paperReadCache.delete("state-recovery-retry");
      this.lastPaperValues.delete("state-recovery-notice");
      this.lastPaperValues.delete("state-recovery-retry");
      this.recoveryRetryAfter = 0;
      this.recoveryLastError = null;
      this.recoveryBackoffLoaded = true;
      this.recoveryPending = false;
      if (legacy.runnerEnabled && !AUTOMATION_STOP) {
        const alarm = await this.state.storage.getAlarm();
        if (alarm === null) await this.setDurableAlarm(Date.now() + 15e3);
      }
      return legacy;
    }
    if (this.kvWriteFallbackActive === null) {
      try {
        this.kvWriteFallbackActive = await this.readStorage("paper-ledger-kv-write-blocked") ?? false;
      } catch (error) {
        this.kvWriteFallbackActive = false;
        console.warn("Legacy KV-write fallback marker unreadable; continuing from KV ledger", String(error).slice(0, 180));
      }
    }
    if (this.kvWriteFallbackActive) {
      const durable = await this.readStorage("engine-state");
      if (!durable || !durable.paperLedger) {
        throw new Error("KV writes are blocked and the durable paper ledger is unavailable; refusing to trade on stale KV state.");
      }
      if (durable.runnerEnabled && !AUTOMATION_STOP) {
        const alarm = await this.state.storage.getAlarm();
        if (alarm === null) await this.setDurableAlarm(Date.now() + 15e3);
      }
      return durable;
    }
    const cached = await this.readPaperState("engine-state", "json");
    if (cached) {
      if (!AUTOMATION_STOP && (cached.runnerEnabled !== true || cached.paperLedger?.runnerEnabled !== true)) {
        cached.runnerEnabled = true;
        if (cached.paperLedger) cached.paperLedger.runnerEnabled = true;
        await this.writePaperState("paper-runner-explicitly-paused", "false");
        await this.writePaperState("engine-state", JSON.stringify(cached));
      }
      if (cached.runnerEnabled && !AUTOMATION_STOP) {
        const alarm = await this.state.storage.getAlarm();
        if (alarm === null) await this.setDurableAlarm(Date.now() + 15e3);
      }
      return cached;
    }
    let existing;
    try {
      existing = await this.readStorage("engine-state");
    } catch (error) {
      const reason = String(error);
      const lower = reason.toLowerCase();
      if (!lower.includes("row") && !lower.includes("quota") && !lower.includes("storage unavailable")) throw error;
      throw new Error("Legacy paper ledger is temporarily unreadable due to storage row-read/quota limits; refusing to reset balance, positions, or trade history.");
    }
    if (existing) {
      const runnerConfigured = await this.readStorage("runner-configured") ?? false;
      const explicitPause = await this.readPaperState("paper-runner-explicitly-paused") === "true";
      const engine = structuredClone(existing);
      engine.paperLedger = engine.paperLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
      if (!runnerConfigured && !explicitPause) {
        engine.runnerEnabled = true;
        engine.paperLedger.runnerEnabled = true;
      }
      await this.writePaperState("engine-state", JSON.stringify(engine));
      await this.writePaperState("runner-configured", "true");
      await this.writePaperState("paper-runner-explicitly-paused", explicitPause ? "true" : "false");
      return engine;
    }
    throw new Error("No existing internal paper ledger found in verified storage; automatic account creation is disabled.");
  }
  async saveEngineState(engine) {
    if (engine?.paperLedger && Array.isArray(engine.paperLedger.scanDiagnostics)) engine.paperLedger.scanDiagnostics = filterActiveSwingDiagnostics(engine.paperLedger.scanDiagnostics);
    const serialized = JSON.stringify(engine);
    if (this.kvWriteFallbackActive === true) { await this.writeStorage("engine-state", engine); return; }
    await this.writePaperState("engine-state", serialized);
  }
  async initializeSqlSchema() {
    const schemaReady = await this.readStorage("sql-schema-ready") ?? false;
    if (schemaReady) return;
    this.execSql(`CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL, interval TEXT NOT NULL, open_time INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL, raw_json TEXT NOT NULL,
      PRIMARY KEY(symbol, interval, open_time)
    )`);
    this.execSql(`CREATE INDEX IF NOT EXISTS candles_lookup ON candles(symbol, interval, open_time DESC)`);
    this.execSql(`CREATE TABLE IF NOT EXISTS history_tasks (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, interval TEXT NOT NULL, limit_count INTEGER NOT NULL,
      cursor_time INTEGER, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, fetched INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL
    )`);
    try {
      this.execSql(`ALTER TABLE history_tasks ADD COLUMN cursor_time INTEGER`);
    } catch {
    }
    try {
      this.execSql(`ALTER TABLE history_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    } catch {
    }
    this.execSql(`CREATE TABLE IF NOT EXISTS archive_tasks (
      symbol TEXT PRIMARY KEY, next_due INTEGER NOT NULL, last_fetch INTEGER, fetched INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', error TEXT
    )`);
    this.execSql(`CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await this.writeStorage("sql-schema-ready", true);
  }
  async enforceEmergencyStop() {
    const existing = await this.readEngineState();
    const engine = structuredClone(existing);
    const previousLedger = engine.paperLedger;
    const ledger = previousLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
    const needsEngineSave = !existing || engine.runnerEnabled !== false || !previousLedger || previousLedger.runnerEnabled !== false;
    engine.runnerEnabled = false;
    ledger.runnerEnabled = false;
    engine.paperLedger = ledger;
    if (needsEngineSave) await this.saveEngineState(engine);
    const runnerConfigured = await this.readPaperState("runner-configured");
    if (runnerConfigured !== "true") await this.writePaperState("runner-configured", "true");
    const processingEnabled = await this.readStorage("history-processing-enabled");
    if (processingEnabled !== false) await this.writeStorage("history-processing-enabled", false);
    const alarm = await this.state.storage.getAlarm();
    if (alarm !== null) await this.deleteDurableAlarm();
  }
  async fetch(request) {
    this.usageCounters.requests++;
    const path = new URL(request.url).pathname;
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    if (request.method === "POST" && (path === "/paper/close" || path === "/paper/close-all")) {
      console.info("Paper close API request received", JSON.stringify({
        requestId,
        path,
        at: (/* @__PURE__ */ new Date()).toISOString(),
        origin: request.headers.get("origin"),
        appOrigin: request.headers.get("x-smcprov2-public-origin"),
        referer: request.headers.get("referer"),
        userAgent: request.headers.get("user-agent"),
        secFetchSite: request.headers.get("sec-fetch-site")
      }));
    }
    const isPaperScan = request.method === "POST" && path === "/paper/scan";
    const mutatesPaperLedger = request.method === "PUT" && path === "/state" || request.method === "POST" && ["/paper/scan", "/paper/close", "/paper/close-all", "/paper/settings", "/paper/capital-adjustment", "/runner", "/live/idempotency/claim", "/live/idempotency/release", "/live/positions", "/live/activation"].includes(path);
    if (isPaperScan && this.scanInProgress) return Response.json({ ok: true, skipped: true, reason: "SCAN_ALREADY_IN_PROGRESS" }, { status: 202, headers: { "cache-control": "no-store" } });
    if (isPaperScan) { this.scanInProgress = true; this.scanStartedAt = Date.now(); }
    try {
      return await (mutatesPaperLedger ? this.withStateMutationLock(() => this.handle(request)) : this.handle(request));
    } catch (error) {
      const path2 = new URL(request.url).pathname;
      console.error("EngineState request failed", { path: path2, requestId, error: String(error), stack: error instanceof Error ? error.stack : void 0 });
      if (path2 === "/paper/close" || path2 === "/paper/close-all") {
        return Response.json({ ok: false, code: "PAPER_CLOSE_SERVER_ERROR", error: "Paper close request failed before completion.", detail: String(error).slice(0, 500), requestId, retryable: true }, { status: 503, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      if (path2 === "/paper/status" || path2.endsWith("/paper/status")) return Response.json({ ok: true, mode: "bingx-demo", storageDegraded: true, balance: null, equity: null, positions: [], closedTrades: [], setups: [], scannedSymbols: [], lastScanAt: null, runnerEnabled: false, stateRecoveryNotice: this.recoveryNotice, message: "Paper scanner is paused: original paper ledger recovery is blocked by Durable Object storage quota. Do not use the replacement KV ledger." });
      if (path2 === "/history/safety" || path2.endsWith("/history/safety")) return Response.json({ ok: true, processingEnabled: false, defaultMode: "paused", automationStopped: AUTOMATION_STOP, alarmScheduled: false, manualResumeRequired: AUTOMATION_STOP, sqlReads: 0, bounded: true, note: "History safety status fails closed; historical SQL processing remains paused." });
      if (path2 === "/history/status") return Response.json({ ok: true, storageDegraded: true, processingEnabled: false, tasks: [], taskCounts: null, storedCandles: null, candleSymbols: null, latestCandle: null, latestSample: [], automationStopped: AUTOMATION_STOP, alarmScheduled: false, manualResumeRequired: false, sqlReads: 0, bounded: true, note: "Durable Object row-read quota exhausted; exact counts are temporarily unavailable." });
      if (path2 === "/history/archive/status") return Response.json({ ok: true, storageDegraded: true, processingEnabled: false, archive: { symbols: 0, active: 0, fetched: 0, lastFetch: null }, archiveSample: [], automationStopped: AUTOMATION_STOP, alarmScheduled: false, manualResumeRequired: false, sqlReads: 0, bounded: true, note: "Durable Object row-read quota exhausted; archive counts are temporarily unavailable." });
      return Response.json({ ok: false, storageDegraded: true, error: "Persistent storage unavailable; request refused." }, { status: 503 });
    } finally {
      if (isPaperScan) { this.scanInProgress = false; this.scanStartedAt = 0; }
    }
  }
  async handle(request) {
    const url = new URL(request.url);
    if (AUTOMATION_STOP && request.method === "PUT" && url.pathname === "/state") {
      return Response.json({
        ok: false,
        automationStopped: true,
        manualResumeRequired: true,
        error: "State writes are disabled by the emergency stop."
      }, { status: 503 });
    }
    if (AUTOMATION_STOP && request.method === "POST" && ["/history/start", "/history/archive/start", "/history/resume", "/paper/scan"].includes(url.pathname)) {
      return Response.json({
        ok: false,
        automationStopped: true,
        manualResumeRequired: true,
        error: "Automated market-data work is paused. Manual code-level resume is required."
      }, { status: 503 });
    }
    if (AUTOMATION_STOP && request.method === "GET" && url.pathname === "/history/candles") {
      return Response.json({
        ok: false,
        automationStopped: true,
        manualResumeRequired: true,
        error: "BingX market-data requests are disabled by the emergency stop."
      }, { status: 503 });
    }
    if (request.method === "POST" && url.pathname === "/scheduler/wake") {
      if (AUTOMATION_STOP) return Response.json({ ok: true, runnerEnabled: false, alarmScheduled: false, alarmAt: null, rearmed: false, lastScanAt: null });
      const engine = await this.readEngineState();
      const alarm = await this.state.storage.getAlarm();
      const now = Date.now();
      const scanStartedAt = Number(this.scanStartedAt) || Date.parse(engine.lastScanAt ?? "");
      const staleScanLock = this.scanInProgress === true && (!Number.isFinite(scanStartedAt) || now - scanStartedAt > 8 * 60 * 1000);
      if (staleScanLock) {
        console.warn("Stale paper scan lock recovered", JSON.stringify({ scanStartedAt: Number.isFinite(scanStartedAt) ? new Date(scanStartedAt).toISOString() : null, lastScanAt: engine.lastScanAt ?? null, at: new Date(now).toISOString() }));
        this.scanInProgress = false;
        this.scanStartedAt = 0;
        // Recover an orphaned mutation queue only after an eight-minute scan lease expires.
        this.stateMutationTail = Promise.resolve();
      }
      const alarmIsStale = alarm !== null && alarm > now + PAPER_SCAN_INTERVAL_MS + 3e4;
      let rearmed = false;
      let alarmAt = alarm;
      if (engine.runnerEnabled && (alarm === null || alarm <= now || alarmIsStale)) {
        alarmAt = now + 15e3;
        await this.setDurableAlarm(alarmAt);
        rearmed = true;
      } else if (!engine.runnerEnabled && alarm !== null) {
        await this.deleteDurableAlarm();
        alarmAt = null;
      }
      return Response.json({
        ok: true,
        runnerEnabled: engine.runnerEnabled,
        alarmScheduled: engine.runnerEnabled && alarmAt !== null,
        alarmAt,
        lastScanAt: engine.lastScanAt,
        scanInProgress: this.scanInProgress === true,
        rearmed
      });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      if (AUTOMATION_STOP) await this.enforceEmergencyStop();
      return Response.json(await this.readEngineState());
    }
    if (request.method === "PUT" && url.pathname === "/state") {
      const body = await request.json();
      await this.saveEngineState(body);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/history/start") {
      try {
        await this.initializeSqlSchema();
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, error: "History schema unavailable; processing remains paused.", detail: String(error) }, { status: 503 });
      }
      const body = await request.json();
      let symbols = [...new Set((body.symbols ?? []).map((s) => String(s).toUpperCase()))];
      if (body.allContracts === true || symbols.length === 0) {
        const cr = await fetch(BINGX + "/openApi/swap/v2/quote/contracts", { headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" }, cf: { cacheTtl: 300, cacheEverything: true } });
        if (!cr.ok) return Response.json({ ok: false, error: "Could not fetch BingX contract list." }, { status: 502 });
        const cp = await cr.json();
        if (cp.code !== 0 || !Array.isArray(cp.data)) return Response.json({ ok: false, error: cp.msg || "Invalid BingX contract response." }, { status: 502 });
        symbols = [...new Set(cp.data.filter(isEligibleUsdtPerpetualContract).map((c) => String(c.symbol ?? "").toUpperCase()))];
      }
      const intervals = [...new Set((body.intervals ?? ["5m", "15m", "1h", "2h", "4h", "1D"]).map((i) => i === "1D" ? "1d" : i))];
      const limit = Number(body.limit ?? 1440);
      if (!symbols.length || symbols.length > 1e3 || symbols.some((s) => !isEligibleUsdtPerpetualSymbol(s))) {
        return Response.json({ ok: false, error: "symbols must contain 1-1000 BASE-USDT symbols." }, { status: 400 });
      }
      if (!intervals.length || intervals.some((i) => !ALLOWED_INTERVALS.has(i))) {
        return Response.json({ ok: false, error: "Unsupported interval." }, { status: 400 });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 1440) {
        return Response.json({ ok: false, error: "limit must be 1-1440 candles per symbol/interval." }, { status: 400 });
      }
      const now = Date.now();
      const tasks = [];
      for (const symbol of symbols) for (const interval of intervals) tasks.push({ symbol, interval, limit });
      const newlyQueued = this.queueHistoryTasks(tasks, now);
      const processingEnabled = await this.readStorage("history-processing-enabled") ?? false;
      if (processingEnabled) await this.setDurableAlarm(now + 1e4);
      return Response.json({
        ok: true,
        queued: newlyQueued,
        requestedTasks: tasks.length,
        symbols: symbols.length,
        intervals,
        limitPerPair: limit,
        firstPageCandles: tasks.length * limit,
        processingEnabled,
        note: "Queue only; processing is paused by default to protect daily quotas. Resume explicitly after reviewing budget.",
        allContracts: body.allContracts === true || (body.symbols ?? []).length === 0
      });
    }
    if (request.method === "POST" && url.pathname === "/history/archive/bootstrap") {
      try {
        await this.initializeSqlSchema();
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, error: "Archive schema unavailable; processing remains paused.", detail: String(error) }, { status: 503 });
      }
      if (AUTOMATION_STOP) return Response.json({ ok: false, automationStopped: true, manualResumeRequired: true, error: "Archive bootstrap is locked by the emergency stop." }, { status: 503 });
      const cachedSymbols = await this.readStorage("history-archive-symbols-count") ?? 0;
      const processingEnabled = await this.readStorage("history-processing-enabled") ?? false;
      if (cachedSymbols > 0) {
        await this.writeStorage("archive-processing-enabled", true);
        return Response.json({
          ok: true,
          alreadyInitialized: true,
          archiveSymbols: cachedSymbols,
          pendingTasks: null,
          archiveProcessingEnabled: true,
          historyProcessingEnabled: processingEnabled,
          processingEnabled: false,
          alarmScheduled: false,
          note: "Incremental archive uses its independent quota-gated scheduler; historical backfill remains paused."
        });
      }
      const cr = await fetch(BINGX + "/openApi/swap/v2/quote/contracts", { headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
      if (!cr.ok) return Response.json({ ok: false, error: "Could not fetch BingX contract list." }, { status: 502 });
      const cp = await cr.json();
      if (cp.code !== 0 || !Array.isArray(cp.data)) return Response.json({ ok: false, error: cp.msg || "Invalid BingX contract response." }, { status: 502 });
      const symbols = [...new Set(cp.data.filter(isEligibleUsdtPerpetualContract).map((c) => String(c.symbol ?? "").toUpperCase()))];
      if (!symbols.length) return Response.json({ ok: false, error: "No eligible USDT perpetual contracts returned." }, { status: 502 });
      const now = Date.now();
      this.queueArchiveSymbols(symbols, now, false);
      const seedSymbols = symbols.slice(0, 25);
      this.queueHistoryTasks(seedSymbols.map((symbol) => ({ symbol, interval: "5m", limit: 240 })), now);
      await this.writeStorage("history-archive-symbols-count", symbols.length);
      await this.writeStorage("history-archive-fetch-count", 0);
      await this.writeStorage("archive-processing-enabled", true);
      await this.writeStorage("history-processing-enabled", false);
      return Response.json({
        ok: true,
        initialized: true,
        archiveSymbols: symbols.length,
        backfillSymbols: seedSymbols.length,
        intervals: ["5m"],
        historyLimit: 240,
        archiveProcessingEnabled: true,
        historyProcessingEnabled: false,
        processingEnabled: false,
        alarmScheduled: false,
        mode: "archive-enabled-backfill-paused",
        note: "Incremental archive uses an independent quota-gated scheduler; historical backfill remains paused."
      });
    }
    if (request.method === "POST" && url.pathname === "/history/archive/start") {
      try {
        await this.initializeSqlSchema();
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, error: "Archive schema unavailable; processing remains paused.", detail: String(error) }, { status: 503 });
      }
      const body = await request.json();
      let symbols = [...new Set((body.symbols ?? []).map((s) => String(s).toUpperCase()))];
      if (body.allContracts !== false && symbols.length === 0) {
        const cr = await fetch(BINGX + "/openApi/swap/v2/quote/contracts", { headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" }, cf: { cacheTtl: 300, cacheEverything: true } });
        if (!cr.ok) return Response.json({ ok: false, error: "Could not fetch BingX contract list." }, { status: 502 });
        const cp = await cr.json();
        if (cp.code !== 0 || !Array.isArray(cp.data)) return Response.json({ ok: false, error: cp.msg || "Invalid BingX contract response." }, { status: 502 });
        symbols = [...new Set(cp.data.filter(isEligibleUsdtPerpetualContract).map((c) => String(c.symbol ?? "").toUpperCase()))];
      }
      const limit = Number(body.historyLimit ?? 1440);
      if (!symbols.length || symbols.length > 1e3 || symbols.some((s) => !isEligibleUsdtPerpetualSymbol(s))) return Response.json({ ok: false, error: "symbols must contain 1-1000 BASE-USDT symbols." }, { status: 400 });
      if (!Number.isInteger(limit) || limit < 1 || limit > 1440) return Response.json({ ok: false, error: "historyLimit must be 1-1440." }, { status: 400 });
      const now = Date.now(), intervals = ["5m", "15m", "1h", "2h", "4h", "1d"];
      this.queueArchiveSymbols(symbols, now, true);
      const archiveTasks = [];
      for (const symbol of symbols) for (const interval of intervals) archiveTasks.push({ symbol, interval, limit });
      const newlyQueued = this.queueHistoryTasks(archiveTasks, now);
      await this.writeStorage("archive-processing-enabled", true);
      const historyProcessingEnabled = await this.readStorage("history-processing-enabled") ?? false;
      return Response.json({
        ok: true,
        symbols: symbols.length,
        queuedTasks: newlyQueued,
        intervals,
        historyLimitPerInterval: limit,
        archiveProcessingEnabled: true,
        historyProcessingEnabled,
        liveMode: "incremental 5m archive on separate quota-gated scheduler",
        requests: "one archive symbol per scheduler tick; historical backfill remains separately controlled"
      });
    }
    if (request.method === "POST" && url.pathname === "/history/archive/pause") {
      await this.writeStorage("archive-processing-enabled", false);
      return Response.json({
        ok: true,
        archiveProcessingEnabled: false,
        queuedWorkPreserved: true,
        note: "Incremental archive paused; queued archive symbols are preserved. Historical backfill setting is unchanged."
      });
    }
    if (request.method === "POST" && url.pathname === "/history/archive/tick") {
      if (AUTOMATION_STOP) return Response.json({ ok: false, automationStopped: true, archiveProcessingEnabled: false }, { status: 503 });
      const enabled = await this.readStorage("archive-processing-enabled") ?? false;
      if (!enabled) return Response.json({ ok: true, skipped: true, reason: "ARCHIVE_PAUSED", archiveProcessingEnabled: false });
      const engine = await this.readPaperState("engine-state", "json");
      const pressure = engine?.paperLedger?.quotaTelemetry?.pressurePercent ?? 100;
      const interval = pressure >= 65 ? Number.POSITIVE_INFINITY : pressure >= 50 ? 30 * 60 * 1e3 : pressure >= 30 ? 15 * 60 * 1e3 : 5 * 60 * 1e3;
      if (!Number.isFinite(interval)) return Response.json({ ok: true, skipped: true, reason: "QUOTA_CRITICAL", quotaPressurePercent: pressure, nextEligibleInMs: null });
      const now = Date.now();
      const last2 = await this.readStorage("archive-last-independent-tick") ?? 0;
      const wait = Math.max(0, interval - (now - last2));
      if (wait > 0) return Response.json({ ok: true, skipped: true, reason: "RATE_LIMITED", quotaPressurePercent: pressure, nextEligibleInMs: wait });
      const archiveIndexReady = await this.readStorage("archive-sql-index-v1") ?? false;
      if (!archiveIndexReady) {
        try {
          this.execSql("CREATE INDEX IF NOT EXISTS archive_tasks_due ON archive_tasks(status,next_due)");
          await this.writeStorage("archive-sql-index-v1", true);
        } catch (error) {
          console.error("Archive queue index preparation failed; queued work preserved", String(error));
          return Response.json({
            ok: false,
            error: "ARCHIVE_INDEX_UNAVAILABLE",
            detail: String(error).slice(0, 240),
            archiveProcessingEnabled: true,
            quotaPressurePercent: pressure,
            queuedWorkPreserved: true
          }, { status: 503 });
        }
      }
      await this.writeStorage("archive-last-independent-tick", now);
      try {
        if (pressure < 40) await this.filterIneligibleArchiveSymbolsIfNeeded();
        const processed = await this.processArchiveBatch();
        return Response.json({
          ok: true,
          processed,
          archiveProcessingEnabled: true,
          quotaPressurePercent: pressure,
          intervalMs: interval,
          nextEligibleAt: now + interval,
          historyBackfillTouched: false
        });
      } catch (error) {
        console.error("Independent archive tick failed", String(error));
        return Response.json({
          ok: false,
          error: "ARCHIVE_TICK_FAILED",
          detail: String(error).slice(0, 300),
          archiveProcessingEnabled: true,
          quotaPressurePercent: pressure
        }, { status: 503 });
      }
    }
    if (request.method === "POST" && url.pathname === "/history/pause") {
      if (AUTOMATION_STOP) {
        await this.enforceEmergencyStop();
        return Response.json({
          ok: true,
          processingEnabled: false,
          automationStopped: true,
          alarmScheduled: false,
          queuedWorkPreserved: true,
          manualResumeRequired: true
        });
      }
      await this.writeStorage("history-processing-enabled", false);
      try {
        this.execSql(`INSERT INTO engine_meta(key,value) VALUES('processing_enabled','0') ON CONFLICT(key) DO UPDATE SET value='0'`);
      } catch {
      }
      await this.deleteDurableAlarm();
      return Response.json({ ok: true, processingEnabled: false, queuedWorkPreserved: true });
    }
    if (request.method === "POST" && url.pathname === "/history/resume") {
      try {
        await this.initializeSqlSchema();
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, processingEnabled: false, error: "SQL schema unavailable; historical processing remains paused.", detail: String(error) }, { status: 503 });
      }
      try {
        const indexesReady = await this.readStorage("sql-indexes-v2") ?? false;
        if (!indexesReady) {
          this.execSql(`CREATE INDEX IF NOT EXISTS history_tasks_queue ON history_tasks(status,updated_at)`);
          this.execSql(`CREATE INDEX IF NOT EXISTS archive_tasks_due ON archive_tasks(status,next_due)`);
          await this.writeStorage("sql-indexes-v2", true);
        }
      } catch (error) {
        return Response.json({
          ok: false,
          storageDegraded: true,
          processingEnabled: false,
          error: "SQL queue indexes could not be prepared within the available quota; historical processing remains paused.",
          detail: String(error)
        }, { status: 503 });
      }
      await this.writeStorage("history-processing-enabled", true);
      try {
        this.execSql(`INSERT INTO engine_meta(key,value) VALUES('processing_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
      } catch {
      }
      await this.setDurableAlarm(Date.now() + 1e4);
      return Response.json({ ok: true, processingEnabled: true, warning: "Processing resumes only after explicit user action; use a small, bounded batch." });
    }
    if (request.method === "GET" && url.pathname === "/history/safety") {
      return Response.json({
        ok: true,
        processingEnabled: false,
        defaultMode: "paused",
        automationStopped: AUTOMATION_STOP,
        alarmScheduled: false,
        manualResumeRequired: AUTOMATION_STOP,
        sqlReads: 0,
        bounded: true,
        note: "KV-only safety status; historical SQL processing is paused."
      });
    }
    if (request.method === "GET" && url.pathname === "/history/archive/status") {
      if (AUTOMATION_STOP) await this.enforceEmergencyStop();
      const historyProcessingEnabled = AUTOMATION_STOP ? false : await this.readStorage("history-processing-enabled") ?? false;
      const archiveProcessingEnabled = AUTOMATION_STOP ? false : await this.readStorage("archive-processing-enabled") ?? false;
      const symbols = await this.readStorage("history-archive-symbols-count") ?? 0;
      const fetched = await this.readStorage("history-archive-fetch-count") ?? 0;
      const lastFetch = await this.readStorage("history-archive-last-fetch") ?? null;
      const missingCandles = await this.readStorage("history-archive-missing-candles") ?? null;
      const initializedSymbols = await this.readStorage("history-archive-initialized-count") ?? 0;
      const skippedSymbols = await this.readStorage("history-archive-skipped-count") ?? 0;
      const storedCandles = await this.readStorage("history-stored-candles-count") ?? null;
      const lastArchiveTickAt = await this.readStorage("archive-last-independent-tick") ?? null;
      const lastArchiveError = await this.readStorage("history-archive-last-error") ?? null;
      const quota = (await this.readPaperState("engine-state", "json"))?.paperLedger?.quotaTelemetry;
      const quotaPressurePercent = quota?.pressurePercent ?? null;
      return Response.json({
        ok: true,
        storageDegraded: false,
        processingEnabled: historyProcessingEnabled,
        archiveProcessingEnabled,
        historyProcessingEnabled,
        archive: {
          symbols,
          active: symbols,
          skippedSymbols,
          fetched,
          lastFetch,
          missingCandles,
          storedCandles,
          lastArchiveTickAt,
          baselineKnown: symbols > 0 && initializedSymbols >= symbols,
          initializedSymbols,
          quotaPressurePercent,
          quotaPressureSource: quota?.pressureSource ?? null,
          sqlRowsReadLastHour: quota?.sqlRowsReadLastHour ?? null,
          sqlRowsWrittenLastHour: quota?.sqlRowsWrittenLastHour ?? null,
          lastError: lastArchiveError
        },
        archiveSample: [],
        automationStopped: AUTOMATION_STOP,
        alarmScheduled: await this.state.storage.getAlarm() !== null,
        manualResumeRequired: AUTOMATION_STOP,
        queuedWorkPreserved: true,
        sqlReads: 0,
        bounded: true,
        note: "Archive status uses cached counters; no full-table SQL scans."
      });
    }
    if (request.method === "GET" && url.pathname === "/history/status") {
      if (AUTOMATION_STOP) await this.enforceEmergencyStop();
      const processingEnabled = AUTOMATION_STOP ? false : await this.readStorage("history-processing-enabled") ?? false;
      const storedCandles = await this.readStorage("history-stored-candles-count") ?? null;
      const taskSummary = await this.readStorage("history-task-summary") ?? null;
      const tasks = taskSummary ? [
        { status: "done", tasks: taskSummary.done, fetched: 0, updatedAt: null },
        { status: "queued", tasks: taskSummary.pending, fetched: 0, updatedAt: null },
        { status: "failed", tasks: taskSummary.failed, fetched: 0, updatedAt: null }
      ].filter((row) => row.tasks > 0) : [];
      return Response.json({
        ok: true,
        processingEnabled,
        tasks,
        taskCounts: taskSummary ?? { total: 0, done: 0, pending: 0, failed: 0 },
        storedCandles,
        candleSymbols: await this.readStorage("history-candle-symbols-count") ?? null,
        latestCandle: await this.readStorage("history-latest-candle-time") ?? null,
        latestSample: [],
        automationStopped: AUTOMATION_STOP,
        alarmScheduled: await this.state.storage.getAlarm() !== null,
        manualResumeRequired: AUTOMATION_STOP,
        sqlReads: 0,
        bounded: true,
        candleCountExact: storedCandles !== null,
        note: storedCandles === null ? "Exact candle baseline is pending; counters update without full-table scans." : "Counts use cached counters; no full-table SQL scans."
      });
    }
    if (request.method === "GET" && url.pathname === "/history/candles") {
      const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
      const interval = url.searchParams.get("interval") ?? "15m";
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
      if (!isEligibleUsdtPerpetualSymbol(symbol) || !ALLOWED_INTERVALS.has(interval) || !Number.isInteger(limit)) {
        return Response.json({ ok: false, error: "Invalid symbol, interval, or limit." }, { status: 400 });
      }
      const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
      const response = await fetch(`${BINGX}/openApi/swap/v3/quote/klines?${params}`, {
        headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
        cf: { cacheTtl: 15, cacheEverything: true }
      });
      if (!response.ok) return Response.json({ ok: false, error: `BingX HTTP ${response.status}` }, { status: 502 });
      const payload = await response.json();
      if (payload.code !== 0 || !Array.isArray(payload.data)) {
        return Response.json({ ok: false, error: payload.msg || "Invalid BingX candle response." }, { status: 502 });
      }
      const candles = payload.data.map(normalizeCandle).filter((c) => !!c && c.open != null && c.high != null && c.low != null && c.close != null).sort((a, b) => a.time - b.time).map((c) => ({
        symbol,
        interval,
        open_time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));
      return Response.json({
        ok: true,
        source: "bingx-on-demand",
        persistentArchive: false,
        count: candles.length,
        candles
      });
    }
    if (request.method === "POST" && url.pathname === "/live/idempotency/claim") {
      const body = await request.json().catch(() => null);
      const key = String(body?.key ?? "");
      const ttlMs = Math.min(86400000, Math.max(60000, Number(body?.ttlMs) || 86400000));
      if (!/^[a-zA-Z0-9_-]{12,40}$/.test(key)) return Response.json({ ok: false, error: "LIVE_IDEMPOTENCY_KEY_INVALID" }, { status: 400 });
      const storageKey = "live-idempotency:" + key;
      const current = await this.state.storage.get(storageKey);
      if (current && Number(current.expiresAt) > Date.now()) return Response.json({ ok: true, claimed: false, state: current.state ?? "CLAIMED" });
      await this.state.storage.put(storageKey, { state: "CLAIMED", claimedAt: Date.now(), expiresAt: Date.now() + ttlMs });
      return Response.json({ ok: true, claimed: true });
    }
    if (request.method === "POST" && url.pathname === "/live/idempotency/release") {
      const body = await request.json().catch(() => null);
      const key = String(body?.key ?? "");
      if (!/^[a-zA-Z0-9_-]{12,40}$/.test(key)) return Response.json({ ok: false, error: "LIVE_IDEMPOTENCY_KEY_INVALID" }, { status: 400 });
      const storageKey = "live-idempotency:" + key;
      const current = await this.state.storage.get(storageKey);
      if (current?.state === "CLAIMED") await this.state.storage.delete(storageKey);
      return Response.json({ ok: true, released: current?.state === "CLAIMED" });
    }
    if (request.method === "GET" && url.pathname === "/live/activation") {
      const activation = await this.state.storage.get("live-activation-v1") ?? { active: false, id: null };
      return Response.json({ ok: true, activation }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/live/activation") {
      const body = await request.json().catch(() => null);
      if (typeof body?.active !== "boolean" || typeof body?.id !== "string" || body.id.length < 12 ||
          body.confirmedByUser !== true || !Number.isFinite(Number(body.confirmedAt)))
        return Response.json({ ok: false, error: "LIVE_ACTIVATION_RECORD_INVALID" }, { status: 400 });
      const activation = {
        active: body.active, id: body.id, confirmedByUser: true,
        activatedAt: Number(body.confirmedAt), updatedAt: Date.now()
      };
      await this.state.storage.put("live-activation-v1", activation);
      return Response.json({ ok: true, activation });
    }
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/live/positions") {
      const storageKey = "live-positions-v1";
      if (request.method === "GET") {
        const positions = await this.state.storage.get(storageKey) ?? [];
        return Response.json({ ok: true, positions: Array.isArray(positions) ? positions : [] }, { headers: { "cache-control": "no-store" } });
      }
      const body = await request.json().catch(() => null);
      const positions = await this.state.storage.get(storageKey) ?? [];
      if (!Array.isArray(positions)) return Response.json({ ok: false, error: "LIVE_POSITION_STORAGE_CORRUPT" }, { status: 503 });
      if (body?.operation === "upsert" && body.position?.mode === "BINGX_LIVE" && typeof body.position.id === "string") {
        const next = positions.filter(item => String(item.id) !== body.position.id);
        next.push(body.position);
        await this.state.storage.put(storageKey, next.slice(-500));
        return Response.json({ ok: true, persisted: true });
      }
      if (body?.operation === "close" && typeof body.id === "string") {
        const next = positions.map(item => String(item.id) === body.id
          ? { ...item, state: "CLOSED", ...body.metadata } : item);
        await this.state.storage.put(storageKey, next);
        return Response.json({ ok: true, persisted: true });
      }
      return Response.json({ ok: false, error: "LIVE_POSITION_OPERATION_INVALID" }, { status: 400 });
    }
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/paper/state") {
      const allowedKeys = /* @__PURE__ */ new Set(["engine-state", "bingx-demo-position-meta", "bingx-demo-executed-setup-keys", "bingx-demo-pending-limit-entries", "bingx-demo-protection-health-v1", "state-recovery-notice", "state-recovery-retry", "paper-runner-explicitly-paused", "runner-configured", "bingx-vst-closed-trades-v1", "bingx-vst-closed-strategy-meta-v1", "bingx-demo-order-history-v1"]);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      const key = request.method === "GET" ? url.searchParams.get("key") ?? "" : String(body?.key ?? "");
      if (!allowedKeys.has(key)) return Response.json({ ok: false, error: "PAPER_STATE_KEY_NOT_ALLOWED" }, { status: 400 });
      try {
        if (this.kvWriteFallbackActive === null) {
          try {
            this.kvWriteFallbackActive = await this.readStorage("paper-ledger-kv-write-blocked") ?? false;
          } catch {
            this.kvWriteFallbackActive = false;
          }
        }
        if (request.method === "GET") {
          const value = key === "engine-state" && this.kvWriteFallbackActive === true ? await this.readStorage("engine-state") ?? null : key === "engine-state" ? await this.readPaperState(key, "json") : await this.readPaperState(key);
          return Response.json({ ok: true, key, value }, { headers: { "cache-control": "no-store" } });
        }
        if (typeof body?.value !== "string") return Response.json({ ok: false, error: "PAPER_STATE_VALUE_MUST_BE_STRING" }, { status: 400 });
        await this.writePaperState(key, body.value);
        return Response.json({ ok: true, key, persisted: true }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, error: String(error).slice(0, 240) }, { status: 503 });
      }
    }
    if (request.method === "GET" && url.pathname === "/paper/status") {
      if (AUTOMATION_STOP) await this.enforceEmergencyStop();
      let engine;
      try {
        engine = await this.readEngineState();
      } catch (error) {
        return Response.json({ ok: true, mode: this.env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo", storageDegraded: true, balance: null, equity: null, positions: [], closedTrades: [], setups: [], scannedSymbols: [], lastScanAt: null, runnerEnabled: false, stateRecoveryNotice: this.recoveryNotice, recoveryRetryAfter: this.recoveryRetryAfter || null, error: String(error), message: "Paper status is read-only while original ledger recovery is blocked. No replacement balance is used." }, { status: 503 });
      }
      const ledger = engine.paperLedger ?? DEFAULT_STATE.paperLedger;
      const positionLimitMigrationKey = "paper-position-limit-v21-migrated";
      if (await this.readPaperState(positionLimitMigrationKey) !== "true") {
        engine.paperLedger = ledger;
        engine.paperBalanceUsdt = ledger.balance;
        engine.positions = ledger.positions;
        engine.closedTrades = ledger.closedTrades;
        await this.saveEngineState(engine);
        await this.writePaperState(positionLimitMigrationKey, "true");
      }
      if (!Number.isInteger(Number(ledger.maxOpenPositions)) || Number(ledger.maxOpenPositions) < 0 || Number(ledger.maxOpenPositions) > 10) ledger.maxOpenPositions = 10;
      const manualPause = await this.readPaperState("paper-runner-explicitly-paused") === "true";
      let alarmAt = await this.state.storage.getAlarm();
      const alarmStale = alarmAt !== null && alarmAt > Date.now() + PAPER_SCAN_INTERVAL_MS + 3e4;
      if (engine.runnerEnabled && !manualPause && !AUTOMATION_STOP && (alarmAt === null || alarmAt <= Date.now() || alarmStale)) {
        alarmAt = Date.now() + 15e3;
        await this.setDurableAlarm(alarmAt);
      }
      const paperTradingEnabled = this.env.BINGX_TRADING_MODE === "paper" && this.env.PAPER_TRADING_ONLY === "true";
      const openForStatus = (ledger.positions ?? []).filter((p) => p.status === "OPEN");
      const statusMarks = await getBingXMarkPrices(openForStatus.map((p) => p.symbol), 7e3);
      const livePositions = openForStatus.map((position) => {
        const markPrice = statusMarks[position.symbol] ?? null;
        const stored = position;
        const usableMark = markPrice;
        const feeRate = Number.isFinite(position.feeRate) ? Math.max(0, Number(position.feeRate)) : 5e-4;
        const entryFee = Number(position.entryFeeUsdt) || 0;
        const exitFee = usableMark === null ? 0 : Number((position.qty * usableMark * feeRate).toFixed(8));
        const exitSlippage = usableMark === null ? 0 : Number((position.qty * usableMark * SLIPPAGE_RATE).toFixed(8));
        const unrealizedPnlUsdt = usableMark === null ? null : Number(((position.side === "LONG" ? usableMark - position.entry : position.entry - usableMark) * position.qty - entryFee - exitFee - exitSlippage).toFixed(4));
        return { ...position, markPrice: usableMark, currentPrice: usableMark, unrealizedPnlUsdt, livePriceAvailable: markPrice !== null, livePriceAt: markPrice !== null ? (/* @__PURE__ */ new Date()).toISOString() : stored.livePriceAt ?? null };
      });
      const allOpenMarksAvailable = livePositions.every((position) => position.livePriceAvailable === true && Number.isFinite(position.markPrice) && Number(position.markPrice) > 0 && Number.isFinite(position.unrealizedPnlUsdt));
      const liveUnrealized = livePositions.reduce((sum, position) => sum + (Number.isFinite(position.unrealizedPnlUsdt) ? Number(position.unrealizedPnlUsdt) : 0), 0);
      const liveEquity = allOpenMarksAvailable ? Number((ledger.balance + liveUnrealized + livePositions.reduce((sum, position) => sum + (Number(position.entryFeeUsdt) || 0), 0)).toFixed(4)) : null;
      return Response.json({
        ok: true,
        mode: this.env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo",
        paperTradingEnabled: this.env.BINGX_TRADING_MODE === "paper" && this.env.PAPER_TRADING_ONLY === "true",
        manualPause,
        internalPaperAccount: engine.internalPaperAccount ?? null,
        alarmScheduled: engine.runnerEnabled === true && !manualPause && !AUTOMATION_STOP && alarmAt !== null,
        alarmAt,
        runnerEnabled: engine.runnerEnabled === true && !AUTOMATION_STOP,
        strategy: "Independent Scalp + Swing Futures Engines",
        strategyMode: "SCALP_SWING_INDEPENDENT",
        strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
        newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
        positionManagementEnabled: true,
        scannerPaused: SCANNER_PAUSED,
        ...ledger,
        positions: livePositions,
        equity: liveEquity,
        liveUnrealizedPnlUsdt: allOpenMarksAvailable ? Number(liveUnrealized.toFixed(4)) : null,
        liveMarkPriceAvailable: allOpenMarksAvailable,
        setups: filterActiveSwingSetups(ledger.setups),
        scanDiagnostics: filterActiveSwingDiagnostics(ledger.scanDiagnostics),
        modelTelemetry: filterActiveSwingModelTelemetry(ledger.modelTelemetry),
        scanRotation: ledger.scanRotation ? { ...ledger.scanRotation, seenSymbols: [] } : ledger.scanRotation,
        livePnlUpdatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        stateRecoveryNotice: await this.readPaperState("state-recovery-notice"),
        automationStopped: AUTOMATION_STOP,
        manualResumeRequired: AUTOMATION_STOP
      });
    }
    if (request.method === "GET" && url.pathname === "/paper/analytics") {
      let engine;
      try {
        engine = await this.readEngineState();
      } catch (error) {
        return Response.json({ ok: false, storageDegraded: true, error: String(error), message: "Analytics unavailable until the original ledger is readable." }, { status: 503 });
      }
      const ledger = engine.paperLedger ?? DEFAULT_STATE.paperLedger;
      return Response.json({ ok: true, mode: this.env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo", generatedAt: (/* @__PURE__ */ new Date()).toISOString(), ...summarizeClosedTradeAnalytics(ledger.closedTrades ?? []) }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/paper/capital-adjustment") {
      if (!isTrustedManualCloseOrigin(request.headers.get("origin"), request.headers.get("x-smcprov2-public-origin"))) return Response.json({ ok: false, code: "UNTRUSTED_CAPITAL_ADJUSTMENT_ORIGIN", error: "Paper account initialization must originate from the dashboard." }, { status: 403, headers: { "cache-control": "no-store" } });
      let engine;
      try { engine = await this.readEngineState(); } catch (error) { return Response.json({ ok: false, storageDegraded: true, error: String(error), message: "Original paper ledger is not readable; no account change was made." }, { status: 503, headers: { "cache-control": "no-store" } }); }
      if (this.env.BINGX_TRADING_MODE === "paper" && this.env.PAPER_TRADING_ONLY === "true") {
        const startingBalance = Number(this.env.PAPER_START_BALANCE_USDT);
        if (!Number.isFinite(startingBalance) || startingBalance <= 0) return Response.json({ ok: false, storageDegraded: true, error: "PAPER_START_BALANCE_USDT is invalid; paper account initialization refused." }, { status: 503 });
        const resetId = "internal-paper-account-v1-" + String(startingBalance);
        if (engine.internalPaperAccount?.resetId !== resetId) {
          const old = engine.paperLedger;
          if (old && Number.isFinite(Number(old.balance)) && Array.isArray(old.positions) && Array.isArray(old.closedTrades)) {
            const archive = { archivedAt: new Date().toISOString(), sourceMode: "pre-internal-paper-switch", balance: old.balance, equity: old.equity, positions: old.positions, closedTrades: old.closedTrades, setups: old.setups ?? [], capitalAdjustments: old.capitalAdjustments ?? [] };
            await this.writePaperState("bingx-vst-legacy-ledger-v1", JSON.stringify(archive));
          }
          const fresh = structuredClone(DEFAULT_STATE.paperLedger);
          fresh.balance = startingBalance; fresh.equity = startingBalance; fresh.positions = []; fresh.closedTrades = []; fresh.setups = []; fresh.scannedSymbols = []; fresh.scanDiagnostics = []; fresh.lastScanAt = null; fresh.runnerEnabled = true; fresh.cursor = 0; fresh.dailyPnl = 0; fresh.dayKey = new Date().toISOString().slice(0, 10); fresh.maxOpenPositions = 10; fresh.capitalAdjustments = [{ id: resetId, at: new Date().toISOString(), targetUsdt: startingBalance, balanceBefore: Number(old?.balance) || 0, amountUsdt: startingBalance - (Number(old?.balance) || 0), balanceAfter: startingBalance, status: "NEW_INTERNAL_PAPER_ACCOUNT" }];
          engine.paperLedger = fresh; engine.paperBalanceUsdt = startingBalance; engine.positions = []; engine.closedTrades = []; engine.lastScanAt = null; engine.lastScannedSymbol = null; engine.runnerEnabled = true; engine.internalPaperAccount = { resetId, initializedAt: new Date().toISOString(), initialBalanceUsdt: startingBalance, currency: "USDT", source: "INTERNAL_PAPER_ONLY", legacyLedgerArchived: !!old };
          await this.writePaperState("internal-paper-entry-queue-v1", "[]");
        }
        await this.saveEngineState(engine);
        const ledger = engine.paperLedger;
        return Response.json({ ok: true, mode: "internal-paper", initialized: true, balance: ledger.balance, equity: ledger.equity, openPositions: ledger.positions.filter(p => p.status === "OPEN").length, closedTrades: ledger.closedTrades.length, maxOpenPositions: ledger.maxOpenPositions, legacyLedgerArchived: engine.internalPaperAccount.legacyLedgerArchived, liveTradingEnabled: false, demoTradingEnabled: false }, { headers: { "cache-control": "no-store" } });
      }
      const ledger = engine.paperLedger;
      if (!ledger || !Number.isFinite(ledger.balance) || !Array.isArray(ledger.closedTrades) || !Array.isArray(ledger.positions)) return Response.json({ ok: false, storageDegraded: true, message: "Original paper ledger is incomplete; no capital adjustment was made." }, { status: 503 });
      const adjustment = topUpPaperCapitalOnce(ledger, 1e3, "paper-capital-topup-1000-v4", new Date().toISOString());
      engine.paperLedger = ledger; engine.paperBalanceUsdt = ledger.balance; engine.positions = ledger.positions; engine.closedTrades = ledger.closedTrades; await this.saveEngineState(engine);
      return Response.json({ ok: true, mode: "bingx-demo", ...adjustment, balance: ledger.balance, equity: ledger.equity, closedTrades: ledger.closedTrades.length, openPositions: ledger.positions.filter(p => p.status === "OPEN").length, tradeHistoryPreserved: true }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/paper/settings") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
      }
      const requested = Number(body.maxOpenPositions);
      if (!Number.isInteger(requested) || requested < 0 || requested > 10) return Response.json({ ok: false, error: "maxOpenPositions must be an integer from 0 to 10." }, { status: 400 });
      const engine = await this.readEngineState();
      const ledger = engine.paperLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
      ledger.maxOpenPositions = requested;
      engine.paperLedger = ledger;
      engine.paperBalanceUsdt = ledger.balance;
      engine.positions = ledger.positions;
      engine.closedTrades = ledger.closedTrades;
      await this.saveEngineState(engine);
      bingxDemoStatusCache = null;
      console.info("Paper position limit updated", JSON.stringify({ maxOpenPositions: requested, openPositions: ledger.positions.length }));
      return Response.json({ ok: true, mode: this.env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo", paperTradingEnabled: this.env.BINGX_TRADING_MODE === "paper" && this.env.PAPER_TRADING_ONLY === "true", maxOpenPositions: requested, openPositions: ledger.positions.length });
    }
    if (request.method === "POST" && url.pathname === "/paper/close-all") {
      let closeAllBody;
      try {
        closeAllBody = await request.json();
      } catch {
        return Response.json({ ok: false, code: "INVALID_CLOSE_REQUEST", error: "Explicit user confirmation is required." }, { status: 400 });
      }
      if (closeAllBody.confirmedByUser !== true) return Response.json({ ok: false, code: "MANUAL_CONFIRMATION_REQUIRED", error: "A user-confirmed close-all request is required." }, { status: 400 });
      const closeAllRequestedAt = Date.now();
      const engine = await this.readEngineState();
      const ledger = engine.paperLedger;
      if (!ledger || !Array.isArray(ledger.positions)) return Response.json({ ok: false, error: "Paper ledger is unavailable; positions were not changed." }, { status: 503 });
      const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
      if (!isTrustedManualCloseOrigin(request.headers.get("origin"), request.headers.get("x-smcprov2-public-origin"))) {
        console.warn("Paper close-all rejected untrusted origin", JSON.stringify({ requestId, origin: request.headers.get("origin"), appOrigin: request.headers.get("x-smcprov2-public-origin") }));
        return Response.json({ ok: false, code: "UNTRUSTED_MANUAL_CLOSE_ORIGIN", error: "Manual close must originate from the dashboard." }, { status: 403, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      const targets = ledger.positions.filter((p) => p.status === "OPEN");
      const closedSymbols = [];
      const failures = [];
      for (const position of targets) {
        try {
          const liveExitPrice = await getBingXMarkPrice(position.symbol, 1200);
          const storedMark = Number(position.markPrice);
          const exitPrice = liveExitPrice ?? (Number.isFinite(storedMark) && storedMark > 0 ? storedMark : Number.NaN);
          const priceSource = liveExitPrice !== null ? "BINGX_MARK_PRICE" : Number.isFinite(storedMark) && storedMark > 0 ? "LAST_KNOWN_MARK_PRICE" : "UNAVAILABLE";
          if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
            failures.push({ symbol: position.symbol, error: "No verified mark price is available; position left open" });
            continue;
          }
          const closedAt = Date.now();
          const gross = Number(((position.side === "LONG" ? exitPrice - position.entry : position.entry - exitPrice) * position.qty).toFixed(8));
          const feeRate = Number.isFinite(position.feeRate) ? Math.max(0, Number(position.feeRate)) : 5e-4;
          const exitFee = Number((position.qty * exitPrice * feeRate).toFixed(8));
          const exitSlippage = Number((position.qty * exitPrice * SLIPPAGE_RATE).toFixed(8));
          const entryFee = Number(position.entryFeeUsdt) || 0;
          const pnl = Number((gross - entryFee - exitFee - exitSlippage + (Number(position.realizedPnlUsdt) || 0)).toFixed(8));
          const closed = { ...position, closedAt, exitPrice, exitPriceSource: priceSource, pnlUsdt: pnl, realizedPnlUsdt: Number(((Number(position.realizedPnlUsdt) || 0) + gross - exitFee - exitSlippage).toFixed(8)), slippagePaidUsdt: Number(((Number(position.slippagePaidUsdt) || 0) + exitSlippage).toFixed(8)), exitFeesUsdt: Number(((position.exitFeesUsdt || 0) + exitFee).toFixed(8)), feesPaidUsdt: Number((entryFee + (position.exitFeesUsdt || 0) + exitFee).toFixed(8)), closeReason: "MANUAL_CLOSE_ALL", closeSource: "MANUAL_CLOSE_ALL_API", closeRequestId: requestId, manualConfirmedAt: new Date(closeAllRequestedAt).toISOString(), status: "CLOSED" };
          ledger.balance = Number((ledger.balance + gross - exitFee - exitSlippage).toFixed(8));
          const dayKey = new Date(closedAt).toISOString().slice(0, 10);
          if (ledger.dayKey !== dayKey) {
            ledger.dayKey = dayKey;
            ledger.dailyPnl = 0;
          }
          ledger.dailyPnl = Number((ledger.dailyPnl + gross - exitFee - exitSlippage).toFixed(8));
          ledger.closedTrades.unshift(closed);
          closedSymbols.push(position.symbol);
          ledger.positions = ledger.positions.filter((p) => p.id !== position.id);
        } catch {
          failures.push({ symbol: position.symbol, error: "Fresh exit price request failed" });
        }
      }
      const open = ledger.positions.filter((p) => p.status === "OPEN");
      ledger.equity = Number((ledger.balance + open.reduce((sum, p) => sum + Number(p.unrealizedPnlUsdt ?? 0), 0)).toFixed(4));
      engine.paperLedger = ledger;
      engine.paperBalanceUsdt = ledger.balance;
      engine.positions = ledger.positions;
      engine.closedTrades = ledger.closedTrades;
      await this.saveEngineState(engine);
      console.info("Paper positions close-all", JSON.stringify({ requestId, requested: targets.length, closed: closedSymbols.length, failed: failures.length, remaining: open.length, closedSymbols, failures }));
      return Response.json({ ok: failures.length === 0, mode: "bingx-demo", requestId, requested: targets.length, closed: closedSymbols.length, closedSymbols, failures, remaining: open.length, balance: ledger.balance }, { headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/paper/close") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
      }
      if (body.confirmedByUser !== true) return Response.json({ ok: false, code: "MANUAL_CONFIRMATION_REQUIRED", error: "A user-confirmed manual close request is required." }, { status: 400 });
      const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
      if (!isTrustedManualCloseOrigin(request.headers.get("origin"), request.headers.get("x-smcprov2-public-origin"))) {
        console.warn("Paper close rejected untrusted origin", JSON.stringify({ requestId, origin: request.headers.get("origin"), appOrigin: request.headers.get("x-smcprov2-public-origin") }));
        return Response.json({ ok: false, code: "UNTRUSTED_MANUAL_CLOSE_ORIGIN", error: "Manual close must originate from the dashboard." }, { status: 403, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      const positionId = String(body.positionId ?? "");
      const fraction = Number(body.fraction ?? 1);
      const closeRequestedAt = Date.now();
      console.info("Paper close API payload", JSON.stringify({ requestId, positionId, fraction, bodyKeys: Object.keys(body ?? {}), at: new Date(closeRequestedAt).toISOString() }));
      if (!positionId || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
        console.warn("Paper close API rejected payload", JSON.stringify({ requestId, positionId, fraction, reason: "INVALID_REQUEST" }));
        return Response.json({ ok: false, code: "INVALID_CLOSE_REQUEST", error: "positionId and fraction (0, 1] are required.", requestId }, { status: 400, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      const engine = await this.readEngineState();
      const ledger = engine.paperLedger;
      if (!ledger || !Array.isArray(ledger.positions)) return Response.json({ ok: false, code: "PAPER_LEDGER_UNAVAILABLE", error: "Paper ledger is unavailable; position was not changed.", requestId }, { status: 503, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      const position = ledger.positions.find((p) => p.id === positionId && p.status === "OPEN");
      if (!position) {
        console.warn("Paper close API rejected position", JSON.stringify({ requestId, positionId, reason: "OPEN_POSITION_NOT_FOUND", openPositionIds: ledger.positions.filter((p) => p.status === "OPEN").map((p) => p.id).slice(0, 30) }));
        return Response.json({ ok: false, code: "OPEN_POSITION_NOT_FOUND", error: "Open paper position not found.", requestId }, { status: 404, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      const liveExitPrice = await getBingXMarkPrice(position.symbol, 1200);
      const storedMark = Number(position.markPrice);
      const exitPrice = liveExitPrice ?? (Number.isFinite(storedMark) && storedMark > 0 ? storedMark : Number.NaN);
      const priceSource = liveExitPrice !== null ? "BINGX_MARK_PRICE" : Number.isFinite(storedMark) && storedMark > 0 ? "LAST_KNOWN_MARK_PRICE" : "UNAVAILABLE";
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        console.warn("Paper close rejected because no verified mark price is available", JSON.stringify({ requestId, positionId, symbol: position.symbol }));
        return Response.json({ ok: false, code: "MARK_PRICE_UNAVAILABLE", error: "Güvenilir anlık fiyat alınamadı; pozisyon kapatılmadı.", requestId }, { status: 503, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      }
      const closeQty = Number((position.qty * fraction).toFixed(8));
      if (!Number.isFinite(closeQty) || closeQty <= 0 || closeQty > position.qty) return Response.json({ ok: false, code: "INVALID_CLOSE_QUANTITY", error: "Invalid close quantity.", requestId, closeQty, positionQty: position.qty }, { status: 400, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
      const gross = Number(((position.side === "LONG" ? exitPrice - position.entry : position.entry - exitPrice) * closeQty).toFixed(8));
      const feeRate = Number.isFinite(position.feeRate) ? Math.max(0, Number(position.feeRate)) : 5e-4;
      const exitFee = Number((closeQty * exitPrice * feeRate).toFixed(8));
      const exitSlippage = Number((closeQty * exitPrice * SLIPPAGE_RATE).toFixed(8));
      const allocation = position.qty > 0 ? closeQty / position.qty : 1;
      const entryFeeTotal = Number(position.entryFeeUsdt) || 0;
      const allocatedEntryFee = Number((entryFeeTotal * allocation).toFixed(8));
      const priorRealizedTotal = Number(position.realizedPnlUsdt) || 0;
      const allocatedPriorRealized = Number((priorRealizedTotal * allocation).toFixed(8));
      const priorExitFeesTotal = Number(position.exitFeesUsdt) || 0;
      const allocatedPriorExitFees = Number((priorExitFeesTotal * allocation).toFixed(8));
      const fundingTotal = Number(position.fundingPaidUsdt) || 0;
      const allocatedFunding = Number((fundingTotal * allocation).toFixed(8));
      const slippageTotal = Number(position.slippagePaidUsdt) || 0;
      const allocatedPriorSlippage = Number((slippageTotal * allocation).toFixed(8));
      const initialRiskTotal = Number(position.initialRiskUsdt ?? position.riskUsdt) || 0;
      const allocatedInitialRisk = Number((initialRiskTotal * allocation).toFixed(8));
      const initialMarginTotal = Number(position.initialMarginUsdt ?? position.marginUsdt ?? position.allocationUsdt ?? 0) || 0;
      const allocatedMargin = Number((initialMarginTotal * allocation).toFixed(8));
      const pnl = Number((gross - exitFee - exitSlippage - allocatedEntryFee + allocatedPriorRealized).toFixed(8));
      const closedAt = closeRequestedAt;
      const closed = { ...position, qty: closeQty, initialQty: closeQty, entryFeeUsdt: allocatedEntryFee, exitFeesUsdt: Number((allocatedPriorExitFees + exitFee).toFixed(8)), feesPaidUsdt: Number((allocatedEntryFee + allocatedPriorExitFees + exitFee).toFixed(8)), slippagePaidUsdt: Number((allocatedPriorSlippage + exitSlippage).toFixed(8)), fundingPaidUsdt: allocatedFunding, realizedPnlUsdt: Number((allocatedPriorRealized + gross - exitFee - exitSlippage).toFixed(8)), initialRiskUsdt: allocatedInitialRisk, riskUsdt: Number((Number(position.riskUsdt || initialRiskTotal) * allocation).toFixed(8)), initialMarginUsdt: allocatedMargin, marginUsdt: allocatedMargin, allocationUsdt: allocatedMargin, closedAt, exitPrice, pnlUsdt: pnl, closeReason: body.closeClassification === "TP" ? (fraction === 1 ? "MANUAL_TP" : "MANUAL_PARTIAL_TP") : body.closeClassification === "SL" ? (fraction === 1 ? "MANUAL_SL" : "MANUAL_PARTIAL_SL") : fraction === 1 ? "MANUAL_CLOSE" : "MANUAL_PARTIAL_CLOSE", manualCloseClassification: ["TP","SL"].includes(body.closeClassification) ? body.closeClassification : "MANUAL", closeSource: "MANUAL_API_REQUEST", closeRequestId: requestId, manualConfirmedAt: new Date(closeRequestedAt).toISOString(), status: "CLOSED" };
      ledger.balance = Number((ledger.balance + gross - exitFee - exitSlippage).toFixed(8));
      const dayKey = new Date(closedAt).toISOString().slice(0, 10);
      if (ledger.dayKey !== dayKey) {
        ledger.dayKey = dayKey;
        ledger.dailyPnl = 0;
      }
      ledger.dailyPnl = Number((ledger.dailyPnl + gross - exitFee - exitSlippage).toFixed(8));
      ledger.closedTrades.unshift(closed);
      if (fraction === 1 || closeQty >= position.qty) ledger.positions = ledger.positions.filter((p) => p.id !== positionId);
      else {
        position.qty = Number((position.qty - closeQty).toFixed(8));
        position.initialQty = position.qty;
        position.entryFeeUsdt = Number((entryFeeTotal - allocatedEntryFee).toFixed(8));
        position.exitFeesUsdt = Number((priorExitFeesTotal - allocatedPriorExitFees).toFixed(8));
        position.feesPaidUsdt = Number(((position.entryFeeUsdt || 0) + (position.exitFeesUsdt || 0)).toFixed(8));
        position.realizedPnlUsdt = Number((priorRealizedTotal - allocatedPriorRealized).toFixed(8));
        position.fundingPaidUsdt = Number((fundingTotal - allocatedFunding).toFixed(8));
        position.slippagePaidUsdt = Number((slippageTotal - allocatedPriorSlippage).toFixed(8));
        position.initialRiskUsdt = Number((initialRiskTotal - allocatedInitialRisk).toFixed(8));
        position.riskUsdt = Number((Number(position.riskUsdt || initialRiskTotal) * (1 - allocation)).toFixed(8));
        position.initialMarginUsdt = Number((initialMarginTotal - allocatedMargin).toFixed(8));
        position.marginUsdt = position.initialMarginUsdt;
        position.allocationUsdt = position.marginUsdt;
        position.markPrice = exitPrice;
        const remainingExitFee = position.qty * exitPrice * (Number.isFinite(position.feeRate) ? Number(position.feeRate) : 5e-4);
        const remainingExitSlippage = position.qty * exitPrice * SLIPPAGE_RATE;
        position.unrealizedPnlUsdt = Number(((position.side === "LONG" ? exitPrice - position.entry : position.entry - exitPrice) * position.qty - remainingExitFee - remainingExitSlippage).toFixed(4));
      }
      ledger.equity = Number((ledger.balance + ledger.positions.reduce((sum, p) => sum + Number(p.unrealizedPnlUsdt ?? 0), 0)).toFixed(4));
      engine.paperLedger = ledger;
      engine.paperBalanceUsdt = ledger.balance;
      engine.positions = ledger.positions;
      engine.closedTrades = ledger.closedTrades;
      await this.saveEngineState(engine);
      const responseBody = { ok: true, mode: "bingx-demo", requestId, positionId, symbol: position.symbol, fraction, closedQty: closeQty, closedAt, exitPrice, priceSource, pnlUsdt: pnl, balance: ledger.balance, equity: ledger.equity, dailyPnl: ledger.dailyPnl, closedTrade: closed, remainingQty: ledger.positions.find((p) => p.id === positionId)?.qty ?? 0, message: fraction === 1 ? "Paper pozisyonu kapat\u0131ld\u0131." : "Paper pozisyonunun bir b\xF6l\xFCm\xFC kapat\u0131ld\u0131." };
      console.info("Paper position manually closed", JSON.stringify({ requestId, positionId, symbol: position.symbol, fraction, closeQty, exitPrice, priceSource, pnl, remainingPositions: ledger.positions.length, closedTradeRecorded: true, at: (/* @__PURE__ */ new Date()).toISOString() }));
      return Response.json(responseBody, { headers: { "x-request-id": requestId, "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/paper/scan") {
      const scanStartedAt = Date.now();
      const cacheStatsStart = { ...marketDataStats };
      const paperReadCacheHitsStart = this.paperReadCacheHits;
      const engine = await this.readEngineState();
      const ledger = engine.paperLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
      const demoConfigured = isBingXDemoConfigured(this.env);
      let demoSnapshot = null;
      let fixedRiskUnitUsdt = 0;
      let demoMetadata = [];
      let demoExecutedKeys = [];
      let demoPendingEntries = [];
      let demoAccountError = null;
      let demoProtectionCleanupPending = false;
      if (demoConfigured) {
        try {
          const savedMetadata = await this.readPaperState("bingx-demo-position-meta");
          const savedKeys = await this.readPaperState("bingx-demo-executed-setup-keys");
          const savedPending = await this.readPaperState("bingx-demo-pending-limit-entries");
          demoMetadata = savedMetadata ? JSON.parse(savedMetadata) : [];
          demoExecutedKeys = savedKeys ? JSON.parse(savedKeys) : [];
          demoPendingEntries = savedPending ? JSON.parse(savedPending) : [];
          const trackedOrderSymbols = [.../* @__PURE__ */ new Set([...demoMetadata.map((meta) => meta.symbol), ...demoPendingEntries.map((pending) => pending.setup.symbol)])];
          demoSnapshot = await getBingXDemoSnapshot(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, trackedOrderSymbols);
          try {
            const savedVstRiskBaseline = await this.readStorage("bingx-vst-risk-baseline-v1");
            if (savedVstRiskBaseline !== undefined) {
              const baselineEquity = Number(savedVstRiskBaseline?.initialEquity);
              const baselineRisk = Number(savedVstRiskBaseline?.fixedRiskUnitUsdt);
              if (!Number.isFinite(baselineEquity) || baselineEquity <= 0 || !Number.isFinite(baselineRisk) || baselineRisk <= 0 || Math.abs(baselineRisk - baselineEquity * 0.02) > 1e-8) {
                demoAccountError = "VST_RISK_BASELINE_INVALID: stored fixed 1R baseline failed validation; new VST entries are blocked.";
              } else fixedRiskUnitUsdt = baselineRisk;
            } else {
              const initialEquity = Number(demoSnapshot.balance?.equity);
              if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
                demoAccountError = "VST_RISK_BASELINE_UNAVAILABLE: BingX VST equity could not be verified; new entries are blocked.";
              } else {
                const baseline = { initialEquity, fixedRiskUnitUsdt: initialEquity * 0.02, riskUnitFraction: 0.02, capturedAt: new Date().toISOString(), source: "BINGX_VST" };
                await this.writeStorage("bingx-vst-risk-baseline-v1", baseline);
                fixedRiskUnitUsdt = baseline.fixedRiskUnitUsdt;
                console.info("BingX VST fixed 1R baseline initialized", JSON.stringify({ initialEquity, fixedRiskUnitUsdt }));
              }
            }
          } catch (riskBaselineError) {
            fixedRiskUnitUsdt = 0;
            demoAccountError = "VST_RISK_BASELINE_STORAGE_ERROR: " + String(riskBaselineError).slice(0, 180);
            console.error("BingX VST risk baseline unavailable; new entries blocked", demoAccountError);
          }
          let pendingReconciledPosition = false;
          const stillPending = [];
          for (const pending of demoPendingEntries) {
            const alreadySavedMeta = demoMetadata.find((meta) => meta.setupKey === pending.setupKey || meta.entryOrderId === pending.orderId);
            if (alreadySavedMeta) {
              demoExecutedKeys.push(pending.setupKey);
              executedSetupInstances.add(pending.setupInstanceKey ?? setupInstanceKey(pending.setup));
              await this.writePaperState("bingx-vst-executed-setup-instances-v1", JSON.stringify([...executedSetupInstances].slice(-5000)));
              markBingXPendingSetupOpened(ledger, pending);
              pendingReconciledPosition = true;
              continue;
            }
            const retiredStrategyPending = !ACTIVE_VST_STRATEGY_MODELS.has(pending.setup.model);
            if (isBingXDemoPendingEntryAbsentFromSnapshot(pending, demoSnapshot)) {
              console.info("BingX VST pending record cleared after complete exchange snapshot confirmed no open order or position", pending.setup.symbol, pending.orderId);
              continue;
            }
            try {
              if (retiredStrategyPending && shouldRetryBingXDemoPendingCancel(pending)) {
                pending.cancelAttemptAt = Date.now();
                pending.cancelAttemptSucceeded = false;
                try {
                  await cancelBingXDemoOrder(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, pending.setup.symbol, pending.orderId);
                  pending.cancelAttemptSucceeded = true;
                } catch (cancelError) {
                  console.warn("Disabled-strategy VST pending cancel deferred with durable retry backoff", pending.setup.symbol, String(cancelError).slice(0, 120));
                }
              }
              const reconciliation = await reconcileBingXDemoLimitEntry(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, pending);
              if (reconciliation.status === "PENDING" || reconciliation.status === "WAIT_POSITION_SYNC") {
                if (retiredStrategyPending) demoProtectionCleanupPending = true;
                stillPending.push(reconciliation.pending);
              } else if (reconciliation.status === "PROTECTED") {
                if (!demoMetadata.some((meta) => meta.setupKey === reconciliation.meta.setupKey || meta.entryOrderId === reconciliation.meta.entryOrderId))
                  demoMetadata.push(reconciliation.meta);
                demoExecutedKeys.push(pending.setupKey);
                executedSetupInstances.add(pending.setupInstanceKey ?? setupInstanceKey(pending.setup));
                await this.writePaperState("bingx-vst-executed-setup-instances-v1", JSON.stringify([...executedSetupInstances].slice(-5000)));
                markBingXPendingSetupOpened(ledger, pending);
                pendingReconciledPosition = true;
              }
            } catch (error) {
              if (retiredStrategyPending) demoProtectionCleanupPending = true;
              console.warn("BingX VST pending zone order reconciliation deferred", pending.setup.symbol, String(error).slice(0, 160));
              stillPending.push(pending);
            }
          }
          demoExecutedKeys = [...new Set(demoExecutedKeys)].slice(-500);
          if (pendingReconciledPosition) {
            await this.writePaperState("bingx-demo-position-meta", JSON.stringify(demoMetadata));
            await this.writePaperState("bingx-demo-executed-setup-keys", JSON.stringify(demoExecutedKeys));
          }
          demoPendingEntries = stillPending;
          await this.writePaperState("bingx-demo-pending-limit-entries", JSON.stringify(demoPendingEntries));
          if (pendingReconciledPosition) {
            demoSnapshot = await getBingXDemoSnapshot(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, [.../* @__PURE__ */ new Set([...demoMetadata.map((meta) => meta.symbol), ...demoPendingEntries.map((pending) => pending.setup.symbol)])]);
          }
          const orphanEntryCleanup = await cleanupOrphanBingXDemoEntryOrders(
            this.env.BINGX_API_KEY,
            this.env.BINGX_API_SECRET,
            demoSnapshot,
            demoPendingEntries,
            [.../* @__PURE__ */ new Set([...demoMetadata.map((meta) => meta.symbol), ...demoPendingEntries.map((pending) => pending.setup.symbol)])]
          );
          demoSnapshot = orphanEntryCleanup.snapshot;
          if (orphanEntryCleanup.cancelAttempts > 0) console.info("Orphan bot-owned BingX VST entry order cancellation verified", JSON.stringify({
            cancelAttempts: orphanEntryCleanup.cancelAttempts,
            remaining: orphanEntryCleanup.remaining
          }));
          if (orphanEntryCleanup.cleanupPending) {
            demoProtectionCleanupPending = true;
            demoAccountError = "ORPHAN_ENTRY_ORDER_CLEANUP_PENDING: untracked bot-owned VST entry orders are being canceled or verified; new demo entries remain blocked.";
          }
          const protection = await manageBingXDemoProtection(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, demoSnapshot, demoMetadata);
          await archiveBingXDemoClosedStrategyMetadata(this.env, protection.closedMetadata ?? []);
          demoMetadata = protection.metadata;
          if (protection.updated > 0 || protection.closed.length > 0) {
            await this.writePaperState("bingx-demo-position-meta", JSON.stringify(demoMetadata));
            if (!protection.cleanupPending) demoSnapshot = await getBingXDemoSnapshot(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, [.../* @__PURE__ */ new Set([...demoMetadata.map((meta) => meta.symbol), ...demoPendingEntries.map((pending) => pending.setup.symbol)])]);
          }
          if (protection.cleanupPending) {
            demoProtectionCleanupPending = true;
            demoAccountError = "PROTECTIVE_ORDER_CLEANUP_PENDING: BingX VST protective-order cleanup is in progress; new demo entries are blocked until the order list is safe.";
          }
        } catch (error) {
          demoAccountError = String(error).slice(0, 300);
          demoSnapshot = null;
          console.error("BingX VST demo account sync failed; new demo entries are blocked", demoAccountError);
        }
      }
      const scanBalanceAtStart = ledger.balance;
      const scanDailyPnlAtStart = ledger.dailyPnl;
      let scanRotationGenerationAtStart = Math.max(0, Number(ledger.scanRotation?.generation) || 0);
      const scanPositionStateAtStart = new Map(ledger.positions.filter((p) => p.status === "OPEN").map((p) => [p.id, {
        qty: p.qty,
        targetStage: Number(p.targetStage ?? 0),
        stopLoss: p.stopLoss,
        realizedPnlUsdt: Number(p.realizedPnlUsdt ?? 0)
      }]));
      const positionLimitMigrationKey = "paper-position-limit-v21-migrated";
      if (await this.readPaperState(positionLimitMigrationKey) !== "true") {
        engine.paperLedger = ledger;
        engine.paperBalanceUsdt = ledger.balance;
        engine.positions = ledger.positions;
        engine.closedTrades = ledger.closedTrades;
        await this.saveEngineState(engine);
        await this.writePaperState(positionLimitMigrationKey, "true");
      }
      if (!Number.isInteger(Number(ledger.maxOpenPositions)) || Number(ledger.maxOpenPositions) < 0 || Number(ledger.maxOpenPositions) > 10) ledger.maxOpenPositions = 10;
      const positionMarginMigrationKey = "paper-position-margin-metadata-v1";
      if (await this.readPaperState(positionMarginMigrationKey) !== "true") {
        await this.writePaperState(positionMarginMigrationKey, "true");
      }
      const positionMarks = {};
      const openPositionsAtStart = isBingXDemoConfigured(this.env) ? [] : ledger.positions.filter((p) => p.status === "OPEN");
      const repairWasDone = ledger.stopCrossingRepairV1Done === true;
      const freshMarks = await getBingXMarkPrices(openPositionsAtStart.map((p) => p.symbol), 7e3);
      Object.assign(positionMarks, freshMarks);
      const repairStopSymbols = /* @__PURE__ */ new Set();
      for (const position of openPositionsAtStart) {
        const mark = positionMarks[position.symbol];
        if (!Number.isFinite(mark) || mark <= 0) {
          position.livePriceAvailable = false;
          continue;
        }
        position.markPrice = mark;
        position.unrealizedPnlUsdt = Number(((position.side === "LONG" ? mark - position.entry : position.entry - mark) * position.qty - Number(position.entryFeeUsdt || 0) - position.qty * mark * (Number.isFinite(position.feeRate) ? Number(position.feeRate) : 5e-4)).toFixed(4));
        position.livePriceAvailable = true;
        position.livePriceAt = (/* @__PURE__ */ new Date()).toISOString();
        if (!repairWasDone && (position.side === "LONG" ? mark <= position.stopLoss : mark >= position.stopLoss)) repairStopSymbols.add(position.symbol);
      }
      for (const position of openPositionsAtStart) {
        const now = Date.now();
        const priorNext = Number(position.fundingNextTime), priorRate = Number(position.fundingRateSnapshot);
        const intervalHours = Number(position.fundingIntervalHours) > 0 ? Number(position.fundingIntervalHours) : 8;
        const mark = Number(positionMarks[position.symbol]);
        if (priorNext > 0 && now >= priorNext && Number(position.lastFundingTime || 0) < priorNext) {
          if (now - priorNext <= intervalHours * 60 * 60 * 1000 && Number.isFinite(priorRate) && Number.isFinite(mark) && mark > 0) {
            const fundingFee = round(position.qty * mark * priorRate * (position.side === "LONG" ? 1 : -1), 8);
            const fundingPnl = -fundingFee;
            ledger.balance = round(ledger.balance + fundingPnl, 8);
            ledger.dailyPnl = round((Number(ledger.dailyPnl) || 0) + fundingPnl, 8);
            position.realizedPnlUsdt = round((Number(position.realizedPnlUsdt) || 0) + fundingPnl, 8);
            position.fundingPaidUsdt = round((Number(position.fundingPaidUsdt) || 0) + fundingFee, 8);
            position.fundingEvents = [...position.fundingEvents ?? [], { fundingTime: priorNext, rate: priorRate, markPrice: mark, markObservedAt: now, qty: position.qty, fundingFeeUsdt: fundingFee, pnlUsdt: fundingPnl, source: "BINGX_PREMIUM_INDEX_SNAPSHOT" }].slice(-20);
            position.lastFundingTime = priorNext;
            position.fundingDataStatus = "APPLIED";
          } else {
            position.fundingMissedSettlements = (Number(position.fundingMissedSettlements) || 0) + 1;
            position.fundingDataStatus = "UNAVAILABLE_MISSED_SETTLEMENT";
          }
        }
        const snapshot = latestFundingSnapshots.get(position.symbol);
        if (snapshot && Number.isFinite(snapshot.rate) && Number.isFinite(snapshot.nextFundingTime) && snapshot.nextFundingTime > now) {
          position.fundingRateSnapshot = snapshot.rate;
          position.fundingNextTime = snapshot.nextFundingTime;
          position.fundingIntervalHours = snapshot.fundingIntervalHours;
          position.fundingSnapshotAt = new Date(snapshot.updateTime || snapshot.fetchedAt).toISOString();
          if (position.fundingDataStatus !== "UNAVAILABLE_MISSED_SETTLEMENT") position.fundingDataStatus = "AVAILABLE";
        } else if (!snapshot) {
          position.fundingDataStatus = position.fundingDataStatus || "UNAVAILABLE";
        }
      }
      const allOpenMarksAvailable = openPositionsAtStart.every((p) => Number.isFinite(positionMarks[p.symbol]) && positionMarks[p.symbol] > 0);
      if (!repairWasDone && allOpenMarksAvailable) ledger.stopCrossingRepairV1Done = true;
      const positionManagementAt = Date.now();
      if (!isBingXDemoConfigured(this.env)) updatePositions(ledger, positionMarks, positionManagementAt, repairStopSymbols);
      let openUnrealizedGrossNetExitFees = 0;
      for (const position of ledger.positions) {
        const mark = positionMarks[position.symbol];
        if (!Number.isFinite(mark) || mark <= 0) continue;
        const feeRate = Number.isFinite(position.feeRate) ? Number(position.feeRate) : 5e-4;
        const gross = (position.side === "LONG" ? mark - position.entry : position.entry - mark) * position.qty;
        const exitFee = position.qty * mark * feeRate;
        const exitSlippage = position.qty * mark * SLIPPAGE_RATE;
        position.markPrice = mark;
        position.markPriceAt = new Date(positionManagementAt).toISOString();
        position.unrealizedPnlUsdt = Number((gross - exitFee - exitSlippage).toFixed(8));
        openUnrealizedGrossNetExitFees += gross - exitFee - exitSlippage;
      }
      ledger.equity = Number((ledger.balance + openUnrealizedGrossNetExitFees).toFixed(8));
      const strategyResetState = ledger;
      if (strategyResetState.strategyResetV2 !== true) {
        ledger.setups = [];
        ledger.scannedSymbols = [];
        ledger.scanDiagnostics = [];
        ledger.modelTelemetry = void 0;
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        strategyResetState.strategyResetV2 = true;
      }
      if (strategyResetState.strategyResetV3 !== true) {
        ledger.setups = [];
        ledger.scannedSymbols = [];
        ledger.scanDiagnostics = [];
        ledger.modelTelemetry = void 0;
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        strategyResetState.strategyResetV3 = true;
      }
      if (strategyResetState.strategyResetV4 !== true) {
        ledger.setups = [];
        ledger.scannedSymbols = [];
        ledger.scanDiagnostics = [];
        ledger.modelTelemetry = void 0;
        ledger.activitySnapshots = {};
        ledger.activityRanking = void 0;
        ledger.activityRankingBySymbol = {};
        strategyResetState.strategyResetV4 = true;
      }
      if (strategyResetState.strategyResetV5 !== true) {
        ledger.setups = filterActiveSwingSetups(ledger.setups);
        ledger.scanDiagnostics = [];
        ledger.modelTelemetry = filterActiveSwingModelTelemetry(ledger.modelTelemetry);
        ledger.scannedSymbols = [];
        ledger.lastScanAt = null;
        ledger.scanTelemetry = void 0;
        ledger.scanUniverseSize = 0;
        ledger.scanBatchSize = 0;
        ledger.scanInvocationBatchSize = 0;
        ledger.scanLogicalBatchRemaining = 0;
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        strategyResetState.strategyResetV5 = true;
      }
      if (strategyResetState.strategyResetV6 !== true) {
        ledger.setups = filterActiveSwingSetups(ledger.setups);
        ledger.scanDiagnostics = [];
        ledger.modelTelemetry = filterActiveSwingModelTelemetry(ledger.modelTelemetry);
        ledger.scannedSymbols = [];
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        strategyResetState.strategyResetV6 = true;
      }
      if (strategyResetState.strategyResetV7 !== true) {
        ledger.setups = filterActiveSwingSetups(ledger.setups);
        ledger.scanDiagnostics = filterActiveSwingDiagnostics(ledger.scanDiagnostics);
        ledger.modelTelemetry = filterActiveSwingModelTelemetry(ledger.modelTelemetry);
        ledger.scannedSymbols = [];
        ledger.lastScanAt = null;
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        strategyResetState.strategyResetV7 = true;
      }
      if (ledger.sequentialBatchScanV1 !== true) {
        ledger.cursor = 0;
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        scanRotationGenerationAtStart = ledger.scanRotation.generation;
        ledger.scanLogicalBatchRemaining = 0;
        ledger.sequentialBatchScanV1 = true;
      }
      let universeSymbols = [];
      let universeError = null;
      try {
        const contractsResponse = await fetch(BINGX + "/openApi/swap/v2/quote/contracts", {
          headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" },
          signal: AbortSignal.timeout(12e3),
          cf: { cacheTtl: 300, cacheEverything: true }
        });
        if (!contractsResponse.ok) throw new Error("BingX contracts HTTP " + contractsResponse.status);
        const contractsPayload = await contractsResponse.json();
        if (contractsPayload.code !== 0 || !Array.isArray(contractsPayload.data)) throw new Error(contractsPayload.msg || "Invalid BingX contract response");
        universeSymbols = buildEligibleCryptoUsdtPerpetualUniverse(contractsPayload.data, contractsPayload.data.length);
      } catch (error) {
        universeError = String(error).slice(0, 240);
        console.error("BingX contract universe fetch failed", universeError);
      }
      const cursor = Math.max(0, Math.floor(Number(ledger.cursor) || 0));
      const startCursor = universeSymbols.length ? cursor % universeSymbols.length : 0;
      const latestScannedAtBySymbol = /* @__PURE__ */ new Map();
      for (const diagnostic of ledger.scanDiagnostics ?? []) {
        const at = Date.parse(String(diagnostic.scannedAt ?? ""));
        if (Number.isFinite(at)) latestScannedAtBySymbol.set(diagnostic.symbol, Math.max(latestScannedAtBySymbol.get(diagnostic.symbol) ?? 0, at));
      }
      const staleExecutionBySymbol = /* @__PURE__ */ new Map();
      const recentExecutionDecisions = Array.isArray(ledger.modelTelemetry?.recentDecisions) ? ledger.modelTelemetry.recentDecisions : [];
      for (const decision of recentExecutionDecisions) {
        const legacyGate = decision.code === "LIQUIDATION_RISK_GATE_ACTIVE";
        const priorSetup = (ledger.setups ?? []).find((setup) => setup.symbol === decision.symbol);
        const legacyTierRetry = decision.code === "EXCHANGE_MAX_POSITION_VALUE" && /bounded automatic leverage reduction|exact 2% account allocation at 50x/i.test(String(priorSetup?.reason ?? ""));
        if (!legacyGate && !legacyTierRetry) continue;
        const at = Date.parse(String(decision.at ?? "")), lastScan = latestScannedAtBySymbol.get(String(decision.symbol)) ?? 0;
        if (!Number.isFinite(at) || at + 2e3 < lastScan || !universeSymbols.includes(String(decision.symbol))) continue;
        const prior = staleExecutionBySymbol.get(String(decision.symbol));
        if (!prior || at > prior.at) staleExecutionBySymbol.set(String(decision.symbol), { symbol: String(decision.symbol), score: Number(decision.score) || 100, at });
      }
      const forcedExecutionRechecks = [...staleExecutionBySymbol.values()].sort((a, b) => a.score - b.score || a.at - b.at).map((row) => row.symbol);
      const rotationUniverseKey = universeSymbols.join(",");
      const rotationSeenSymbols = new Set(ledger.scanRotation?.universeKey === rotationUniverseKey ? ledger.scanRotation.seenSymbols ?? [] : []);
      const orderedUniverseFromCursor = [...universeSymbols.slice(startCursor), ...universeSymbols.slice(0, startCursor)];
      const pendingRotationSymbols = rotationSeenSymbols.size ? orderedUniverseFromCursor.filter((symbol) => !rotationSeenSymbols.has(symbol)) : [];
      const batchSymbols = SCANNER_PAUSED ? [] : pendingRotationSymbols.length ? pendingRotationSymbols.slice(0, PAPER_SCAN_BATCH_NORMAL) : universeSymbols.slice(startCursor, startCursor + PAPER_SCAN_BATCH_NORMAL);
      const nextSequentialCursor = universeSymbols.length ? (batchSymbols.length ? (universeSymbols.indexOf(batchSymbols.at(-1)) + 1) % universeSymbols.length : startCursor) : startCursor;
      const activityPriorityBatch = { symbols: batchSymbols, prioritySymbols: [], rotatingSymbols: batchSymbols, nextCursor: nextSequentialCursor, rotationAdvance: batchSymbols.length };
      if (!SCANNER_PAUSED) ledger.cursor = nextSequentialCursor;
      const symbolsToEvaluate = [.../* @__PURE__ */ new Set([...batchSymbols, "BTC-USDT"])];
      const scanMarks = {};
      const scanErrors = [];
      const closeKey = /* @__PURE__ */ __name((trade) => String(trade.id ?? "") + "|" + String(trade.closedAt ?? "") + "|" + String(trade.closeReason ?? ""), "closeKey");
      const structuralCandlesBySymbol = /* @__PURE__ */ new Map();
      for (const symbol of batchSymbols) {
        const rows = {};
        const specs = [["5m", 1e3, 3e5], ["15m", 600, 9e5], ["1h", 300, 36e5], ["4h", 180, 144e5], ["1d", 180, 864e5]];
        for (const [interval, limit, duration] of specs) {
          try {
            const candles = await fetchMarketCandles(symbol, interval, limit, duration);
            const minimum = interval === "5m" ? 251 : interval === "15m" ? 200 : interval === "1h" ? 100 : 60;
            if (candles.length >= minimum) rows[interval] = candles;
          } catch (error) {
            if (!scanErrors.some((x) => x.symbol === symbol && x.timeframe === interval)) scanErrors.push({ symbol, timeframe: interval, engine: interval === "5m" || interval === "15m" || interval === "1h" ? "SCALP+SWING" : "SWING", error: String(error).slice(0, 180) });
          }
        }
        if (rows["1h"]) rows["2h"] = aggregateClosedCandles(rows["1h"], 72e5, 36e5);
        structuralCandlesBySymbol.set(symbol, rows);
        const missingByEngine = {
          SCALP: ["5m", "15m", "1h"].filter((tf) => !rows[tf]),
          SWING: ["15m", "1h", "4h", "1d"].filter((tf) => !rows[tf])
        };
        for (const [engineName, missing] of Object.entries(missingByEngine)) {
          if (missing.length && !scanErrors.some((x) => x.symbol === symbol && x.engine === engineName && x.error.startsWith("INSUFFICIENT_OR_STALE_CANDLES:"))) {
            scanErrors.push({ symbol, engine: engineName, timeframes: missing, error: "INSUFFICIENT_OR_STALE_CANDLES:" + missing.join(",") });
          }
        }
      }
      const biasMeasuredAt = Date.now();
      const structuralBiasBySymbol = ledger.structuralBiasBySymbol ?? (ledger.structuralBiasBySymbol = {});
      for (const symbol of symbolsToEvaluate) {
        const rows = structuralCandlesBySymbol.get(symbol);
        if (!rows?.["4h"] || !rows?.["1d"]) continue;
        const state = updateConfirmedStructuralBiasState(structuralBiasBySymbol[symbol], rows["4h"], rows["1d"], biasMeasuredAt);
        if (state) structuralBiasBySymbol[symbol] = state;
      }
      const btcBiasState = structuralBiasBySymbol["BTC-USDT"];
      const btcBias = btcBiasState && biasMeasuredAt - btcBiasState.updatedAt <= 36 * 60 * 60 * 1e3 ? btcBiasState.activeBias : "NEUTRAL";
      const altcoinBreadthBias = summarizeAltcoinBreadthBias(structuralBiasBySymbol, universeSymbols, biasMeasuredAt);
      ledger.structuralMarketBiasSnapshot = { ...altcoinBreadthBias, btcBias, measuredAt: biasMeasuredAt };
      const activitySnapshots = ledger.activitySnapshots ?? (ledger.activitySnapshots = {});
      const activityQuotesBySymbol = {};
      let activityTickerError = null;
      try {
        const tickerResponse = await fetch(BINGX + "/openApi/swap/v2/quote/ticker", {
          headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" },
          signal: AbortSignal.timeout(7e3),
          cf: { cacheTtl: 15, cacheEverything: true }
        });
        if (!tickerResponse.ok) throw new Error("BingX ticker HTTP " + tickerResponse.status);
        const tickerPayload = await tickerResponse.json();
        if (tickerPayload.code !== 0 || !tickerPayload.data) throw new Error(tickerPayload.msg || "Invalid BingX ticker response");
        const tickerRows = Array.isArray(tickerPayload.data) ? tickerPayload.data : [tickerPayload.data];
        for (const row of tickerRows) {
          const symbol = String(row.symbol ?? "").toUpperCase();
          if (!batchSymbols.includes(symbol)) continue;
          const bid = Number(row.bidPrice), ask = Number(row.askPrice), quoteVolume = Number(row.quoteVolume);
          activityQuotesBySymbol[symbol] = {
            bidPrice: Number.isFinite(bid) && bid > 0 ? bid : void 0,
            askPrice: Number.isFinite(ask) && ask > 0 ? ask : void 0,
            quoteVolume24h: Number.isFinite(quoteVolume) && quoteVolume > 0 ? quoteVolume : void 0
          };
        }
      } catch (error) {
        activityTickerError = String(error).slice(0, 180);
        console.warn("Market activity ticker unavailable; candle quote-volume fallback only", activityTickerError);
      }
      for (const symbol of batchSymbols) {
        const daily = structuralCandlesBySymbol.get(symbol)?.["1d"] ?? [];
        if (daily.length < 31) continue;
        const window = daily.slice(-31);
        const trueRanges = window.slice(1).map((c, i) => Math.max(
          c.high - c.low,
          Math.abs(c.high - window[i].close),
          Math.abs(c.low - window[i].close)
        )).filter((value) => Number.isFinite(value) && value > 0);
        if (trueRanges.length < 20) continue;
        const n = trueRanges.slice(-20).reduce((sum, value) => sum + value, 0) / Math.min(20, trueRanges.length);
        const snapshot = buildActivitySnapshot(symbol, window, n, activityQuotesBySymbol[symbol] ?? {}, (/* @__PURE__ */ new Date()).toISOString());
        if (snapshot) activitySnapshots[symbol] = snapshot;
      }
      const activityRankingResult = rankActivitySnapshots(activitySnapshots, universeSymbols, Date.now());
      const activityBySymbol = activityRankingResult.bySymbol;
      ledger.activityRankingBySymbol = activityBySymbol;
      ledger.activityRanking = activityRankingResult.summary;
      if (activityTickerError) ledger.activityRankingError = activityTickerError;
      else delete ledger.activityRankingError;
      const decisionSymbols = [.../* @__PURE__ */ new Set([...symbolsToEvaluate, ...batchSymbols, ...demoSnapshot?.positions.map((p) => p.symbol) ?? [], ...demoPendingEntries.map((p) => p.setup.symbol), ...(!demoConfigured ? (ledger.setups ?? []).filter((setup) => setup?.status === "READY" || setup?.status === "WAIT").map((setup) => setup.symbol) : [])])];
      const decisionMarks = await getBingXMarkPrices(decisionSymbols, 7e3);
      for (const position of demoSnapshot?.positions ?? []) {
        const currentMark = Number(decisionMarks[position.symbol]);
        const snapshotMark = Number(position.markPrice);
        if ((!Number.isFinite(currentMark) || currentMark <= 0) && Number.isFinite(snapshotMark) && snapshotMark > 0) decisionMarks[position.symbol] = snapshotMark;
      }
      for (const symbol of decisionSymbols) {
        const mark = decisionMarks[symbol];
        if (Number.isFinite(mark) && mark > 0) {
          scanMarks[symbol] = mark;
          positionMarks[symbol] = mark;
        } else {
          delete scanMarks[symbol];
          delete positionMarks[symbol];
        }
      }
      let pendingOrderStateChanged = false;
      let pendingFillReconciled = false;
      const pendingAfterValidation = [];
      for (const pending of demoPendingEntries) {
        const mark = scanMarks[pending.setup.symbol];
        const expiresAt = Number(pending.setup.audit?.expiresAt) || pending.setup.candleTime + 7 * 60 * 60 * 1e3;
        const invalidated = Number.isFinite(mark) && mark > 0 && (pending.setup.side === "LONG" ? mark <= pending.setup.stopLoss : mark >= pending.setup.stopLoss);
        const expired = Date.now() >= expiresAt;
        if (!invalidated && !expired) {
          pendingAfterValidation.push(pending);
          continue;
        }
        if (!shouldRetryBingXDemoPendingCancel(pending)) {
          pendingAfterValidation.push(pending);
          continue;
        }
        pending.cancelAttemptAt = Date.now();
        pending.cancelAttemptSucceeded = false;
        try {
          await cancelBingXDemoOrder(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, pending.setup.symbol, pending.orderId);
          pending.cancelAttemptSucceeded = true;
          const reconciliation = await reconcileBingXDemoLimitEntry(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, pending);
          pendingOrderStateChanged = true;
          if (reconciliation.status === "PROTECTED") {
            demoMetadata.push(reconciliation.meta);
            demoExecutedKeys.push(pending.setupKey);
            executedSetupInstances.add(pending.setupInstanceKey ?? setupInstanceKey(pending.setup));
            await this.writePaperState("bingx-vst-executed-setup-instances-v1", JSON.stringify([...executedSetupInstances].slice(-5000)));
            markBingXPendingSetupOpened(ledger, pending);
            pendingFillReconciled = true;
          } else if (reconciliation.status === "PENDING" || reconciliation.status === "WAIT_POSITION_SYNC") {
            pendingAfterValidation.push(reconciliation.pending);
          }
        } catch (error) {
          console.warn("BingX VST invalidated/expired zone order cancellation deferred", pending.setup.symbol, String(error).slice(0, 160));
          pendingAfterValidation.push(pending);
        }
      }
      if (pendingOrderStateChanged) {
        demoPendingEntries = pendingAfterValidation;
        demoExecutedKeys = [...new Set(demoExecutedKeys)].slice(-500);
        await this.writePaperState("bingx-demo-pending-limit-entries", JSON.stringify(demoPendingEntries));
        await this.writePaperState("bingx-demo-executed-setup-keys", JSON.stringify(demoExecutedKeys));
        if (pendingFillReconciled) {
          await this.writePaperState("bingx-demo-position-meta", JSON.stringify(demoMetadata));
          demoSnapshot = await getBingXDemoSnapshot(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, [.../* @__PURE__ */ new Set([...demoMetadata.map((meta) => meta.symbol), ...demoPendingEntries.map((pending) => pending.setup.symbol)])]);
        }
      }
      const liquidationRiskWarningSymbols = [];
      const assessLiquidationRisk = /* @__PURE__ */ __name((symbol, side, mark, liq, stop, isolated) => {
        if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(liq) || liq <= 0 || !Number.isFinite(stop) || stop <= 0) return false;
        const breached = side === "LONG" ? mark <= liq : mark >= liq;
        const cushion = side === "LONG" ? stop - liq : liq - stop;
        if (breached) return true;
        if (!Number.isFinite(cushion) || cushion <= 0) {
          liquidationRiskWarningSymbols.push(symbol);
          return !isolated;
        }
        if (cushion < mark * 5e-3) {
          liquidationRiskWarningSymbols.push(symbol);
          return !isolated;
        }
        return false;
      }, "assessLiquidationRisk");
      const liquidationRiskGateActive = demoConfigured ? (demoSnapshot?.positions ?? []).some((position) => {
        const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && Number(position.positionAmt) < 0 ? "SHORT" : "LONG";
        const meta = demoMetadata.find((item) => item.symbol === position.symbol && item.side === side);
        const mark = scanMarks[position.symbol] ?? positionMarks[position.symbol];
        const liq = Number(position.liquidationPrice), stop = meta ? meta.stage >= 1 ? meta.entry : meta.stopLoss : Number.NaN;
        return assessLiquidationRisk(position.symbol, side, Number(mark), liq, stop, position.isolated ?? meta !== void 0);
      }) : (() => {
        ledger.positions.filter((p) => p.status === "OPEN").forEach((position) => {
          const mark = scanMarks[position.symbol] ?? positionMarks[position.symbol];
          assessLiquidationRisk(position.symbol, position.side, Number(mark), Number(position.liquidationPrice), Number(position.stopLoss), true);
        });
        return false;
      })();
      const generatedSetups = [];
      const diagnostics = [];
      for (const symbol of batchSymbols) {
        const rows = structuralCandlesBySymbol.get(symbol);
        const input = { "5m": rows?.["5m"], "15m": rows?.["15m"], "1h": rows?.["1h"], "4h": rows?.["4h"], "1d": rows?.["1d"] };
        const engineBtcBias = btcBiasState && biasMeasuredAt - btcBiasState.updatedAt <= 36 * 60 * 60 * 1e3 ? btcBiasState.activeBias : "UNAVAILABLE";
        let historyEvidence = [...ledger.closedTrades ?? []];
        try {
          const raw = await this.readPaperState("bingx-vst-closed-trades-v1");
          const stored = raw ? JSON.parse(raw) : [];
          if (Array.isArray(stored)) historyEvidence.push(...stored.filter((trade) => trade && trade.status === "CLOSED" && trade.model !== "BINGX VST"));
        } catch (error) {
          console.warn("Historical Scalp/Swing confidence data unavailable", String(error).slice(0, 140));
        }
        const scalp = evaluateEngine("SCALP", symbol, input, engineBtcBias, historyEvidence);
        const swing = evaluateEngine("SWING", symbol, input, engineBtcBias, historyEvidence);
        const candidates = [...scalp.setups, ...swing.setups];
        generatedSetups.push(...candidates);
        const missingCandleFrames = [.../* @__PURE__ */ new Set([...scalp.unavailable, ...swing.unavailable])];
        const timeframeDiagnostics = {};
        const rejectionSummary = {};
        for (const result of [scalp, swing]) for (const setupId of result.engine === "SCALP" ? ["S01_SWEEP_MSS_FVG", "S02_BREAKER_RETEST", "S03_BOS_DISPLACEMENT", "S04_RANGE_DEVIATION", "S05_FAILED_BREAKOUT", "S06_OB_REACTION"] : ["W01_HTF_OB_REVERSAL", "W02_SUPPLY_DEMAND_REVERSAL", "W03_SWEEP_CHOCH", "W04_BREAKER_RETEST", "W05_RANGE_DEVIATION", "W06_CRT", "W07_OTE", "W08_BOS_CONTINUATION"]) for (const side of ["LONG", "SHORT"]) {
          const key = setupId + ":" + side, hasSetup = candidates.some((setup) => setup.model === setupId && setup.side === side);
          if (hasSetup) timeframeDiagnostics[key] = { setups: 1 };
          else { const reason = result.unavailable.length ? "INSUFFICIENT_CANDLE_HISTORY" : "STRUCTURAL_PATTERN_NOT_CONFIRMED"; rejectionSummary[reason] = (rejectionSummary[reason] ?? 0) + 1; }
        }
        diagnostics.push({
          symbol,
          scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: scalp.unavailable.length && swing.unavailable.length ? "insufficient-candle-history" : candidates.length ? "setup-candidate" : missingCandleFrames.length ? "partial-candle-history" : "fresh-no-setup",
          setups: candidates.length,
          timeframeDiagnostics,
          rejectionSummary,
          setupDetails: candidates.map((setup) => ({ model: setup.model, tradeStyle: setup.tradeStyle, entryTimeframe: setup.entryTimeframe, setupTimeframe: setup.setupTimeframe, side: setup.side, score: setup.score, status: setup.status, reason: setup.reason, candleTime: setup.candleTime, entry: setup.entry, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, tp1: setup.tp1, tp2: setup.tp2, tp3: setup.tp3, confidence: setup.confidence, confidenceStatus: setup.confidenceStatus, confidenceSampleSize: setup.confidenceSampleSize, riskReward: setup.riskReward })),
          missingCandleFrames,
          engineAvailability: {
            scalp: { available: scalp.unavailable.length === 0, unavailable: scalp.unavailable },
            swing: { available: swing.unavailable.length === 0, unavailable: swing.unavailable }
          },
        });
      }
      ledger.activitySnapshots = activitySnapshots;
      for (const diagnostic of diagnostics) {
        const activity = activityBySymbol[diagnostic.symbol];
        if (activity) {
          diagnostic.activityMetrics = { nPct: activity.nPct, expansion7d30d: activity.expansion7d30d, average30dQuoteVolume: activity.average30dQuoteVolume, quoteVolume24h: activity.quoteVolume24h, volumeExpansion24h30d: activity.volumeExpansion24h30d, activityPercentile: activity.activityPercentile, spreadPct: activity.spreadPct, liquidityStatus: activity.liquidityStatus, priorityScore: activity.priorityScore, priorityTier: activity.priorityTier };
          diagnostic.activityDataStatus = { snapshot: "AVAILABLE", quoteVolume24h: activity.quoteVolume24h === null ? "UNAVAILABLE" : "AVAILABLE", average30dQuoteVolume: activity.average30dQuoteVolume === null ? "UNAVAILABLE" : "AVAILABLE", spread: activity.spreadPct === null ? "BID_ASK_UNAVAILABLE" : "AVAILABLE" };
        } else {
          const daily = structuralCandlesBySymbol.get(diagnostic.symbol)?.["1d"] ?? [];
          diagnostic.activityDataStatus = { snapshot: "UNAVAILABLE", reason: daily.length < 31 ? "INSUFFICIENT_31_DAILY_CANDLES" : "ACTIVITY_SNAPSHOT_NOT_BUILT", dailyCandleCount: daily.length, tickerError: activityTickerError };
        }
        const rows = structuralCandlesBySymbol.get(diagnostic.symbol), durations = { "5m": 3e5, "15m": 9e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "1d": 864e5 };
        diagnostic.candleDiagnostics = Object.fromEntries(Object.entries(durations).map(([tf, duration]) => {
          const candles = rows?.[tf] ?? [], last2 = candles.at(-1);
          return [tf, { candleCount: candles.length, latestClosedCandleOpenTime: last2?.time ?? null, latestClosedCandleCloseTime: last2 ? last2.time + duration : null, ageMs: last2 ? Math.max(0, Date.now() - (last2.time + duration)) : null, source: tf === "5m" ? "BINGX_5M" : tf === "15m" ? "BINGX_15M" : tf === "1h" ? "BINGX_1H" : tf === "4h" ? "BINGX_4H" : tf === "1d" ? "BINGX_1D" : "AGGREGATED_FROM_1H" }];
        }));
      }
      const orderedCandidates = generatedSetups.slice().sort((a, b) => b.score - a.score || b.candleTime - a.candleTime);
      const engineKey = /* @__PURE__ */ __name((setup) => [setup.tradeStyle === "SCALP" ? "SCALP" : "SWING", setup.symbol].join("|"), "engineKey");
      const setupInstanceKey = /* @__PURE__ */ __name((setup) => { const zone = setup?.audit?.zone ?? setup?.audit?.entryExecution?.entryZone; const event = setup?.audit?.structureEvent; const priceKey = (value) => Number.isFinite(Number(value)) ? Number(Number(value).toPrecision(10)) : ""; const anchor = zone?.formedAt ?? event?.candleTime ?? setup?.setupCandleTime ?? setup?.candleTime ?? ""; return [setup.tradeStyle === "SCALP" ? "SCALP" : "SWING", setup.model, setup.symbol, setup.side, zone?.kind ?? event?.type ?? "STRUCTURE", zone?.sourceTimeframe ?? setup.setupTimeframe ?? "", anchor, priceKey(zone?.top), priceKey(zone?.bottom), event?.type ?? "", event?.candleTime ?? "", priceKey(event?.level)].join("|"); }, "setupInstanceKey");
      const setupIsExpired = /* @__PURE__ */ __name((setup, now = Date.now()) => { const tf = String(setup?.setupTimeframe ?? setup?.entryTimeframe ?? "").toLowerCase(); const match = tf.match(/^(\d+)(m|h|d)$/); const unitMs = match ? ({ m: 6e4, h: 36e5, d: 864e5 })[match[2]] : 0; const durationMs = unitMs ? Number(match[1]) * unitMs : 0; const candleAt = Number(setup?.setupCandleTime ?? setup?.candleTime); if (!durationMs || !Number.isFinite(candleAt) || candleAt <= 0) return true; return candleAt > now + durationMs || now - candleAt > durationMs * 6; }, "setupIsExpired");
      const executedSetupInstances = new Set();
      try { const rawLocks = await this.readPaperState(demoConfigured ? "bingx-vst-executed-setup-instances-v1" : "internal-paper-executed-setup-instances-v1"); const parsedLocks = rawLocks ? JSON.parse(rawLocks) : []; if (Array.isArray(parsedLocks)) for (const key of parsedLocks) if (typeof key === "string") executedSetupInstances.add(key); } catch (lockError) { console.warn("Executed setup-instance lock state unavailable", String(lockError).slice(0, 140)); }
      for (const trade of [...(ledger.positions ?? []), ...(ledger.closedTrades ?? [])]) if (trade?.model && trade?.symbol && trade?.side && (trade.status === "OPEN" || trade.status === "CLOSED")) executedSetupInstances.add(trade.setupInstanceKey ?? setupInstanceKey(trade));
      const activeEngineKeys = /* @__PURE__ */ new Set();
      for (const position of demoSnapshot?.positions ?? []) {
        const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && Number(position.positionAmt) < 0 ? "SHORT" : "LONG";
        const meta = demoMetadata.find((item) => item.symbol === position.symbol && item.side === side);
        const style = meta?.tradeStyle === "SCALP" ? "SCALP" : "SWING";
        activeEngineKeys.add([style, position.symbol].join("|"));
      }
      for (const pending of demoPendingEntries) activeEngineKeys.add(engineKey(pending.setup));
      if (!demoConfigured) for (const position of ledger.positions.filter((p) => p.status === "OPEN")) activeEngineKeys.add(engineKey(position));
      const executedKeySet = new Set(demoExecutedKeys);
      if (!demoConfigured) for (const trade of ledger.closedTrades ?? []) if (trade.id || trade.positionId) executedKeySet.add(String(trade.positionId ?? trade.id));
      const maximumOpen = Math.min(10, Math.max(0, Number(ledger.maxOpenPositions ?? 10)));
      const queueNow = Date.now();
      const previousEntryQueueRaw = await this.readPaperState(demoConfigured ? "bingx-vst-entry-queue-v1" : "internal-paper-entry-queue-v1");
      let previousEntryQueue = [];
      try {
        const parsedQueue = previousEntryQueueRaw ? JSON.parse(previousEntryQueueRaw) : [];
        if (Array.isArray(parsedQueue)) previousEntryQueue = parsedQueue;
      } catch (error) {
        console.warn("Persisted VST entry queue is malformed; rebuilding from current structural setups", String(error).slice(0, 160));
      }
      const activeDirectionalModels = ACTIVE_VST_STRATEGY_MODELS;
      const queueByEngineKey = /* @__PURE__ */ new Map();
      for (const item of previousEntryQueue) {
        if (!item?.setup || !item.setupKey || !activeDirectionalModels.has(item.setup.model) || setupIsExpired(item.setup, queueNow)) continue;
        const key = engineKey(item.setup);
        const instanceKey = item.setupInstanceKey ?? setupInstanceKey(item.setup);
        if (executedKeySet.has(item.setupKey) || executedSetupInstances.has(instanceKey) || activeEngineKeys.has(key)) continue;
        item.setup.status = "READY";
        item.setup.executionDecisionCode = item.lastErrorCode ?? "ENTRY_READY";
        item.setup.executionDecisionReason = item.lastErrorCode ? item.setup.executionDecisionReason ?? "Strateji \u015Fartlar\u0131 tamamland\u0131; \xF6nceki emir hatas\u0131 sonras\u0131 yeniden denenecek." : item.setup.tradeStyle + " yap\u0131s\u0131 do\u011Fruland\u0131; " + (demoConfigured ? "BingX VST emir a\u015Famas\u0131na haz\u0131r." : "internal Paper giri\u015F de\u011Ferlendirmesine haz\u0131r.");
        const previous = queueByEngineKey.get(key);
        if (!previous || item.setup.score + Number(item.setup.scoreBreakdown.btcContext ?? 0) > previous.setup.score + Number(previous.setup.scoreBreakdown.btcContext ?? 0)) queueByEngineKey.set(key, item);
      }
      for (const setup of orderedCandidates) {
        if (setup.status !== "READY" || setupIsExpired(setup, queueNow)) continue;
        const setupKey = [setup.model, setup.symbol, setup.side, setup.candleTime].join("|");
        const instanceKey = setupInstanceKey(setup);
        const key = engineKey(setup);
        if (executedKeySet.has(setupKey) || executedSetupInstances.has(instanceKey) || activeEngineKeys.has(key)) continue;
        const previous = queueByEngineKey.get(key);
        if (!previous || Number(setup.candleTime) > Number(previous.setup.candleTime) || setup.candleTime === previous.setup.candleTime && setup.score > previous.setup.score) {
          setup.executionDecisionCode = "ENTRY_READY";
          setup.executionDecisionReason = setup.tradeStyle + " yap\u0131s\u0131 do\u011Fruland\u0131; " + (demoConfigured ? "BingX VST emir a\u015Famas\u0131na haz\u0131r." : "internal Paper giri\u015F de\u011Ferlendirmesine haz\u0131r.");
          queueByEngineKey.set(key, { setup, setupKey, setupInstanceKey: instanceKey, queuedAt: queueNow, attempts: 0, nextAttemptAt: queueNow });
        } else if (previous.setupKey === setupKey) {
          previous.setup = {
            ...setup,
            status: "READY",
            executionDecisionCode: previous.lastErrorCode ?? "ENTRY_READY",
            executionDecisionReason: previous.lastErrorCode ? previous.setup.executionDecisionReason ?? "\xD6nceki emir hatas\u0131 sonras\u0131 yeniden denenecek." : setup.tradeStyle + " yap\u0131s\u0131 do\u011Fruland\u0131; " + (demoConfigured ? "BingX VST emir a\u015Famas\u0131na haz\u0131r." : "internal Paper giri\u015F de\u011Ferlendirmesine haz\u0131r.")
          };
        }
      }
      let vstEntryQueue = [...queueByEngineKey.values()].sort((a, b) => b.setup.score + Number(b.setup.scoreBreakdown.btcContext ?? 0) - (a.setup.score + Number(a.setup.scoreBreakdown.btcContext ?? 0)) || a.queuedAt - b.queuedAt).slice(0, VST_ENTRY_QUEUE_MAX);
      const expiredQueueItems = vstEntryQueue.filter((item) => setupIsExpired(item.setup, Date.now())).length;
      if (expiredQueueItems) console.info("Expired setup queue items discarded before execution", expiredQueueItems);
      vstEntryQueue = vstEntryQueue.filter((item) => !setupIsExpired(item.setup, Date.now()));
      ledger.setups = [
        ...ledger.setups.filter((setup) => setup.status === "OPENED"),
        ...vstEntryQueue.map((item) => ({
          ...item.setup,
          executionDecisionCode: item.lastErrorCode ?? item.setup.executionDecisionCode,
          executionDecisionReason: item.setup.executionDecisionReason ?? (demoConfigured ? "Strateji \u015Fartlar\u0131 tamamland\u0131; BingX VST emir a\u015Famas\u0131na haz\u0131r." : "Strateji \u015Fartlar\u0131 tamamland\u0131; internal Paper giri\u015F de\u011Ferlendirmesine haz\u0131r.")
        }))
      ];
      ledger.scannedSymbols = batchSymbols;
      ledger.scanDiagnostics = filterActiveSwingDiagnostics(diagnostics);
      ledger.activitySnapshots = activitySnapshots;
      ledger.activityRanking = activityRankingResult.summary;
      ledger.activityRankingBySymbol = activityBySymbol;
      await this.writePaperState(demoConfigured ? "bingx-vst-entry-queue-v1" : "internal-paper-entry-queue-v1", JSON.stringify(vstEntryQueue));
      let paperOpened = 0;
      let paperEntryAttempts = 0;
      if (!demoConfigured && STRATEGY_GENERATION_ENABLED && NEW_PAPER_ENTRIES_ENABLED && !liquidationRiskGateActive) {
        for (const nextEntry of [...vstEntryQueue]) {
          if (Number(nextEntry.nextAttemptAt ?? 0) > Date.now()) continue;
          const setup = nextEntry.setup;
          if (!setup || setup.status !== "READY") continue;
          const instanceKey = nextEntry.setupInstanceKey ?? setupInstanceKey(setup);
          if (setupIsExpired(setup, Date.now()) || executedSetupInstances.has(instanceKey)) {
            setup.status = "EXPIRED";
            setup.executionDecisionCode = executedSetupInstances.has(instanceKey) ? "SETUP_INSTANCE_ALREADY_EXECUTED" : "PAPER_SETUP_EXPIRED";
            setup.executionDecisionReason = executedSetupInstances.has(instanceKey) ? "Bu setup örneği daha önce işlem açtı; tekrar giriş engellendi." : "Setup zaman aşımına uğradı; eski sinyal üzerinden işlem açılmadı.";
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
            continue;
          }
          paperEntryAttempts++;
          const openCount = ledger.positions.filter((p) => p.status === "OPEN").length;
          if (openCount >= maximumOpen) break;
          const duplicate = ledger.positions.some((p) => p.status === "OPEN" && p.symbol === setup.symbol && p.tradeStyle === setup.tradeStyle);
          if (duplicate || activeEngineKeys.has(engineKey(setup))) {
            setup.status = "REJECTED";
            setup.executionDecisionCode = "DUPLICATE_PAPER_POSITION";
            setup.executionDecisionReason = "Aynı motor ve yönde açık paper pozisyon zaten var; tekrar işlem açılmadı.";
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
            continue;
          }
          const now = Date.now();
          const mark = Number(scanMarks[setup.symbol]);
          const zone = setup.audit && ((setup.audit.entryExecution && setup.audit.entryExecution.entryZone) || setup.audit.zone);
          const zoneTop = Number(zone && zone.top), zoneBottom = Number(zone && zone.bottom);
          if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(zoneTop) || !Number.isFinite(zoneBottom) || zoneTop <= zoneBottom || mark < zoneBottom || mark > zoneTop) {
            setup.status = "WAIT";
            setup.executionDecisionCode = "PAPER_WAITING_FOR_ENTRY_ZONE";
            setup.executionDecisionReason = "Fiyat belirlenen giriş bölgesinde değil; retest bekleniyor, fiyat kovalanmıyor.";
            nextEntry.nextAttemptAt = now + 60 * 1000;
            const waiting = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (waiting) Object.assign(waiting, { status: "WAIT", executionDecisionCode: setup.executionDecisionCode, executionDecisionReason: setup.executionDecisionReason });
            continue;
          }
          const entry = mark, stop = Number(setup.stopLoss), tp1 = Number(setup.tp1), tp2 = Number(setup.tp2), tp3 = Number(setup.tp3);
          const stopDistance = Math.abs(entry - stop);
          const levelsValid = Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0 && Number.isFinite(stopDistance) && stopDistance > Math.max(entry * 1e-8, Number.EPSILON) && (setup.side === "LONG" ? stop < entry && entry < tp1 && tp2 > tp1 && (!Number.isFinite(tp3) || tp3 > tp2) : stop > entry && entry > tp1 && tp2 < tp1 && (!Number.isFinite(tp3) || tp3 < tp2));
          const rr = Number.isFinite(stop) && Number.isFinite(tp2) && Math.abs(entry - stop) > 0 ? Math.abs(tp2 - entry) / Math.abs(entry - stop) : 0;
          const zoneCheck = validateBingXDemoEntryZone({ ...setup, entry });
          if (!levelsValid || rr < RISK_CONFIG.minimumRiskReward || !zoneCheck.ok) {
            setup.status = "REJECTED";
            setup.executionDecisionCode = !levelsValid ? "INVALID_PAPER_SL_TP" : rr < RISK_CONFIG.minimumRiskReward ? "PAPER_RR_BELOW_MINIMUM" : zoneCheck.code;
            setup.executionDecisionReason = !levelsValid ? "Stop veya hedef seviyesi işlem yönüyle uyumsuz; paper işlem reddedildi." : rr < RISK_CONFIG.minimumRiskReward ? "İkinci hedefte minimum 1:1 risk/getiri sağlanmıyor; paper işlem reddedildi." : "Giriş teyidi geçersiz; işlem açılmadı.";
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
            const rejected = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (rejected) Object.assign(rejected, { status: "REJECTED", executionDecisionCode: setup.executionDecisionCode, executionDecisionReason: setup.executionDecisionReason });
            continue;
          }
          const configuredRiskPct = Number(this.env.PAPER_TRADE_ALLOCATION_PERCENT ?? RISK_CONFIG.normalRiskPercentOfEquity);
          const safeRiskPct = Number.isFinite(configuredRiskPct) && configuredRiskPct > 0 && configuredRiskPct <= RISK_CONFIG.normalRiskPercentOfEquity ? configuredRiskPct : RISK_CONFIG.normalRiskPercentOfEquity;
          fixedRiskUnitUsdt = round(Math.max(0, Number(ledger.balance) * safeRiskPct / 100), 8);
          const reservedMargin = ledger.positions.filter((p) => p.status === "OPEN").reduce((sum, p) => sum + Math.max(0, Number(p.marginUsdt ?? p.initialMarginUsdt ?? 0)), 0);
          const availableMargin = Math.max(0, Number(ledger.balance) - reservedMargin);
          const sizing = calculateBingXDemoEntrySizing({ entry, stopLoss: stop, equity: Number(ledger.equity ?? ledger.balance), availableMargin, precision: 8, minQty: 0, riskMultiplier: setup.riskMultiplier, fixedRiskUnitUsdt });
          if (!sizing.ok) {
            setup.status = "REJECTED";
            setup.executionDecisionCode = sizing.code;
            setup.executionDecisionReason = "Paper risk veya izole marjin koşulu uygun değil: " + sizing.error;
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
            const rejected = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (rejected) Object.assign(rejected, { status: "REJECTED", executionDecisionCode: setup.executionDecisionCode, executionDecisionReason: setup.executionDecisionReason });
            continue;
          }
          const feeRate = FEE_RATE;
          const entryFeeUsdt = round(sizing.quantity * entry * feeRate, 8);
          if (sizing.marginUsdt + entryFeeUsdt > ledger.balance + 1e-8) {
            setup.status = "REJECTED";
            setup.executionDecisionCode = "PAPER_MARGIN_BUDGET_EXCEEDED";
            setup.executionDecisionReason = "Marjin ve işlem maliyeti paper bakiyesini aşıyor; işlem açılmadı.";
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
            const rejected = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (rejected) Object.assign(rejected, { status: "REJECTED", executionDecisionCode: setup.executionDecisionCode, executionDecisionReason: setup.executionDecisionReason });
            continue;
          }
          const openedAt = now, at = new Date(now).toISOString();
          const fundingSnapshot = latestFundingSnapshots.get(setup.symbol);
          const entrySlippageUsdt = round(sizing.quantity * entry * SLIPPAGE_RATE, 8);
          const position = {
            id: nextEntry.setupKey, positionId: nextEntry.setupKey, setupInstanceKey: instanceKey, symbol: setup.symbol, side: setup.side, model: setup.model,
            tradeStyle: setup.tradeStyle, status: "OPEN", entry, stopLoss: stop, tp1, tp2, tp3: Number.isFinite(tp3) ? tp3 : void 0,
            tp4: Number.isFinite(Number(setup.tp4)) ? Number(setup.tp4) : void 0, takeProfit: Number.isFinite(tp3) ? tp3 : tp2,
            qty: sizing.quantity, initialQty: sizing.quantity, targetStage: 0, targetStagesReached: [], realizedPnlUsdt: -entrySlippageUsdt,
            riskUsdt: sizing.riskBudget, initialRiskUsdt: sizing.estimatedLoss, leverage: sizing.leverage, effectiveLeverage: sizing.leverage,
            leveragePolicyMax: MAX_LEVERAGE, leverageSource: "internal-paper-policy", notionalUsdt: sizing.notionalUsdt,
            marginUsdt: sizing.marginUsdt, allocationUsdt: sizing.marginUsdt, initialMarginUsdt: sizing.marginUsdt,
            entryFeeUsdt, exitFeesUsdt: 0, feesPaidUsdt: entryFeeUsdt, slippagePaidUsdt: entrySlippageUsdt, feeRate, feeAccountingVersion: 2, fundingPaidUsdt: 0, fundingEvents: [], lastFundingTime: 0, fundingRateSnapshot: Number.isFinite(fundingSnapshot?.rate) ? fundingSnapshot.rate : null, fundingNextTime: Number.isFinite(fundingSnapshot?.nextFundingTime) ? fundingSnapshot.nextFundingTime : null, fundingIntervalHours: Number.isFinite(fundingSnapshot?.fundingIntervalHours) ? fundingSnapshot.fundingIntervalHours : 8, fundingSnapshotAt: fundingSnapshot ? new Date(fundingSnapshot.updateTime || fundingSnapshot.fetchedAt).toISOString() : null, fundingDataStatus: fundingSnapshot ? "AVAILABLE" : "UNAVAILABLE", maintenanceMarginRate: DEFAULT_MAINTENANCE_MARGIN_RATE,
            liquidationPrice: calculateLiquidationPrice(entry, setup.side, sizing.leverage, DEFAULT_MAINTENANCE_MARGIN_RATE),
            openedAt, markPrice: mark, lastMarkPrice: mark, markPriceAt: at, livePriceAt: at, livePriceAvailable: true, unrealizedPnlUsdt: 0,
            score: setup.score, confidence: Number.isFinite(Number(setup.confidence)) ? Number(setup.confidence) <= 1 ? Number(setup.confidence) * 100 : Number(setup.confidence) : null,
            confidenceStatus: setup.confidenceStatus ?? "INSUFFICIENT_DATA", confidenceSampleSize: Number(setup.confidenceSampleSize) || 0,
            setupTimeframe: setup.setupTimeframe, entryTimeframe: setup.entryTimeframe, setupReason: setup.reason ?? "",
            confirmations: Array.isArray(setup.confirmations) ? setup.confirmations : [], scoreBreakdown: setup.scoreBreakdown ?? {},
            riskReward: rr, audit: setup.audit ?? null, btcContextStatus: setup.btcContextStatus ?? "UNAVAILABLE",
            maxHoldHours: Number.isFinite(setup.maxHoldHours) ? setup.maxHoldHours : 168, source: "INTERNAL_PAPER",
            executionEvents: [{ event: "PAPER_ENTRY", at, entry, markPrice: mark, qty: sizing.quantity, riskBudget: sizing.riskBudget, leverage: sizing.leverage }]
          };
          ledger.balance = round(ledger.balance - entryFeeUsdt - entrySlippageUsdt, 8);
          ledger.dailyPnl = round((Number(ledger.dailyPnl) || 0) - entryFeeUsdt - entrySlippageUsdt, 8);
          ledger.positions.push(position);
          executedSetupInstances.add(position.setupInstanceKey);
          await this.writePaperState(demoConfigured ? "bingx-vst-executed-setup-instances-v1" : "internal-paper-executed-setup-instances-v1", JSON.stringify([...executedSetupInstances].slice(-5000)));
          setup.entry = entry;
          setup.status = "OPENED";
          setup.executionDecisionCode = "PAPER_OPENED";
          setup.executionDecisionReason = "Fiyat giriş bölgesine geldi; iç paper hesapta sanal pozisyon açıldı.";
          setup.executionDecisionAt = at;
          markBingXDirectSetupOpened(ledger, setup, at);
          const openedCandidate = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
          if (openedCandidate) Object.assign(openedCandidate, { status: "OPENED", entry, executionDecisionCode: "PAPER_OPENED", executionDecisionReason: setup.executionDecisionReason, executionDecisionAt: at });
          vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== nextEntry.setupKey);
          activeEngineKeys.add(engineKey(setup));
          paperOpened++;
        }
      }
      let vstOpened = 0;
      let vstEntryAttempts = 0;
      if (STRATEGY_GENERATION_ENABLED && NEW_PAPER_ENTRIES_ENABLED && demoConfigured && demoSnapshot && fixedRiskUnitUsdt > 0 && !demoProtectionCleanupPending && !liquidationRiskGateActive && demoSnapshot.openOrdersComplete !== false) {
        while (demoSnapshot.positions.length + demoPendingEntries.length + vstOpened < maximumOpen) {
          const nextEntry = vstEntryQueue.find((item) => item.nextAttemptAt <= Date.now() && !activeEngineKeys.has(engineKey(item.setup)));
          if (!nextEntry) break;
          const setup = nextEntry.setup;
          const setupKey = nextEntry.setupKey;
          const instanceKey = nextEntry.setupInstanceKey ?? setupInstanceKey(setup);
          if (executedSetupInstances.has(instanceKey)) { vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== setupKey); continue; }
          if (!ACTIVE_VST_STRATEGY_MODELS.has(setup.model)) {
            vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== setupKey);
            setup.status = "REJECTED";
            setup.executionDecisionCode = "STRATEGY_NOT_ALLOWLISTED";
            setup.executionDecisionReason = "Bu setup aktif Scalp/Swing allowlist'inde de\u011Fil; emir g\xF6nderilmedi.";
            continue;
          }
          vstEntryAttempts++;
          const vstSetup = {
            symbol: setup.symbol,
            side: setup.side,
            model: setup.model,
            tradeStyle: setup.tradeStyle,
            entry: setup.entry,
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            tp3: setup.tp3,
            tp4: setup.tp4,
            candleTime: setup.candleTime,
            setupCandleTime: setup.setupCandleTime,
            score: setup.score,
            maxHoldHours: 168,
            entryConfirmed: setup.status === "READY",
            setupTimeframe: setup.setupTimeframe,
            entryTimeframe: setup.entryTimeframe,
            setupReason: setup.reason,
            confirmations: setup.confirmations,
            scoreBreakdown: setup.scoreBreakdown,
            riskReward: setup.riskReward,
            riskMultiplier: setup.riskMultiplier,
            fixedRiskUnitUsdt,
            confidence: setup.confidence,
            btcContextStatus: setup.btcContextStatus,
            audit: setup.audit
          };
          const opened = await placeBingXDemoEntry(this.env.BINGX_API_KEY, this.env.BINGX_API_SECRET, vstSetup, demoSnapshot, setupKey);
          if (!opened.ok) {
            setup.executionDecisionCode = opened.code;
            setup.executionDecisionReason = opened.error;
            setup.executionDecisionAt = (/* @__PURE__ */ new Date()).toISOString();
            nextEntry.lastErrorCode = opened.code;
            nextEntry.attempts++;
            const retryable = opened.code === "MARKET_PRICE_UNAVAILABLE" || opened.code === "DEMO_BALANCE_UNAVAILABLE" || opened.code === "INSUFFICIENT_AVAILABLE_MARGIN" || /429|HTTP 5\\d\\d|timeout|rate.?limit|fetch failed|temporarily unavailable/i.test(opened.error);
            if (retryable && nextEntry.attempts < 4) {
              setup.status = "WAIT";
              nextEntry.nextAttemptAt = Date.now() + Math.min(5 * 60 * 1e3, 60 * 1e3 * nextEntry.attempts);
            } else {
              setup.status = "REJECTED";
              const diagnostic = diagnostics.find((item) => item.symbol === setup.symbol);
              if (diagnostic) (diagnostic.setupDetails ??= []).push({
                model: setup.model,
                tradeStyle: setup.tradeStyle,
                entryTimeframe: setup.entryTimeframe,
                setupTimeframe: setup.setupTimeframe,
                side: setup.side,
                score: setup.score,
                status: "REJECTED",
                reason: opened.error,
                candleTime: setup.candleTime
              });
              vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== setupKey);
            }
            const failedCandidate = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (failedCandidate) {
              failedCandidate.status = setup.status;
              failedCandidate.executionDecisionCode = setup.executionDecisionCode;
              failedCandidate.executionDecisionReason = setup.executionDecisionReason;
              failedCandidate.executionDecisionAt = setup.executionDecisionAt;
            }
            continue;
          }
          if (opened.mode === "MARKET") {
            if (!demoMetadata.some((meta) => meta.setupKey === setupKey || meta.entryOrderId === String(opened.order?.orderId ?? "")))
              demoMetadata.push(opened.position);
            demoExecutedKeys = [.../* @__PURE__ */ new Set([...demoExecutedKeys, setupKey])].slice(-500);
            executedSetupInstances.add(instanceKey);
            await this.writePaperState("bingx-vst-executed-setup-instances-v1", JSON.stringify([...executedSetupInstances].slice(-5000)));
            markBingXDirectSetupOpened(ledger, setup);
            await this.writePaperState("bingx-demo-position-meta", JSON.stringify(demoMetadata));
            await this.writePaperState("bingx-demo-executed-setup-keys", JSON.stringify(demoExecutedKeys));
            setup.status = "OPENED";
            setup.executionDecisionCode = "OPENED";
            setup.executionDecisionReason = "Canl\u0131 BingX fiyat\u0131 LONG/SHORT giri\u015F b\xF6lgesinin i\xE7indeydi; MARKET giri\u015F ve SL/TP korumalar\u0131 do\u011Fruland\u0131.";
            setup.executionDecisionAt = (/* @__PURE__ */ new Date()).toISOString();
            vstOpened++;
            if (demoSnapshot.balance) demoSnapshot.balance.availableMargin = Math.max(0, demoSnapshot.balance.availableMargin - opened.position.marginUsdt);
          } else {
            opened.pending.setupInstanceKey = instanceKey;
            demoPendingEntries.push(opened.pending);
            setup.status = "WAIT";
            setup.executionDecisionCode = "LIMIT_ORDER_PENDING";
            setup.executionDecisionReason = "Fiyat giri\u015F b\xF6lgesine hen\xFCz ula\u015Fmad\u0131; BingX VST PostOnly LIMIT emir bekliyor. Giri\u015F: " + setup.entry + " \xB7 B\xF6lge: " + String(setup.audit?.entryExecution?.entryZone?.bottom ?? "\u2014") + "\u2013" + String(setup.audit?.entryExecution?.entryZone?.top ?? "\u2014");
            setup.executionDecisionAt = (/* @__PURE__ */ new Date()).toISOString();
            const pendingCandidate = ledger.setups.find((item) => item.symbol === setup.symbol && item.side === setup.side && item.model === setup.model && item.candleTime === setup.candleTime);
            if (pendingCandidate) {
              pendingCandidate.status = "WAIT";
              pendingCandidate.executionDecisionCode = "LIMIT_ORDER_PENDING";
              pendingCandidate.executionDecisionReason = setup.executionDecisionReason;
              pendingCandidate.executionDecisionAt = setup.executionDecisionAt;
            }
            await this.writePaperState("bingx-demo-pending-limit-entries", JSON.stringify(demoPendingEntries));
            if (demoSnapshot.balance) demoSnapshot.balance.availableMargin = Math.max(0, demoSnapshot.balance.availableMargin - opened.pending.marginUsdt);
          }
          vstEntryQueue = vstEntryQueue.filter((item) => item.setupKey !== setupKey);
          activeEngineKeys.add(engineKey(setup));
        }
      }
      await this.writePaperState(demoConfigured ? "bingx-vst-entry-queue-v1" : "internal-paper-entry-queue-v1", JSON.stringify(vstEntryQueue));
      for (const diagnostic of diagnostics) {
        const own = generatedSetups.filter((setup) => setup.symbol === diagnostic.symbol);
        diagnostic.setups = own.length;
        diagnostic.setupDetails = own.map((setup) => ({
          model: setup.model,
          tradeStyle: setup.tradeStyle,
          entryTimeframe: setup.entryTimeframe,
          setupTimeframe: setup.setupTimeframe,
          side: setup.side,
          score: setup.score,
          status: setup.status,
          reason: setup.executionDecisionReason ?? setup.reason,
          candleTime: setup.candleTime
        }));
      }
      ledger.scanUniverseSize = universeSymbols.length;
      ledger.scanBatchSize = batchSymbols.length;
      ledger.scanInvocationBatchSize = batchSymbols.length;
      const successfullyScannedSymbols = batchSymbols; // A symbol with explicitly diagnosed missing candles is still scanned; it must not block rotation completion.
      const scanRotationMeasuredAt = (/* @__PURE__ */ new Date()).toISOString();
      ledger.scanRotation = updateScanRotationProgress(ledger.scanRotation, universeSymbols, successfullyScannedSymbols, scanRotationMeasuredAt, scanRotationGenerationAtStart);
      const scanRotationCompletedNow = ledger.scanRotation?.lastCompletedAt === scanRotationMeasuredAt;
      ledger.scanLogicalBatchRemaining = SCANNER_PAUSED || scanRotationCompletedNow ? 0 : Math.max(0, universeSymbols.length - (ledger.scanRotation?.seenSymbols.length ?? 0));
      ledger.lastScanAt = (/* @__PURE__ */ new Date()).toISOString();
      engine.lastScanAt = ledger.lastScanAt;
      engine.lastScannedSymbol = batchSymbols.at(-1) ?? engine.lastScannedSymbol;
      ledger.equity = Number((ledger.balance + ledger.positions.filter((p) => p.status === "OPEN").reduce((sum, p) => sum + Number(p.unrealizedPnlUsdt ?? 0), 0)).toFixed(8));
      const readyCandidateCount = orderedCandidates.filter((setup) => setup.status === "READY").length;
      const dueQueueCount = vstEntryQueue.filter((item) => item.nextAttemptAt <= Date.now()).length;
      const pendingEntryCount = demoConfigured ? demoPendingEntries.length : 0;
      const reservedEntryCapacity = (demoConfigured ? (demoSnapshot?.positions.length ?? 0) : ledger.positions.filter((p) => p.status === "OPEN").length) + pendingEntryCount;
      const availableEntrySlots = Math.max(0, maximumOpen - reservedEntryCapacity);
      const eligibleDueQueueCount = vstEntryQueue.filter((item) => item.nextAttemptAt <= Date.now() && !activeEngineKeys.has(engineKey(item.setup))).length;
      const entryGateBlockedBy = [];
      if (!STRATEGY_GENERATION_ENABLED) entryGateBlockedBy.push("STRATEGY_GENERATION_DISABLED");
      if (!NEW_PAPER_ENTRIES_ENABLED) entryGateBlockedBy.push("NEW_PAPER_ENTRIES_DISABLED");
      if (!demoConfigured && paperOpened === 0 && readyCandidateCount > 0) entryGateBlockedBy.push("PAPER_ENTRY_WAITING_FOR_ZONE_OR_RISK_FILTER");
      if (demoConfigured && !demoSnapshot) entryGateBlockedBy.push("BINGX_VST_SNAPSHOT_UNAVAILABLE");
      if (demoProtectionCleanupPending) entryGateBlockedBy.push("PROTECTIVE_ORDER_CLEANUP_PENDING");
      if (liquidationRiskGateActive) entryGateBlockedBy.push("LIQUIDATION_RISK_GATE_ACTIVE");
      if (demoSnapshot?.openOrdersComplete === false) entryGateBlockedBy.push("EXCHANGE_OPEN_ORDERS_INCOMPLETE");
      if (demoSnapshot && availableEntrySlots === 0) entryGateBlockedBy.push(pendingEntryCount > 0 ? "MAX_OPEN_CAPACITY_RESERVED_BY_PENDING_ENTRIES" : "MAX_OPEN_POSITIONS_REACHED");
      if (readyCandidateCount === 0 && vstEntryQueue.length === 0) entryGateBlockedBy.push("NO_READY_CANDIDATE");
      if (readyCandidateCount > 0 && vstEntryQueue.length === 0) entryGateBlockedBy.push("READY_CANDIDATES_ALREADY_ACTIVE_OR_EXECUTED");
      if (vstEntryQueue.length > 0 && dueQueueCount === 0) entryGateBlockedBy.push("ENTRY_QUEUE_RETRY_BACKOFF");
      if (dueQueueCount > 0 && eligibleDueQueueCount === 0) entryGateBlockedBy.push("NO_ELIGIBLE_DUE_QUEUE_ITEM");
      ledger.scanTelemetry = {
        measuredAt: (/* @__PURE__ */ new Date()).toISOString(),
        durationMs: Date.now() - scanStartedAt,
        vstEntryAttempts,
        vstOpened,
        paperEntryAttempts,
        paperOpened,
        entryGateDiagnostics: {
          blockedBy: entryGateBlockedBy,
          readyCandidates: readyCandidateCount,
          queueCount: vstEntryQueue.length,
          dueQueueCount,
          eligibleDueQueueCount,
          pendingEntryCount,
          reservedEntryCapacity,
          availableEntrySlots,
          openPositionCount: demoConfigured ? (demoSnapshot?.positions.length ?? null) : ledger.positions.filter((p) => p.status === "OPEN").length,
          openOrderCount: demoSnapshot?.openOrders.length ?? null,
          maximumOpenPositions: maximumOpen,
          liquidationRiskWarningSymbols: [...new Set(liquidationRiskWarningSymbols)],
          openOrdersComplete: demoSnapshot ? demoSnapshot.openOrdersComplete !== false : null,
          demoConfigured,
          demoSnapshotAvailable: !!demoSnapshot,
          demoAccountError: demoAccountError ? String(demoAccountError).slice(0, 180) : null
        },
        upstreamCandleRequests: marketDataStats.upstreamRequests - cacheStatsStart.upstreamRequests,
        candleCacheHits: marketDataStats.cacheHits - cacheStatsStart.cacheHits,
        inFlightDedupHits: marketDataStats.inFlightDedupHits - cacheStatsStart.inFlightDedupHits,
        candleFetchErrors: marketDataStats.failures - cacheStatsStart.failures,
        scanErrorCount: scanErrors.length,
        candleErrorsBySymbolTimeframe: scanErrors.slice(0, 100),
        scalpInsufficientCandleHistoryCount: diagnostics.filter((item) => item.engineAvailability?.scalp?.available === false).length,
        swingInsufficientCandleHistoryCount: diagnostics.filter((item) => item.engineAvailability?.swing?.available === false).length,
        policyLevel: "normal",
        healthStatus: universeError || batchSymbols.length === 0 || symbolsToEvaluate.length === 0 || successfullyScannedSymbols.length < batchSymbols.length * 0.85 || diagnostics.some((item) => item.engineAvailability?.scalp?.available === false || item.engineAvailability?.swing?.available === false) ? "partial" : "healthy",
        failureRatio: diagnostics.length ? (diagnostics.filter((item) => item.engineAvailability?.scalp?.available === false).length + diagnostics.filter((item) => item.engineAvailability?.swing?.available === false).length) / (diagnostics.length * 2) : 1,
        insufficientCandleHistoryCount: diagnostics.filter((item) => item.status === "insufficient-candle-history").length,
        successfulCandleCoverageCount: successfullyScannedSymbols.length,
        retryQueueSize: 0,
        invocationBatchSize: symbolsToEvaluate.length,
        logicalBatchRemaining: ledger.scanLogicalBatchRemaining,
        nextBatchSize: PAPER_SCAN_BATCH_NORMAL,
        lastError: universeError ?? (scanErrors[0] ? [scanErrors[0].symbol, scanErrors[0].timeframe ?? scanErrors[0].engine ?? "MARKET_DATA", scanErrors[0].error].join(":") : batchSymbols.length === 0 ? "NO_SYMBOLS_SCANNED" : null)
      };
      {
        const latestEngine = await this.readEngineState();
        const latestLedger = latestEngine.paperLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
        const initialPositions = new Map(scanPositionStateAtStart);
        latestLedger.positions = Array.isArray(latestLedger.positions) ? latestLedger.positions : [];
        latestLedger.closedTrades = Array.isArray(latestLedger.closedTrades) ? latestLedger.closedTrades : [];
        if (latestLedger.duplicateCloseRepairV1 !== true) {
          const originalTrades = latestLedger.closedTrades;
          const canonicalById = new Map();
          for (const trade of originalTrades) {
            if (trade.closeSource !== "AUTOMATED_SL_TP" && trade.closeSource !== "LIQUIDATION") continue;
            const id = String(trade.positionId ?? trade.id ?? "");
            if (!id) continue;
            const prior = canonicalById.get(id);
            if (!prior || Number(trade.closedAt) < Number(prior.closedAt)) canonicalById.set(id, trade);
          }
          const seenAutomatedIds = new Set(), duplicateGroups = new Map(), dedupedTrades = [];
          for (const trade of originalTrades) {
            const automated = trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION";
            const id = String(trade.positionId ?? trade.id ?? "");
            if (!automated || !id) { dedupedTrades.push(trade); continue; }
            const canonical = canonicalById.get(id);
            if (!seenAutomatedIds.has(id)) { dedupedTrades.push(canonical); seenAutomatedIds.add(id); }
            if (trade !== canonical) { const group = duplicateGroups.get(id) ?? []; group.push(trade); duplicateGroups.set(id, group); }
          }
          latestLedger.closedTrades = dedupedTrades.sort((left, right) => Number(right.closedAt ?? 0) - Number(left.closedAt ?? 0));
          const alreadyClosedIds = new Set(canonicalById.keys());
          latestLedger.positions = latestLedger.positions.filter((position) => !(position.status === "OPEN" && alreadyClosedIds.has(String(position.id))));
          const duplicateRows = [...duplicateGroups.entries()].flatMap(([positionId, rows]) => rows.map((trade) => ({ positionId, closedAt: trade.closedAt, pnlUsdt: trade.pnlUsdt, realizedPnlUsdt: trade.realizedPnlUsdt, closeReason: trade.closeReason })));
          if (duplicateRows.length) {
            const capitalEvents = Array.isArray(latestLedger.capitalAdjustments) ? latestLedger.capitalAdjustments : [];
            const firstCapital = capitalEvents[0] ?? {};
            const baseCapital = Number(firstCapital.balanceAfter ?? firstCapital.targetUsdt);
            const laterCapitalDelta = capitalEvents.slice(1).reduce((sum, event) => sum + (Number(event.amountUsdt) || 0), 0);
            const startingCapital = Number.isFinite(baseCapital) && baseCapital > 0 ? baseCapital + laterCapitalDelta : NaN;
            const closedNet = latestLedger.closedTrades.reduce((sum, trade) => { const net = Number.isFinite(Number(trade.pnlUsdt)) ? Number(trade.pnlUsdt) : Number(trade.realizedPnlUsdt ?? 0) - Number(trade.entryFeeUsdt ?? 0); return sum + net; }, 0);
            const openNet = latestLedger.positions.filter((position) => position.status === "OPEN").reduce((sum, position) => sum + (Number(position.realizedPnlUsdt) || 0) - (Number(position.entryFeeUsdt) || 0), 0);
            const expectedBalance = round(startingCapital + closedNet + openNet, 8);
            const balanceBefore = Number(latestLedger.balance) || 0;
            const dailyPnlBefore = Number(latestLedger.dailyPnl) || 0;
            const balanceCorrection = round(expectedBalance - balanceBefore, 8);
            const startOfDayBalance = balanceBefore - dailyPnlBefore;
            const repairAt = Date.now();
            const repairDay = String(latestLedger.dayKey ?? new Date(repairAt).toISOString().slice(0, 10));
            const duplicatesAreToday = duplicateRows.every((row) => Number.isFinite(Number(row.closedAt)) && new Date(Number(row.closedAt)).toISOString().slice(0, 10) === repairDay);
            if (Number.isFinite(expectedBalance) && expectedBalance > 0 && Number.isFinite(balanceCorrection)) {
              latestLedger.balance = expectedBalance;
              if (duplicatesAreToday) latestLedger.dailyPnl = round(expectedBalance - startOfDayBalance, 8);
              latestLedger.reconciliationEvents = [...(latestLedger.reconciliationEvents ?? []), { id: "duplicate-close-repair-v1-" + repairAt, at: new Date(repairAt).toISOString(), type: "DUPLICATE_AUTOMATED_CLOSE_RECONCILIATION", status: "APPLIED", affectedPositionIds: [...duplicateGroups.keys()], duplicateRecordCount: duplicateRows.length, canonicalClosedTradeCount: duplicateGroups.size, balanceBefore, balanceCorrection, balanceAfter: latestLedger.balance, dailyPnlBefore, dailyPnlCorrection: duplicatesAreToday ? round(latestLedger.dailyPnl - dailyPnlBefore, 8) : null, dailyPnlAfter: latestLedger.dailyPnl, method: "Starting paper capital + unique closed-trade net PnL + remaining open positions realized PnL less entry fees." }];
              latestLedger.balanceReconciliationStatus = "RECONCILED";
            } else latestLedger.balanceReconciliationStatus = "REVIEW_REQUIRED";
            latestLedger.duplicateCloseAudit = [...(latestLedger.duplicateCloseAudit ?? []), ...[...duplicateGroups.entries()].map(([positionId, rows]) => ({ positionId, canonicalClosedAt: canonicalById.get(positionId)?.closedAt ?? null, duplicateClosedAt: rows.map((trade) => trade.closedAt), duplicateCount: rows.length, duplicatePnlUsdt: rows.map((trade) => trade.pnlUsdt), detectedAt: new Date(repairAt).toISOString() }))];
            latestLedger.duplicateCloseReconciliation = { status: latestLedger.balanceReconciliationStatus, duplicateRecordCount: duplicateRows.length, canonicalClosedTradeCount: duplicateGroups.size, balanceCorrection: Number.isFinite(balanceCorrection) ? balanceCorrection : null, affectedPositionIds: [...duplicateGroups.keys()] };
          } else latestLedger.duplicateCloseReconciliation = { status: "NO_DUPLICATES", duplicateRecordCount: 0 };
          latestLedger.duplicateCloseRepairV1 = true;
        }
        const initialAutomatedClosedIds = new Set(latestLedger.closedTrades.filter((trade) => trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION").map((trade) => String(trade.positionId ?? trade.id ?? "")));
        latestLedger.positions = latestLedger.positions.filter((position) => !(position.status === "OPEN" && initialAutomatedClosedIds.has(String(position.id))));
        for (const scanned of ledger.positions) {
          const current = latestLedger.positions.find((position) => position.id === scanned.id);
          const prior = initialPositions.get(scanned.id);
          const unchanged = current && prior && current.status === "OPEN" && current.qty === prior.qty && current.stopLoss === prior.stopLoss && Number(current.targetStage ?? 0) === Number(prior.targetStage ?? 0) && Number(current.realizedPnlUsdt ?? 0) === Number(prior.realizedPnlUsdt ?? 0);
          if (unchanged && scanned.status === "OPEN") Object.assign(current, scanned);
          else if (!current && !prior && scanned.status === "OPEN") latestLedger.positions.push(scanned);
        }
        const latestClosedKeys = new Set(latestLedger.closedTrades.map(closeKey));
        const automatedClosedIds = new Set(latestLedger.closedTrades.filter((trade) => trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION").map((trade) => String(trade.positionId ?? trade.id ?? "")));
        let rejectedCloseDelta = 0;
        for (const trade of ledger.closedTrades) {
          const tradeAt = Number(trade.closedAt);
          if (!Number.isFinite(tradeAt) || tradeAt < scanStartedAt) continue;
          const positionId = String(trade.positionId ?? trade.id ?? "");
          const prior = initialPositions.get(positionId);
          const automated = trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION";
          if (automated && prior) {
            const current = latestLedger.positions.find((position) => position.id === positionId);
            const matchesSnapshot = current && current.status === "OPEN" && current.qty === prior.qty && current.stopLoss === prior.stopLoss && Number(current.targetStage ?? 0) === Number(prior.targetStage ?? 0) && Number(current.realizedPnlUsdt ?? 0) === Number(prior.realizedPnlUsdt ?? 0);
            const closeDelta = (Number(trade.realizedPnlUsdt) || 0) - (Number(prior.realizedPnlUsdt) || 0);
            if (automatedClosedIds.has(positionId) || !matchesSnapshot) {
              if (current && automatedClosedIds.has(positionId) && matchesSnapshot) latestLedger.positions = latestLedger.positions.filter((position) => position.id !== positionId);
              rejectedCloseDelta += closeDelta;
              continue;
            }
            latestLedger.positions = latestLedger.positions.filter((position) => position.id !== positionId);
            if (!latestClosedKeys.has(closeKey(trade))) { latestLedger.closedTrades.unshift(trade); latestClosedKeys.add(closeKey(trade)); }
            automatedClosedIds.add(positionId);
            continue;
          }
          if (!latestClosedKeys.has(closeKey(trade))) { latestLedger.closedTrades.unshift(trade); latestClosedKeys.add(closeKey(trade)); }
        }
        latestLedger.positions = latestLedger.positions.filter((position) => position.status === "OPEN");

        const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (latestLedger.dayKey !== today) {
          latestLedger.dayKey = today;
          const todayCapitalDeltaAtRollover = (latestLedger.capitalAdjustments ?? []).slice(1).filter((event) => { const at = typeof event.at === "string" ? Date.parse(event.at) : Number(event.at); return Number.isFinite(at) && at >= Date.parse(today + "T00:00:00.000Z"); }).reduce((sum, event) => sum + (Number(event.amountUsdt) || 0), 0);
          latestLedger.dailyStartBalance = Number((scanBalanceAtStart - todayCapitalDeltaAtRollover).toFixed(8));
          latestLedger.dailyPnl = 0;
        }
        latestLedger.balance = Number((latestLedger.balance + (ledger.balance - scanBalanceAtStart) - rejectedCloseDelta).toFixed(8));
        latestLedger.dailyPnl = Number((latestLedger.dailyPnl + (ledger.dailyPnl - scanDailyPnlAtStart) - rejectedCloseDelta).toFixed(8));
        const capitalEvents = Array.isArray(latestLedger.capitalAdjustments) ? latestLedger.capitalAdjustments : [];
        const baseCapital = Number(capitalEvents[0]?.balanceAfter ?? capitalEvents[0]?.targetUsdt ?? 1e3);
        const laterCapitalDelta = capitalEvents.slice(1).reduce((sum, event) => sum + (Number(event.amountUsdt) || 0), 0);
        const canonicalClosedIds = new Set();
        const canonicalCloseKeys = new Set();
        let canonicalClosedPnl = 0;
        const closedForAccounting = [...(latestLedger.closedTrades ?? [])].sort((left, right) => Number(left.closedAt ?? 0) - Number(right.closedAt ?? 0));
        for (const trade of closedForAccounting) {
          const automated = trade.closeSource === "AUTOMATED_SL_TP" || trade.closeSource === "LIQUIDATION";
          const positionId = String(trade.positionId ?? trade.id ?? "");
          const closeIdentity = String(trade.id ?? "") + "|" + String(trade.closedAt ?? "") + "|" + String(trade.closeReason ?? "");
          if (automated) {
            if (canonicalClosedIds.has(positionId)) continue;
            canonicalClosedIds.add(positionId);
          } else {
            if (canonicalCloseKeys.has(closeIdentity)) continue;
            canonicalCloseKeys.add(closeIdentity);
          }
          const pnl = Number(trade.pnlUsdt);
          const fallbackPnl = (Number(trade.realizedPnlUsdt) || 0) - (Number(trade.entryFeeUsdt) || 0);
          canonicalClosedPnl += Number.isFinite(pnl) ? pnl : fallbackPnl;
        }
        const canonicalOpenPnl = (latestLedger.positions ?? []).filter((position) => position.status === "OPEN").reduce((sum, position) => sum + (Number(position.realizedPnlUsdt) || 0) - (Number(position.entryFeeUsdt) || 0), 0);
        const canonicalBalance = Number((baseCapital + laterCapitalDelta + canonicalClosedPnl + canonicalOpenPnl).toFixed(8));
        const balanceBeforeCanonical = Number(latestLedger.balance) || 0;
        const balanceCorrection = Number((canonicalBalance - balanceBeforeCanonical).toFixed(8));
        if (Number.isFinite(canonicalBalance) && canonicalBalance >= 0 && Math.abs(balanceCorrection) >= 0.01) {
          latestLedger.balance = canonicalBalance;
          latestLedger.balanceReconciliationStatus = "RECONCILED";
          latestLedger.balanceReconciliationAudit = [...(latestLedger.balanceReconciliationAudit ?? []), { at: new Date().toISOString(), type: "PAPER_LEDGER_CANONICAL_BALANCE_V2", status: "APPLIED", balanceBefore: balanceBeforeCanonical, balanceCorrection, balanceAfter: canonicalBalance, baseCapital, laterCapitalDelta, uniqueClosedTradeCount: canonicalClosedIds.size + canonicalCloseKeys.size, openPositionCount: (latestLedger.positions ?? []).filter((position) => position.status === "OPEN").length, method: "Initial capital + later capital adjustments + unique closed net PnL + open realized PnL less remaining entry fees." }].slice(-20);
        } else if (Number.isFinite(canonicalBalance) && canonicalBalance >= 0) {
          latestLedger.balanceReconciliationStatus = "RECONCILED";
        }
        const utcDayStart = Date.parse(today + "T00:00:00.000Z");
        let dailyStartBalance = Number(latestLedger.dailyStartBalance);
        const todayCapitalDelta = capitalEvents.slice(1).filter((event) => { const at = typeof event.at === "string" ? Date.parse(event.at) : Number(event.at); return Number.isFinite(at) && at >= utcDayStart; }).reduce((sum, event) => sum + (Number(event.amountUsdt) || 0), 0);
        if (!Number.isFinite(dailyStartBalance)) {
          dailyStartBalance = baseCapital + capitalEvents.slice(1).filter((event) => { const at = typeof event.at === "string" ? Date.parse(event.at) : Number(event.at); return Number.isFinite(at) && at < utcDayStart; }).reduce((sum, event) => sum + (Number(event.amountUsdt) || 0), 0);
          const seenDailyPositionIds = new Set();
          const dailyPositionRecords = [...(latestLedger.closedTrades ?? []), ...(latestLedger.positions ?? []).filter((position) => position.status === "OPEN")];
          for (const position of dailyPositionRecords) {
            const positionId = String(position.positionId ?? position.id ?? "");
            if (seenDailyPositionIds.has(positionId)) continue;
            seenDailyPositionIds.add(positionId);
            const feeRate = Number.isFinite(Number(position.feeRate)) ? Math.max(0, Number(position.feeRate)) : DEFAULT_TAKER_FEE_RATE;
            for (const event of position.executionEvents ?? []) {
              const eventAt = typeof event.at === "string" ? Date.parse(event.at) : Number(event.at);
              const qty = Number(event.qty);
              if (!Number.isFinite(eventAt) || eventAt >= utcDayStart || !Number.isFinite(qty) || qty <= 0) continue;
              if (event.event === "PAPER_ENTRY") {
                const entryPrice = Number(event.entry ?? position.entry);
                if (Number.isFinite(entryPrice) && entryPrice > 0) dailyStartBalance -= qty * entryPrice * (feeRate + SLIPPAGE_RATE);
              } else {
                const executionPrice = Number(event.executionPrice);
                if (!Number.isFinite(executionPrice) || executionPrice <= 0) continue;
                const gross = (position.side === "LONG" ? executionPrice - Number(position.entry) : Number(position.entry) - executionPrice) * qty;
                const liquidationFee = event.event === "LIQUIDATION" ? qty * executionPrice * DEFAULT_LIQUIDATION_FEE_RATE : 0;
                dailyStartBalance += gross - qty * executionPrice * feeRate - qty * executionPrice * SLIPPAGE_RATE - liquidationFee;
              }
            }
            for (const funding of position.fundingEvents ?? []) {
              const fundingAt = Number(funding.fundingTime);
              if (Number.isFinite(fundingAt) && fundingAt < utcDayStart) dailyStartBalance += Number(funding.pnlUsdt) || 0;
            }
          }
          dailyStartBalance = Number(dailyStartBalance.toFixed(8));
          latestLedger.dailyStartBalance = dailyStartBalance;
        }
        latestLedger.dailyPnl = Number((canonicalBalance - dailyStartBalance - todayCapitalDelta).toFixed(8));
        latestLedger.setups = ledger.setups;
        latestLedger.scannedSymbols = ledger.scannedSymbols;
        latestLedger.scanDiagnostics = ledger.scanDiagnostics;
        latestLedger.activitySnapshots = ledger.activitySnapshots;
        latestLedger.activityRanking = ledger.activityRanking;
        latestLedger.activityRankingBySymbol = ledger.activityRankingBySymbol;
        latestLedger.scanUniverseSize = ledger.scanUniverseSize;
        latestLedger.scanBatchSize = ledger.scanBatchSize;
        latestLedger.scanInvocationBatchSize = ledger.scanInvocationBatchSize;
        latestLedger.scanTelemetry = ledger.scanTelemetry;
        this.updateQuotaTelemetry(latestLedger);
        latestLedger.modelTelemetry = ledger.modelTelemetry;
        const mergedScanRotation = reconcileScanRotationProgress(
          latestLedger.scanRotation,
          ledger.scanRotation,
          universeSymbols,
          successfullyScannedSymbols,
          ledger.lastScanAt ?? (/* @__PURE__ */ new Date()).toISOString(),
          scanRotationGenerationAtStart
        );
        if (mergedScanRotation?.generation === scanRotationGenerationAtStart) {
          latestLedger.scanRotation = mergedScanRotation;
          latestLedger.cursor = ledger.cursor;
          latestLedger.scanLogicalBatchRemaining = ledger.scanLogicalBatchRemaining;
        }
        for (const resetFlag of ["strategyResetV2", "strategyResetV3", "strategyResetV4", "strategyResetV5", "strategyResetV6", "strategyResetV7", "sequentialBatchScanV1"]) {
          if (ledger[resetFlag] === true) latestLedger[resetFlag] = true;
        }
        latestLedger.lastScanAt = ledger.lastScanAt;
        latestEngine.lastScanAt = ledger.lastScanAt;
        latestEngine.lastScannedSymbol = engine.lastScannedSymbol;
        latestEngine.paperLedger = latestLedger;
        latestEngine.paperBalanceUsdt = latestLedger.balance;
        latestEngine.positions = latestLedger.positions;
        latestEngine.closedTrades = latestLedger.closedTrades;
        latestLedger.equity = Number((latestLedger.balance + latestLedger.positions.filter((p) => p.status === "OPEN").reduce((sum, p) => sum + Number(p.unrealizedPnlUsdt ?? 0), 0)).toFixed(8));
        await this.saveEngineState(latestEngine);
      }
      return Response.json({
        ok: true,
        mode: demoConfigured ? "bingx-demo" : "internal-paper",
        strategyMode: "SCALP_SWING_INDEPENDENT",
        strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
        newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
        paperTradingEnabled: !demoConfigured && this.env.PAPER_TRADING_ONLY === "true",
        demoTradingEnabled: demoConfigured && !!demoSnapshot,
        positionManagementEnabled: true,
        scannerPaused: SCANNER_PAUSED,
        positionManagementAt: new Date(positionManagementAt).toISOString(),
        scannedSymbols: batchSymbols.length,
        scanUniverseSize: universeSymbols.length,
        scanCursor: ledger.cursor,
        setups: generatedSetups.length,
        opened: demoConfigured ? vstOpened : paperOpened,
        pendingZoneEntries: demoConfigured ? demoPendingEntries.length : pendingEntryCount,
        executionRejected: generatedSetups.filter((x) => x.executionDecisionCode !== "OPENED" && x.executionDecisionCode !== "LIMIT_PENDING").length,
        openPositionsManaged: demoSnapshot?.positions.length ?? openPositionsAtStart.length,
        liquidationRiskGateActive,
        universeError,
        message: "Independent Scalp and Swing engines scan closed candles; eligible entries and all exits are executed and protected on BingX VST Demo only."
      });
    }
    if (request.method === "POST" && url.pathname === "/runner") {
      if (AUTOMATION_STOP) {
        await this.enforceEmergencyStop();
        return Response.json({
          ok: false,
          runnerEnabled: false,
          automationStopped: true,
          manualResumeRequired: true,
          error: "Emergency stop is active."
        }, { status: 503 });
      }
      const runnerOptions = await request.json().catch(() => ({}));
      const resetRotation = runnerOptions.resetScanRotation === true || url.searchParams.get("resetScanRotation") === "true";
      const engine = await this.readEngineState();
      engine.runnerEnabled = true;
      const ledger = engine.paperLedger ?? structuredClone(DEFAULT_STATE.paperLedger);
      ledger.runnerEnabled = true;
      if (resetRotation) {
        ledger.scanRotation = resetScanRotationProgress(ledger.scanRotation, (/* @__PURE__ */ new Date()).toISOString());
        ledger.turtleScanCursor = 0;
        ledger.setups = [];
        ledger.scannedSymbols = [];
        ledger.scanDiagnostics = [];
        ledger.scanUniverseSize = 0;
        ledger.scanBatchSize = 0;
        ledger.scanInvocationBatchSize = 0;
        ledger.scanLogicalBatchRemaining = 0;
        ledger.lastScanAt = null;
        ledger.scanTelemetry = void 0;
        ledger.activitySnapshots = {};
        ledger.activityRankingBySymbol = {};
        ledger.activityRanking = void 0;
        engine.lastScanAt = null;
        engine.lastScannedSymbol = null;
      }
      engine.paperLedger = ledger;
      await this.saveEngineState(engine);
      await this.writePaperState("runner-configured", "true");
      await this.writePaperState("paper-runner-explicitly-paused", "false");
      const alarmAt = Date.now() + 15e3;
      await this.state.storage.deleteAlarm();
      await this.setDurableAlarm(alarmAt);
      return Response.json({
        ok: true,
        runnerEnabled: true,
        mode: this.env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo",
        strategyMode: "SCALP_SWING_INDEPENDENT",
        strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
        newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
        paperTradingEnabled: this.env.BINGX_TRADING_MODE === "paper" && this.env.PAPER_TRADING_ONLY === "true",
        positionManagementEnabled: true,
        alarmScheduled: true,
        alarmAt,
        scanRotationReset: resetRotation,
        note: "Scalp and Swing engines run independently on BingX VST Demo; live-money order routing remains locked."
      });
    }
    return new Response("Not found", { status: 404 });
  }
  async processArchiveBatch() {
    const now = Date.now();
    const task = this.execSql(
      "SELECT symbol,last_fetch FROM archive_tasks WHERE status='active' AND next_due<=? ORDER BY next_due ASC LIMIT 1",
      now
    ).toArray()[0];
    if (!task) return false;
    if (!isEligibleUsdtPerpetualSymbol(task.symbol)) {
      this.execSql("UPDATE archive_tasks SET status='skipped',error='INELIGIBLE_NON_CRYPTO_SYMBOL' WHERE symbol=? AND status='active'", task.symbol);
      await this.writeStorage("history-archive-skipped-count", (await this.readStorage("history-archive-skipped-count") ?? 0) + 1);
      await this.writeStorage("history-archive-symbols-count", Math.max(0, (await this.readStorage("history-archive-symbols-count") ?? 0) - 1));
      if (task.last_fetch !== null) await this.writeStorage("history-archive-initialized-count", Math.max(0, (await this.readStorage("history-archive-initialized-count") ?? 0) - 1));
      const previousError = await this.readStorage("history-archive-last-error");
      if (previousError && typeof previousError === "object" && previousError.symbol === task.symbol) await this.writeStorage("history-archive-last-error", "");
      console.warn("Skipped ineligible legacy archive symbol without contacting BingX", task.symbol);
      return true;
    }
    const duration = 3e5;
    try {
      const params = new URLSearchParams({ symbol: task.symbol, interval: "5m", limit: String(task.last_fetch === null ? 240 : 1440) });
      if (task.last_fetch !== null) {
        params.set("startTime", String(task.last_fetch + duration));
        params.set("endTime", String(now));
      }
      const response = await fetch(`${BINGX}/openApi/swap/v3/quote/klines?${params}`, { headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" }, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!response.ok) throw new Error(`BingX HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || "Invalid archive candle response");
      const candles = payload.data.map(normalizeCandle).filter((c) => !!c && c.open != null && c.high != null && c.low != null && c.close != null && c.time + duration <= now).sort((a, b) => a.time - b.time);
      let inserted = 0;
      for (let offset = 0; offset < candles.length; offset += SQL_CANDLE_INSERT_CHUNK) {
        const chunk = candles.slice(offset, offset + SQL_CANDLE_INSERT_CHUNK);
        const values = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
        const args = [];
        for (const c of chunk) args.push(task.symbol, "5m", c.time, c.open, c.high, c.low, c.close, c.volume, JSON.stringify(c));
        inserted += this.execSql(
          `INSERT INTO candles(symbol,interval,open_time,open,high,low,close,volume,raw_json) VALUES ${values} ON CONFLICT(symbol,interval,open_time) DO NOTHING`,
          ...args
        ).rowsWritten;
      }
      const previous = task.last_fetch;
      const latest = candles[candles.length - 1]?.time ?? previous;
      const missing = previous !== null && latest !== null && latest > previous ? Math.max(0, Math.floor((latest - previous) / duration) - candles.length) : 0;
      this.execSql("UPDATE archive_tasks SET last_fetch=?,fetched=fetched+?,next_due=?,error=NULL WHERE symbol=?", latest, inserted, now + 6e4, task.symbol);
      await this.writeStorage("history-stored-candles-count", (await this.readStorage("history-stored-candles-count") ?? 0) + inserted);
      if (latest !== null) await this.writeStorage("history-latest-candle-time", Math.max(await this.readStorage("history-latest-candle-time") ?? 0, latest));
      await this.writeStorage("history-archive-missing-candles", (await this.readStorage("history-archive-missing-candles") ?? 0) + missing);
      if (previous === null) await this.writeStorage("history-archive-initialized-count", (await this.readStorage("history-archive-initialized-count") ?? 0) + 1);
      await this.writeStorage("history-archive-last-fetch", now);
      await this.writeStorage("history-archive-fetch-count", (await this.readStorage("history-archive-fetch-count") ?? 0) + 1);
      const priorArchiveError = await this.readStorage("history-archive-last-error");
      if (priorArchiveError && typeof priorArchiveError === "object" && priorArchiveError.symbol === task.symbol) {
        await this.writeStorage("history-archive-last-error", "");
      }
      console.info("Incremental archive batch committed", JSON.stringify({ symbol: task.symbol, insertedCandles: inserted, lastCandleTime: latest, missingCandles: missing }));
      return true;
    } catch (error) {
      const message = String(error).slice(0, 500);
      this.execSql("UPDATE archive_tasks SET next_due=?,error=? WHERE symbol=?", now + 3e5, message, task.symbol);
      await this.writeStorage("history-archive-last-error", { symbol: task.symbol, error: message, at: now });
      console.error("Incremental archive batch failed", { symbol: task.symbol, error: message });
      return false;
    }
  }
  queueHistoryTasks(tasks, now) {
    const eligibleTasks = tasks.filter((task) => isEligibleUsdtPerpetualSymbol(task.symbol));
    let inserted = 0;
    for (let offset = 0; offset < eligibleTasks.length; offset += SQL_HISTORY_TASK_INSERT_CHUNK) {
      const chunk = eligibleTasks.slice(offset, offset + SQL_HISTORY_TASK_INSERT_CHUNK);
      const values = chunk.map(() => "(?,?,?,?,NULL,0,'queued',0,NULL,?)").join(",");
      const args = [];
      for (const task of chunk) args.push(taskKey(task), task.symbol, task.interval, task.limit, now);
      inserted += this.execSql(
        `INSERT INTO history_tasks(id,symbol,interval,limit_count,cursor_time,attempts,status,fetched,error,updated_at) VALUES ${values} ON CONFLICT(id) DO NOTHING`,
        ...args
      ).rowsWritten;
    }
    return inserted;
  }
  queueArchiveSymbols(symbols, now, reactivate) {
    const eligibleSymbols = [...new Set(symbols.map((symbol) => String(symbol).toUpperCase()).filter(isEligibleUsdtPerpetualSymbol))];
    let inserted = 0;
    for (let offset = 0; offset < eligibleSymbols.length; offset += SQL_ARCHIVE_TASK_INSERT_CHUNK) {
      const chunk = eligibleSymbols.slice(offset, offset + SQL_ARCHIVE_TASK_INSERT_CHUNK);
      const values = chunk.map(() => "(?,?,'active')").join(",");
      const args = [];
      for (const symbol of chunk) args.push(symbol, now + Math.floor(Math.random() * 3e4));
      const conflict = reactivate ? "ON CONFLICT(symbol) DO UPDATE SET status='active',error=NULL" : "ON CONFLICT(symbol) DO NOTHING";
      inserted += this.execSql(
        `INSERT INTO archive_tasks(symbol,next_due,status) VALUES ${values} ${conflict}`,
        ...args
      ).rowsWritten;
    }
    return inserted;
  }
  async filterIneligibleArchiveSymbolsIfNeeded() {
    const version = await this.readStorage("archive-symbol-filter-v1") ?? 0;
    if (version >= 1) return;
    const activeRows = this.execSql(
      "SELECT symbol,last_fetch FROM archive_tasks WHERE status='active'"
    ).toArray();
    const invalid = activeRows.filter((row) => !isEligibleUsdtPerpetualSymbol(row.symbol));
    for (let offset = 0; offset < invalid.length; offset += SQL_ARCHIVE_TASK_INSERT_CHUNK) {
      const chunk = invalid.slice(offset, offset + SQL_ARCHIVE_TASK_INSERT_CHUNK);
      const placeholders = chunk.map(() => " ? ").join(",");
      this.execSql(
        "UPDATE archive_tasks SET status='skipped',error='INELIGIBLE_NON_CRYPTO_SYMBOL' WHERE status='active' AND symbol IN (" + placeholders + ")",
        ...chunk.map((row) => row.symbol)
      );
    }
    const eligibleRows = activeRows.filter((row) => isEligibleUsdtPerpetualSymbol(row.symbol));
    const previousSkipped = await this.readStorage("history-archive-skipped-count") ?? 0;
    await this.writeStorage("history-archive-symbols-count", eligibleRows.length);
    await this.writeStorage("history-archive-initialized-count", eligibleRows.filter((row) => row.last_fetch !== null).length);
    await this.writeStorage("history-archive-skipped-count", previousSkipped + invalid.length);
    const previousError = await this.readStorage("history-archive-last-error");
    if (previousError && typeof previousError === "object" && invalid.some((row) => row.symbol === previousError.symbol))
      await this.writeStorage("history-archive-last-error", "");
    await this.writeStorage("archive-symbol-filter-v1", 1);
    if (invalid.length) console.info("Filtered legacy non-crypto archive symbols without deleting stored candles", JSON.stringify({ skipped: invalid.length, eligible: eligibleRows.length }));
  }
  async processHistoryBatch() {
    const task = this.execSql(
      "SELECT id,symbol,interval,limit_count,cursor_time,attempts FROM history_tasks WHERE status='queued' ORDER BY updated_at ASC LIMIT 1"
    ).toArray()[0];
    if (!task) {
      await this.writeStorage("history-processing-enabled", false);
      return;
    }
    const now = Date.now();
    if (!isEligibleUsdtPerpetualSymbol(task.symbol)) {
      this.execSql("UPDATE history_tasks SET status='failed',error='INELIGIBLE_NON_CRYPTO_SYMBOL',updated_at=? WHERE id=?", now, task.id);
      const summary = await this.readStorage("history-task-summary");
      if (summary) await this.writeStorage("history-task-summary", { ...summary, pending: Math.max(0, summary.pending - 1), failed: summary.failed + 1 });
      console.warn("Skipped ineligible legacy historical task without contacting BingX", JSON.stringify({ id: task.id, symbol: task.symbol }));
      return;
    }
    try {
      const params = new URLSearchParams({ symbol: task.symbol, interval: task.interval, limit: String(Math.min(240, task.limit_count)) });
      if (task.cursor_time !== null) params.set("endTime", String(task.cursor_time));
      const response = await fetch(`${BINGX}/openApi/swap/v3/quote/klines?${params}`, { headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" }, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!response.ok) throw new Error(`BingX HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || "Invalid historical candle response");
      const duration = intervalMs(task.interval);
      const candles = payload.data.map(normalizeCandle).filter((c) => !!c && c.open != null && c.high != null && c.low != null && c.close != null && c.time + duration <= now).sort((a, b) => a.time - b.time);
      if (!candles.length) {
        this.execSql("UPDATE history_tasks SET status='done',error=NULL,updated_at=? WHERE id=?", now, task.id);
        const summary = await this.readStorage("history-task-summary");
        if (summary) await this.writeStorage("history-task-summary", { ...summary, done: summary.done + 1, pending: Math.max(0, summary.pending - 1) });
      } else {
        let inserted = 0;
        for (let offset = 0; offset < candles.length; offset += SQL_CANDLE_INSERT_CHUNK) {
          const chunk = candles.slice(offset, offset + SQL_CANDLE_INSERT_CHUNK);
          const values = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
          const args = [];
          for (const c of chunk) args.push(task.symbol, task.interval, c.time, c.open, c.high, c.low, c.close, c.volume, JSON.stringify(c));
          const result = this.execSql(
            `INSERT INTO candles(symbol,interval,open_time,open,high,low,close,volume,raw_json) VALUES ${values} ON CONFLICT(symbol,interval,open_time) DO NOTHING`,
            ...args
          );
          inserted += result.rowsWritten;
        }
        const nextCursor = candles[0].time - 1;
        if (task.cursor_time !== null && nextCursor >= task.cursor_time) {
          this.execSql("UPDATE history_tasks SET status='failed',attempts=attempts+1,error='Historical cursor did not advance',updated_at=? WHERE id=?", now, task.id);
        } else {
          this.execSql("UPDATE history_tasks SET cursor_time=?,attempts=0,status='queued',error=NULL,updated_at=? WHERE id=?", nextCursor, now, task.id);
        }
        await this.writeStorage("history-stored-candles-count", (await this.readStorage("history-stored-candles-count") ?? 0) + inserted);
        await this.writeStorage("history-latest-candle-time", Math.max(await this.readStorage("history-latest-candle-time") ?? 0, candles[candles.length - 1].time));
        const symbolKey = `history-symbol-counted:${task.symbol}`;
        if (await this.readStorage(symbolKey) !== true) {
          await this.writeStorage(symbolKey, true);
          await this.writeStorage("history-candle-symbols-count", (await this.readStorage("history-candle-symbols-count") ?? 0) + 1);
        }
      }
      await this.writeStorage("history-archive-last-fetch", now);
      await this.writeStorage("history-archive-fetch-count", (await this.readStorage("history-archive-fetch-count") ?? 0) + 1);
    } catch (error) {
      const attempts = task.attempts + 1, failed = attempts >= 5;
      this.execSql("UPDATE history_tasks SET attempts=?,status=?,error=?,updated_at=? WHERE id=?", attempts, failed ? "failed" : "queued", String(error).slice(0, 500), now, task.id);
      const summary = await this.readStorage("history-task-summary");
      if (summary && failed) await this.writeStorage("history-task-summary", { ...summary, pending: Math.max(0, summary.pending - 1), failed: summary.failed + 1 });
      console.error("Incremental history batch failed", { id: task.id, attempts, error: String(error) });
    }
  }
  async alarm(isLegacyRuntime = true) {
    if (isLegacyRuntime) { try { await this.deleteDurableAlarm(); } catch (error) { console.error("Legacy EngineState alarm disable failed", String(error)); } console.warn("Legacy EngineState alarm disabled; EngineStateV2 is the canonical paper runner."); return; }
    if (AUTOMATION_STOP) { try { await this.enforceEmergencyStop(); } catch (error) { console.error("Emergency alarm shutdown could not persist all state", String(error)); } return; }
    let engine;
    try { engine = await this.readEngineState(); } catch (error) { console.error("Paper alarm deferred because state is unavailable", String(error)); await this.setDurableAlarm(Date.now() + 3e4); return; }
    if (!engine.runnerEnabled) return;
    let nextDelay = PAPER_SCAN_INTERVAL_MS;
    try { const response = await this.fetch(new Request("https://engine.internal/paper/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })); if (!response.ok) nextDelay = 3e4; else { const scanResult = await response.json().catch(() => ({ logicalBatchRemaining: 0 })); if (Number(scanResult.logicalBatchRemaining) > 0) nextDelay = 5e3; } }
    catch (error) { console.error("Paper scan failed", String(error)); nextDelay = 3e4; }
    await this.setDurableAlarm(Date.now() + nextDelay);
  }
};
var marketDataStats = { upstreamRequests: 0, cacheHits: 0, inFlightDedupHits: 0, failures: 0, lastFailure: null, lastFailureAt: 0 };
var marketCandleCache = /* @__PURE__ */ new Map();
var marketCandleInFlight = /* @__PURE__ */ new Map();
var marketDataFailureByKey = /* @__PURE__ */ new Map();
function recordMarketDataFailure(key, reason) {
  marketDataFailureByKey.set(key, reason);
  marketDataStats.lastFailureAt = Date.now();
  while (marketDataFailureByKey.size > 1200) marketDataFailureByKey.delete(marketDataFailureByKey.keys().next().value);
}
__name(recordMarketDataFailure, "recordMarketDataFailure");
var marketDataNextRequestAt = 0;
var marketDataCooldownUntil = 0;
var marketDataRequestLock = Promise.resolve();
async function waitForMarketDataRequestSlot() {
  let release;
  const previous = marketDataRequestLock;
  marketDataRequestLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const waitUntil = Math.max(marketDataNextRequestAt, marketDataCooldownUntil);
  const waitMs = Math.max(0, waitUntil - Date.now());
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  marketDataNextRequestAt = Date.now() + MARKET_DATA_REQUEST_SPACING_MS;
  release();
}
__name(waitForMarketDataRequestSlot, "waitForMarketDataRequestSlot");
function candleCacheTtl(latestClosedCandleOpenTime, durationMs, now = Date.now()) {
  return resolveClosedCandleCacheTtlMs(latestClosedCandleOpenTime, durationMs, now);
}
__name(candleCacheTtl, "candleCacheTtl");
async function fetchMarketCandles(symbol, interval, limit, durationMs) {
  const key = `${symbol}|${interval}|${limit}`;
  const now = Date.now();
  const cached = marketCandleCache.get(key);
  if (cached && cached.expiresAt > now) {
    marketDataFailureByKey.delete(key);
    marketDataStats.cacheHits++;
    return cached.candles;
  }
  const pending = marketCandleInFlight.get(key);
  if (pending) {
    marketDataStats.inFlightDedupHits++;
    return pending.then((candles) => {
      if (candles.length) marketDataFailureByKey.delete(key);
      return candles;
    });
  }
  const request = (async () => {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    let payload = null;
    for (let attempt = 0; attempt < MARKET_DATA_MAX_ATTEMPTS; attempt++) {
      await waitForMarketDataRequestSlot();
      marketDataStats.upstreamRequests++;
      let response;
      try {
        response = await fetch(BINGX + "/openApi/swap/v3/quote/klines?" + params, { headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" }, signal: AbortSignal.timeout(MARKET_DATA_REQUEST_TIMEOUT_MS), cf: { cacheTtl: attempt === 0 ? interval === "5m" ? 90 : interval === "15m" ? 180 : interval === "1h" ? 600 : interval === "2h" ? 900 : interval === "4h" ? 1800 : 3600 : 0, cacheEverything: attempt === 0 } });
      } catch (error) {
        if (attempt + 1 < MARKET_DATA_MAX_ATTEMPTS && isRetryableMarketDataFailure(void 0, void 0, true)) {
          await new Promise((resolve) => setTimeout(resolve, marketDataRetryDelayMs(attempt)));
          continue;
        }
        marketDataStats.failures++;
        marketDataStats.lastFailure = `${symbol} ${interval}: network error ${String(error).slice(0, 180)}`;
        recordMarketDataFailure(key, marketDataStats.lastFailure);
        throw error;
      }
      if (!response.ok) {
        if (attempt + 1 < MARKET_DATA_MAX_ATTEMPTS && isRetryableMarketDataFailure(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, marketDataRetryDelayMs(attempt)));
          continue;
        }
        marketDataStats.failures++;
        marketDataStats.lastFailure = `${symbol} ${interval}: HTTP ${response.status}`;
        recordMarketDataFailure(key, marketDataStats.lastFailure);
        return [];
      }
      try {
        payload = await response.json();
      } catch (error) {
        if (attempt + 1 < MARKET_DATA_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, marketDataRetryDelayMs(attempt)));
          continue;
        }
        marketDataStats.failures++;
        marketDataStats.lastFailure = `${symbol} ${interval}: invalid JSON response ${String(error).slice(0, 120)}`;
        recordMarketDataFailure(key, marketDataStats.lastFailure);
        return [];
      }
      if (payload.code === 0 && Array.isArray(payload.data)) break;
      if (Number(payload.code) === 100410) marketDataCooldownUntil = Math.max(marketDataCooldownUntil, Date.now() + 5e3);
      if (attempt + 1 < MARKET_DATA_MAX_ATTEMPTS && isRetryableMarketDataFailure(void 0, Number(payload.code))) {
        await new Promise((resolve) => setTimeout(resolve, marketDataRetryDelayMs(attempt)));
        continue;
      }
      marketDataStats.failures++;
      marketDataStats.lastFailure = `${symbol} ${interval}: invalid BingX payload code=${String(payload.code)} message=${String(payload.msg ?? "").slice(0, 120)}`;
      recordMarketDataFailure(key, marketDataStats.lastFailure);
      return [];
    }
    if (!payload || payload.code !== 0 || !Array.isArray(payload.data)) {
      marketDataStats.failures++;
      marketDataStats.lastFailure = `${symbol} ${interval}: invalid BingX payload after retry`;
      recordMarketDataFailure(key, marketDataStats.lastFailure);
      return [];
    }
    const candles = payload.data.map(normalizeCandle).filter((x) => !!x && x.open != null && x.high != null && x.low != null && x.close != null).map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? void 0, quoteVolume: x.quoteVolume ?? void 0, takerBuyVolume: x.takerBuyVolume ?? void 0, takerBuyQuoteVolume: x.takerBuyQuoteVolume ?? void 0 })).filter((x) => x.time + durationMs <= Date.now()).sort((a, b) => a.time - b.time);
    const latest = candles[candles.length - 1];
    if (!latest || Date.now() - (latest.time + durationMs) > durationMs * 3) {
      marketDataStats.failures++;
      const ageMs = latest ? Date.now() - (latest.time + durationMs) : null;
      marketDataStats.lastFailure = `${symbol} ${interval}: ${latest ? "stale latest closed candle" : "no closed candles"}; ageMs=${ageMs}`;
      recordMarketDataFailure(key, marketDataStats.lastFailure);
      return [];
    }
    marketDataFailureByKey.delete(key);
    marketCandleCache.set(key, { expiresAt: Date.now() + candleCacheTtl(latest.time, durationMs), candles });
    if (marketCandleCache.size > 300) {
      for (const [cacheKey, value] of marketCandleCache) if (value.expiresAt <= Date.now()) marketCandleCache.delete(cacheKey);
      while (marketCandleCache.size > 300) marketCandleCache.delete(marketCandleCache.keys().next().value);
    }
    return candles;
  })();
  marketCandleInFlight.set(key, request);
  try {
    return await request;
  } finally {
    marketCandleInFlight.delete(key);
  }
}
__name(fetchMarketCandles, "fetchMarketCandles");
var headers = { "cache-control": "no-store" };
var BINGX = "https://open-api.bingx.com";
var DOMINANCE_HISTORY_KEY = "market-dominance-history-v1";
function dominanceDateKey(value) {
  const n = typeof value === "string" && !/^\\d+$/.test(value) ? Date.parse(value) : Number(value);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n < 1e12 ? n * 1e3 : n);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
__name(dominanceDateKey, "dominanceDateKey");
function dominanceNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  if (value && typeof value === "object") {
    const row = value;
    for (const key of ["peggedUSD", "USD", "usd", "totalCirculatingUSD", "marketCap", "value"]) {
      const n = dominanceNumber(row[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    for (const nested of Object.values(row)) {
      const n = dominanceNumber(nested);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return NaN;
}
__name(dominanceNumber, "dominanceNumber");
async function dominanceJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12e3), cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + new URL(url).host);
  return response.json();
}
__name(dominanceJson, "dominanceJson");
async function fetchHistoricalDominance30d() {
  const [btcResponse, totalResponse, stablecoins] = await Promise.all([
    dominanceJson("https://api.bitcompare.net/api/v1/global-stats/metrics/history/btc_dominance?period=30d"),
    dominanceJson("https://api.bitcompare.net/api/v1/global-stats/metrics/history/total_market_cap?period=30d"),
    dominanceJson("https://stablecoins.llama.fi/stablecoins?includePrices=true")
  ]);
  const usdt = (stablecoins?.peggedAssets ?? []).find((row) => String(row.symbol).toUpperCase() === "USDT");
  if (!usdt?.id) throw new Error("DeFiLlama USDT stablecoin ID not found");
  const usdtResponse = await dominanceJson("https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=" + encodeURIComponent(String(usdt.id)));
  const rows = /* @__PURE__ */ __name((response) => response?.data?.history ?? response?.data?.ohlc ?? response?.history ?? response?.ohlc ?? [], "rows");
  const toMap = /* @__PURE__ */ __name((items, keys) => {
    const map = /* @__PURE__ */ new Map();
    for (const row of items) {
      const date = dominanceDateKey(row.timestamp ?? row.date ?? row.t);
      let value = NaN;
      for (const key of keys) {
        value = dominanceNumber(row[key]);
        if (Number.isFinite(value) && value > 0) break;
      }
      if (date && Number.isFinite(value) && value > 0) map.set(date, value);
    }
    return map;
  }, "toMap");
  const btc = toMap(rows(btcResponse), ["value", "close", "avg", "btc_dominance", "btcDominance"]);
  const total = toMap(rows(totalResponse), ["value", "close", "avg", "total_market_cap", "totalMarketCap"]);
  const usdtRows = Array.isArray(usdtResponse) ? usdtResponse : usdtResponse?.data ?? [];
  const usdtCaps = toMap(usdtRows, ["totalCirculating", "totalCirculatingUSD", "marketCap"]);
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const earliest = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
  const dates = [...btc.keys()].filter((date) => date >= earliest && date <= today && total.has(date) && usdtCaps.has(date)).sort();
  const points = dates.map((date) => {
    const totalCap = total.get(date), rawBtc = btc.get(date), btcPct = rawBtc <= 1 ? rawBtc * 100 : rawBtc, usdtCap = usdtCaps.get(date);
    const usdtPct = usdtCap / totalCap * 100, altPct = 100 - btcPct - usdtPct;
    return { date, btcDomPct: +btcPct.toFixed(6), usdtDomPct: +usdtPct.toFixed(6), altDomPct: +altPct.toFixed(6), totalMarketCapUsd: totalCap, usdtMarketCapUsd: usdtCap, source: "Bitcompare + DeFiLlama" };
  }).filter((row) => row.btcDomPct > 0 && row.usdtDomPct > 0 && row.altDomPct > 0 && row.altDomPct < 100);
  if (points.length < 25) throw new Error("Only " + points.length + " aligned daily samples; 25 required for a 30-day history");
  return points;
}
__name(fetchHistoricalDominance30d, "fetchHistoricalDominance30d");
async function fetchGlobalDominanceSnapshot(env) {
  const measuredAt = (/* @__PURE__ */ new Date()).toISOString(), today = measuredAt.slice(0, 10);
  let btc = null, usdt = null, stablecoin = null, totalMarketCapUsd = null, totalVolumeUsd = null, marketCapChange24hPct = null, error;
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(7e3),
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) throw new Error("CoinGecko global endpoint HTTP " + response.status);
    const payload = await response.json();
    const data = payload.data, percentages = data?.market_cap_percentage ?? {};
    const value = /* @__PURE__ */ __name((key) => Number.isFinite(Number(percentages[key])) ? Number(percentages[key]) : null, "value");
    btc = value("btc");
    usdt = value("usdt");
    const stableKeys = ["usdt", "usdc", "dai", "busd", "tusd", "fdusd", "usde", "usds", "usdd", "usdp", "pyusd", "frax", "lusd", "crvusd"];
    const stableValues = stableKeys.map(value).filter((x) => x !== null);
    stablecoin = stableValues.length ? stableValues.reduce((sum, x) => sum + x, 0) : null;
    const numeric = /* @__PURE__ */ __name((v) => Number.isFinite(Number(v)) ? Number(v) : null, "numeric");
    totalMarketCapUsd = numeric(data?.total_market_cap?.usd);
    totalVolumeUsd = numeric(data?.total_volume?.usd);
    marketCapChange24hPct = numeric(data?.market_cap_change_percentage_24h_usd);
  } catch (fetchError) {
    error = String(fetchError).slice(0, 180);
  }
  let stored = null;
  try {
    stored = await env.PAPER_STATE.get(DOMINANCE_HISTORY_KEY, "json");
  } catch (storageError) {
    console.error("Dominance history read failed", String(storageError));
  }
  let points = Array.isArray(stored?.points) ? stored.points : [];
  let lastLiveCollectionDate = stored?.lastLiveCollectionDate ?? null;
  let lastBackfillAttemptDate = stored?.lastBackfillAttemptDate ?? null;
  let historySource = stored?.source ?? null, changed = false;
  if (points.length < 25 && lastBackfillAttemptDate !== today) {
    lastBackfillAttemptDate = today;
    try {
      const backfill = await fetchHistoricalDominance30d();
      points = backfill;
      historySource = "Bitcompare BTC.D + total market cap; DeFiLlama USDT market cap";
      changed = true;
    } catch (backfillError) {
      console.error("30-day dominance backfill unavailable", String(backfillError).slice(0, 220));
      if (!error) error = "30-day history unavailable: " + String(backfillError).slice(0, 140);
      changed = true;
    }
  }
  const altcoin = btc !== null && usdt !== null ? Math.max(0, 100 - btc - usdt) : null;
  if (btc !== null && usdt !== null && altcoin !== null && lastLiveCollectionDate !== today) {
    const livePoint = { date: today, btcDomPct: +btc.toFixed(6), usdtDomPct: +usdt.toFixed(6), altDomPct: +altcoin.toFixed(6), ...totalMarketCapUsd !== null ? { totalMarketCapUsd } : {}, source: "CoinGecko Global API" };
    points = [...points.filter((row) => row.date !== today), livePoint].sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
    lastLiveCollectionDate = today;
    historySource = historySource ?? "Daily CoinGecko live snapshots";
    changed = true;
  }
  if (changed) {
    try {
      await env.PAPER_STATE.put(DOMINANCE_HISTORY_KEY, JSON.stringify({ points, lastLiveCollectionDate, lastBackfillAttemptDate, source: historySource ?? "unavailable", updatedAt: measuredAt }));
    } catch (storageError) {
      console.error("Dominance history persistence failed", String(storageError));
    }
  }
  const history = points.slice(-90);
  return {
    btc,
    usdt,
    altcoin,
    stablecoin,
    totalMarketCapUsd,
    totalVolumeUsd,
    marketCapChange24hPct,
    measuredAt,
    source: "CoinGecko Global API",
    available: btc !== null && usdt !== null,
    ...error ? { error } : {},
    history,
    historyCoverageDays: history.length,
    historyStartDate: history[0]?.date ?? null,
    historyEndDate: history.at(-1)?.date ?? null,
    historySource
  };
}
__name(fetchGlobalDominanceSnapshot, "fetchGlobalDominanceSnapshot");
async function collectDailyDominanceHistory(env) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  try {
    const stored = await env.PAPER_STATE.get(DOMINANCE_HISTORY_KEY, "json");
    if (stored?.lastLiveCollectionDate === today && stored.points?.length >= 25)
      return { ok: true, skipped: true, reason: "today-already-collected", historyCoverageDays: stored.points.length };
    if (stored?.lastBackfillAttemptDate === today && stored.lastLiveCollectionDate !== today)
      return { ok: false, skipped: true, reason: "today-backfill-already-attempted", historyCoverageDays: stored.points?.length ?? 0 };
  } catch (error) {
    console.error("Scheduled dominance history preflight failed", String(error));
  }
  const snapshot = await fetchGlobalDominanceSnapshot(env);
  return { ok: snapshot.available, available: snapshot.available, historyCoverageDays: snapshot.historyCoverageDays, historyStartDate: snapshot.historyStartDate, historyEndDate: snapshot.historyEndDate, historySource: snapshot.historySource, error: snapshot.error ?? null };
}
__name(collectDailyDominanceHistory, "collectDailyDominanceHistory");
async function getBingXMarkPrices(symbols, timeoutMs = 7e3) {
  const wanted = new Set(symbols.map((s) => String(s).toUpperCase()));
  const marks = {};
  if (!wanted.size) return marks;
  try {
    const response = await fetch(BINGX + "/openApi/swap/v2/quote/premiumIndex", {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (response.ok) {
      const payload = await response.json();
      if (payload.code === 0 && payload.data) {
        const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
        for (const row of rows) {
          const symbol = String(row.symbol ?? row.s ?? "").toUpperCase();
          const mark = Number(row.markPrice);
          const fundingRate = Number(row.lastFundingRate);
          const nextFundingTime = Number(row.nextFundingTime);
          const updateTime = Number(row.updateTime);
          const fundingIntervalHours = Number(row.fundingIntervalHours);
          if (symbol && Number.isFinite(fundingRate) && Number.isFinite(nextFundingTime) && nextFundingTime > 0) latestFundingSnapshots.set(symbol, { rate: fundingRate, nextFundingTime, updateTime: Number.isFinite(updateTime) ? updateTime : Date.now(), fundingIntervalHours: Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0 ? fundingIntervalHours : 8, fetchedAt: Date.now() });
          if (wanted.has(symbol) && Number.isFinite(mark) && mark > 0) marks[symbol] = mark;
        }
      }
    }
  } catch {
  }
  const missing = [...wanted].filter((symbol) => !Number.isFinite(marks[symbol]) || marks[symbol] <= 0);
  if (missing.length > 0 && missing.length <= 5) {
    await Promise.all(missing.map(async (symbol) => {
      const mark = await getBingXMarkPrice(symbol, timeoutMs);
      if (mark !== null) marks[symbol] = mark;
    }));
  } else if (missing.length > 5) {
    console.warn("BingX bulk mark snapshot incomplete; per-symbol fallback skipped to stay within subrequest budget", missing.length);
  }
  return marks;
}
__name(getBingXMarkPrices, "getBingXMarkPrices");
async function getBingXMarkPrice(symbol, timeoutMs = 4500) {
  try {
    const response = await fetch(BINGX + "/openApi/swap/v2/quote/premiumIndex?symbol=" + encodeURIComponent(symbol), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload.code !== 0) return null;
    const quote = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    const mark = Number(quote?.markPrice);
    const fundingRate = Number(quote?.lastFundingRate), nextFundingTime = Number(quote?.nextFundingTime), updateTime = Number(quote?.updateTime), fundingIntervalHours = Number(quote?.fundingIntervalHours);
    if (Number.isFinite(fundingRate) && Number.isFinite(nextFundingTime) && nextFundingTime > 0) latestFundingSnapshots.set(String(quote?.symbol ?? symbol).toUpperCase(), { rate: fundingRate, nextFundingTime, updateTime: Number.isFinite(updateTime) ? updateTime : Date.now(), fundingIntervalHours: Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0 ? fundingIntervalHours : 8, fetchedAt: Date.now() });
    return Number.isFinite(mark) && mark > 0 ? mark : null;
  } catch {
    return null;
  }
}
__name(getBingXMarkPrice, "getBingXMarkPrice");
var PAPER_SCAN_BATCH_NORMAL = 25;
var PAPER_SCAN_INTERVAL_MS = 6e4;
var latestFundingSnapshots = new Map();
var VST_ENTRY_QUEUE_MAX = 1e3;
var ACTIVE_VST_STRATEGY_MODELS = ACTIVE_SWING_MODEL_SET;
var AUTOMATION_STOP = false;
var SCANNER_PAUSED = false;
var NEW_PAPER_ENTRIES_ENABLED = true;
var STRATEGY_GENERATION_ENABLED = true;
var ALLOWED_INTERVALS = /* @__PURE__ */ new Set(["5m", "15m", "1h", "2h", "4h", "1d"]);
var CLOUDFLARE_ACCOUNT_ID_DEFAULT = "6c6a20118103a6c9f25edd5d6541f00b";
async function edgeCachedGet(request, ttlSeconds, loader) {
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  try {
    const hit2 = await caches.default.match(key);
    if (hit2) return hit2;
  } catch {
  }
  const response = await loader();
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("cache-control", `public, max-age=${ttlSeconds}`);
  const responseWithCache = new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  if (response.status === 200) {
    try {
      await caches.default.put(key, responseWithCache.clone());
    } catch {
    }
  }
  return responseWithCache;
}
__name(edgeCachedGet, "edgeCachedGet");
function degradedPaperSnapshot(message, notice, retryRaw) {
  let retryAfter = null;
  try {
    const saved = retryRaw ? JSON.parse(retryRaw) : null;
    if (typeof saved?.retryAfter === "number" && Number.isFinite(saved.retryAfter)) retryAfter = saved.retryAfter;
  } catch {
  }
  return Response.json({
    ok: true,
    mode: "bingx-demo",
    storageDegraded: true,
    balance: null,
    equity: null,
    positions: [],
    closedTrades: [],
    setups: [],
    scannedSymbols: [],
    lastScanAt: null,
    runnerEnabled: false,
    stateRecoveryNotice: notice,
    recoveryRetryAfter: retryAfter,
    message,
    dashboardSource: "kv-snapshot"
  }, { headers: { ...headers, "x-dashboard-source": "kv-snapshot" } });
}
__name(degradedPaperSnapshot, "degradedPaperSnapshot");
var EXTERNAL_PAPER_STATE_KEYS = /* @__PURE__ */ new Set(["engine-state", "bingx-demo-position-meta", "bingx-demo-executed-setup-keys", "bingx-demo-pending-limit-entries", "bingx-demo-protection-health-v1", "state-recovery-notice", "state-recovery-retry", "paper-runner-explicitly-paused", "runner-configured", "bingx-vst-closed-trades-v1", "bingx-vst-closed-strategy-meta-v1", "bingx-demo-order-history-v1"]);
async function readEnginePaperState(env, key) {
  if (!EXTERNAL_PAPER_STATE_KEYS.has(key)) throw new Error("Paper-state key is not available through the Durable Object state bridge.");
  const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
  const response = await stub.fetch(new Request("https://engine.internal/paper/state?key=" + encodeURIComponent(key)));
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "Durable Object paper-state read failed.");
  return payload.value ?? null;
}
__name(readEnginePaperState, "readEnginePaperState");
async function writeEnginePaperState(env, key, value) {
  if (!EXTERNAL_PAPER_STATE_KEYS.has(key)) throw new Error("Paper-state key is not available through the Durable Object state bridge.");
  const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
  const response = await stub.fetch(new Request("https://engine.internal/paper/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) }));
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? "Durable Object paper-state write failed.");
}
__name(writeEnginePaperState, "writeEnginePaperState");
async function dashboardLivePositionPnl(env) {
  try {
    const [notice, engine, explicitPause] = await Promise.all([
      readEnginePaperState(env, "state-recovery-notice"),
      readEnginePaperState(env, "engine-state"),
      readEnginePaperState(env, "paper-runner-explicitly-paused")
    ]);
    if (notice || !engine?.paperLedger || typeof engine.paperLedger.balance !== "number") {
      return Response.json({ ok: false, storageDegraded: true, error: "Verified paper ledger is unavailable." }, { status: 503, headers });
    }
    const ledger = engine.paperLedger;
    const positions = (ledger.positions ?? []).filter((p) => p.status === "OPEN").map((position) => {
      const stored = position;
      const candidate = Number(stored.markPrice ?? stored.lastMarkPrice);
      const markPrice = Number.isFinite(candidate) && candidate > 0 ? candidate : null;
      const unrealizedPnlUsdt = stored.unrealizedPnlUsdt != null && Number.isFinite(Number(stored.unrealizedPnlUsdt)) ? Number(stored.unrealizedPnlUsdt) : null;
      return {
        ...position,
        markPrice,
        currentPrice: markPrice,
        unrealizedPnlUsdt,
        livePriceAvailable: markPrice !== null,
        livePriceAt: stored.markPriceAt ?? stored.livePriceAt ?? engine.lastScanAt ?? null
      };
    });
    const liveUnrealized = positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealizedPnlUsdt) ? Number(p.unrealizedPnlUsdt) : 0), 0);
    return Response.json({
      ok: true,
      mode: env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo",
      manualPause: explicitPause === "true",
      balance: ledger.balance,
      equity: Number((ledger.balance + liveUnrealized).toFixed(4)),
      positions,
      runnerEnabled: AUTOMATION_STOP ? false : engine.runnerEnabled,
      livePnlUpdatedAt: engine.lastScanAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      storageDegraded: false,
      dashboardSource: "kv-live-pnl-snapshot"
    }, { headers: { ...headers, "cache-control": "no-store" } });
  } catch (error) {
    console.error("Dashboard live PnL snapshot failed", String(error).slice(0, 180));
    return Response.json({ ok: false, storageDegraded: true, error: "Live position PnL is temporarily unavailable." }, { status: 503, headers });
  }
}
__name(dashboardLivePositionPnl, "dashboardLivePositionPnl");
async function readDemoPaperStatus(env) {
  try {
    const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
    const response = await stub.fetch(new Request("https://engine.internal/paper/status"));
    const status = await response.json();
    return { status: response.ok ? status : null, storageDegraded: !response.ok || status.storageDegraded === true };
  } catch {
    return { status: null, storageDegraded: true };
  }
}
__name(readDemoPaperStatus, "readDemoPaperStatus");
var bingxOrderHistoryMemoryCache = null;
var bingxClosedFillMemoryCache = null;
async function getCachedBingXDemoOrderHistory(env) {
  const key = "bingx-demo-order-history-v1", now = Date.now();
  if (bingxOrderHistoryMemoryCache && now - bingxOrderHistoryMemoryCache.fetchedAt < 60 * 60 * 1e3) return bingxOrderHistoryMemoryCache.orders;
  let stale = null;
  try {
    const cachedRaw = await readEnginePaperState(env, key);
    const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
    if (cached && Array.isArray(cached.orders)) {
      stale = cached;
      if (now - cached.fetchedAt < 60 * 60 * 1e3) {
        bingxOrderHistoryMemoryCache = cached;
        return cached.orders;
      }
    }
  } catch {
  }
  try {
    const freshOrders = await getBingXDemoOrderHistory(env.BINGX_API_KEY, env.BINGX_API_SECRET);
    const orders = mergeBingXOrderHistorySnapshots(stale?.orders ?? [], freshOrders);
    const value = { fetchedAt: now, orders };
    bingxOrderHistoryMemoryCache = value;
    try {
      await writeEnginePaperState(env, key, JSON.stringify(value));
    } catch (error) {
      console.warn("BingX VST order-history cache write failed", String(error).slice(0, 160));
    }
    return orders;
  } catch (error) {
    const fallback = bingxOrderHistoryMemoryCache ?? stale;
    if (fallback) {
      console.warn("BingX VST order-history refresh failed; using cached history", String(error).slice(0, 160));
      return fallback.orders;
    }
    throw error;
  }
}
__name(getCachedBingXDemoOrderHistory, "getCachedBingXDemoOrderHistory");
async function getCachedBingXDemoClosedFills(env) {
  const now = Date.now();
  if (bingxClosedFillMemoryCache && now - bingxClosedFillMemoryCache.fetchedAt < 5 * 60 * 1e3) return bingxClosedFillMemoryCache.fills;
  try {
    const fills = await getBingXDemoClosedFills(env.BINGX_API_KEY, env.BINGX_API_SECRET);
    bingxClosedFillMemoryCache = { fetchedAt: now, fills };
    return fills;
  } catch (error) {
    if (bingxClosedFillMemoryCache) {
      console.warn("BingX VST fill-history refresh failed; using cached fills", String(error).slice(0, 160));
      return bingxClosedFillMemoryCache.fills;
    }
    throw error;
  }
}
__name(getCachedBingXDemoClosedFills, "getCachedBingXDemoClosedFills");
async function archiveBingXDemoClosedStrategyMetadata(env, closedMetadata) {
  if (!closedMetadata.length) return;
  const key = "bingx-vst-closed-strategy-meta-v1";
  let stored = [];
  try {
    const raw = await readEnginePaperState(env, key);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) stored = parsed;
  } catch (error) {
    console.warn("BingX VST strategy metadata archive read failed", String(error).slice(0, 140));
  }
  const bySetupKey = /* @__PURE__ */ new Map();
  for (const item of stored) if (item && item.setupKey) bySetupKey.set(String(item.setupKey), item);
  for (const item of closedMetadata) if (item && item.setupKey) bySetupKey.set(String(item.setupKey), { ...item, closedAt: Number(item.closedAt) || Date.now() });
  const archive = [...bySetupKey.values()].sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0)).slice(0, 3e3);
  await writeEnginePaperState(env, key, JSON.stringify(archive));
}
__name(archiveBingXDemoClosedStrategyMetadata, "archiveBingXDemoClosedStrategyMetadata");
async function persistBingXDemoClosedTrades(env, freshTrades) {
  const key = "bingx-vst-closed-trades-v1";
  let stored = [];
  try {
    const raw = await readEnginePaperState(env, key);
    const value = raw ? JSON.parse(raw) : null;
    if (Array.isArray(value)) stored = value;
  } catch (error) {
    console.warn("BingX VST closed-trade history read failed", String(error).slice(0, 160));
  }
  const byId = /* @__PURE__ */ new Map();
  for (const trade of stored) if (trade && trade.id) byId.set(String(trade.id), trade);
  for (const trade of freshTrades) if (trade && trade.id && ["BINGX_VST_ALL_FILL_ORDERS", "BINGX_VST_ORDER_HISTORY_FALLBACK"].includes(String(trade.source)) && ["TP", "SL", "MANUAL_CLOSE", "LIQUIDATION"].includes(String(trade.closeReason))) {
    const id = String(trade.id), prior = byId.get(id);
    if (trade.source === "BINGX_VST_ORDER_HISTORY_FALLBACK" && prior?.source === "BINGX_VST_ALL_FILL_ORDERS") continue;
    byId.set(id, trade);
  }
  let closedMeta = [];
  try {
    const raw = await readEnginePaperState(env, "bingx-vst-closed-strategy-meta-v1");
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) closedMeta = parsed;
  } catch (error) {
    console.warn("BingX VST strategy metadata archive unavailable", String(error).slice(0, 140));
  }
  const rawTrades = [...byId.values()].filter((trade) => trade && trade.model === "BINGX VST" && ["TP", "SL", "MANUAL_CLOSE", "LIQUIDATION"].includes(String(trade.closeReason)));
  const usedRawIds = /* @__PURE__ */ new Set();
  for (const meta of closedMeta) {
    const openedAt = Number(meta.openedAt), closedAt = Number(meta.closedAt), entry = Number(meta.entry);
    if (!(openedAt > 0 && closedAt >= openedAt && entry > 0)) continue;
    const matches = rawTrades.filter((trade) => {
      const at = Number(trade.closedAt), tradeEntry = Number(trade.entry);
      const entryMatches = !Number.isFinite(tradeEntry) || tradeEntry <= 0 || Math.abs(tradeEntry - entry) / entry <= 0.015;
      return !usedRawIds.has(String(trade.id)) && trade.symbol === meta.symbol && trade.side === meta.side && at >= openedAt && at <= closedAt + 3e5 && entryMatches;
    }).sort((a, b) => Number(a.closedAt) - Number(b.closedAt));
    if (!matches.length) continue;
    for (const trade of matches) usedRawIds.add(String(trade.id));
    const pnl = matches.reduce((sum, trade) => sum + (Number(trade.pnlUsdt) || 0), 0), fees = matches.reduce((sum, trade) => sum + (Number(trade.feesPaidUsdt) || 0), 0), qty = matches.reduce((sum, trade) => sum + (Number(trade.qty) || 0), 0), exitQuote = matches.reduce((sum, trade) => sum + (Number(trade.exitPrice) || 0) * (Number(trade.qty) || 0), 0);
    const initialRisk = Number(meta.initialRiskUsdt) > 0 ? Number(meta.initialRiskUsdt) : Number(meta.initialQty) * (Math.abs(entry - Number(meta.stopLoss)) + entry * 7e-4 + Number(meta.stopLoss) * 7e-4);
    const lastTrade = matches[matches.length - 1], audit = meta.audit && typeof meta.audit === "object" ? meta.audit : {};
    const enriched = {
      id: "bingx-vst-position-" + String(meta.setupKey),
      positionId: String(meta.setupKey),
      symbol: meta.symbol,
      side: meta.side,
      model: meta.model ?? "UNKNOWN",
      tradeStyle: meta.tradeStyle ?? "UNKNOWN",
      status: "CLOSED",
      entry,
      exitPrice: qty > 0 ? exitQuote / qty : null,
      qty,
      pnlUsdt: Number(pnl.toFixed(8)),
      feesPaidUsdt: Number(fees.toFixed(8)),
      closeReason: lastTrade.closeReason,
      openedAt,
      closedAt: Math.max(...matches.map((trade) => Number(trade.closedAt) || 0)),
      riskUsdt: initialRisk,
      initialRiskUsdt: initialRisk,
      realizedR: initialRisk > 0 ? Number((pnl / initialRisk).toFixed(5)) : null,
      setupTimeframe: meta.setupTimeframe,
      entryTimeframe: meta.entryTimeframe,
      setupReason: meta.setupReason,
      confirmations: meta.confirmations,
      score: meta.score,
      riskReward: meta.riskReward,
      audit,
      confidenceStatus: "INSUFFICIENT_DATA",
      source: "BINGX_VST_STRATEGY_POSITION",
      executionEvents: matches.flatMap((trade) => Array.isArray(trade.executionEvents) ? trade.executionEvents : [])
    };
    byId.set(enriched.id, enriched);
  }
  const merged = [...byId.values()].sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0)).slice(0, 3e3);
  if (JSON.stringify(merged) !== JSON.stringify(stored)) {
    try {
      await writeEnginePaperState(env, key, JSON.stringify(merged));
    } catch (error) {
      console.warn("BingX VST closed-trade history write failed", String(error).slice(0, 160));
    }
  }
  return merged.filter((trade) => !usedRawIds.has(String(trade.id)));
}
__name(persistBingXDemoClosedTrades, "persistBingXDemoClosedTrades");
async function loadBingXDemoStatus(env) {
  if (!isBingXDemoConfigured(env)) {
    return Response.json({
      ok: false,
      mode: "bingx-demo",
      exchange: "BingX VST",
      demoConnected: false,
      paperTradingEnabled: false,
      balance: null,
      equity: null,
      availableMargin: null,
      positions: [],
      openOrders: [],
      closedTrades: [],
      error: "BingX VST demo mode is selected, but one or more required secrets or demo flags are missing."
    }, { status: 503, headers: { ...headers, "cache-control": "no-store" } });
  }
  try {
    const [snapshot, exchangeFills, exchangeOrders, engine, metaRaw] = await Promise.all([
      getBingXDemoSnapshot(env.BINGX_API_KEY, env.BINGX_API_SECRET),
      getCachedBingXDemoClosedFills(env).catch((error) => {
        console.warn("BingX VST fill history unavailable", String(error).slice(0, 180));
        return null;
      }),
      getCachedBingXDemoOrderHistory(env).catch((error) => {
        console.warn("BingX VST order history unavailable", String(error).slice(0, 180));
        return [];
      }),
      readEnginePaperState(env, "engine-state"),
      readEnginePaperState(env, "bingx-demo-position-meta")
    ]);
    let paperStatusResult = { status: null, storageDegraded: false };
    let ledger = engine?.paperLedger ?? null;
    if (!ledger) {
      paperStatusResult = await readDemoPaperStatus(env);
      ledger = paperStatusResult.status;
    }
    let metadata = [];
    try {
      metadata = metaRaw ? JSON.parse(metaRaw) : [];
    } catch {
      metadata = [];
    }
    const symbols = snapshot.positions.map((p) => p.symbol);
    const marks = symbols.length ? await getBingXMarkPrices(symbols, 5e3) : {};
    const positions = snapshot.positions.map((position) => {
      const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && Number(position.positionAmt) < 0 ? "SHORT" : "LONG";
      const meta = metadata.find((item) => item.symbol === position.symbol && item.side === side);
      const qty = Math.abs(Number(position.positionAmt) || 0);
      const entry = Number(position.avgPrice) || 0;
      const mark = Number(marks[position.symbol]);
      const unrealized = Number(position.unrealizedProfit);
      const closeOrders = snapshot.openOrders.filter((order) => order.symbol === position.symbol && String(order.side ?? "").toUpperCase() === (side === "LONG" ? "SELL" : "BUY") && (!order.positionSide || String(order.positionSide).toUpperCase() === "BOTH" || String(order.positionSide).toUpperCase() === side));
      const tpOrders = closeOrders.filter((order) => ["TAKE_PROFIT_MARKET", "TAKE_PROFIT"].includes(String(order.type).toUpperCase()));
      const stopOrder = closeOrders.find((order) => ["STOP_MARKET", "STOP"].includes(String(order.type).toUpperCase()));
      const stopLoss = meta ? meta.stage === 1 ? meta.entry : meta.stopLoss : Number(stopOrder?.stopPrice) || void 0;
      return {
        id: position.symbol + "-" + side,
        symbol: position.symbol,
        side,
        model: meta?.model ?? "UNTRACKED",
        tradeStyle: meta?.tradeStyle ?? "UNKNOWN",
        setupTimeframe: meta?.setupTimeframe,
        setupSourceTimeframe: meta?.setupTimeframe,
        entryTimeframe: meta?.entryTimeframe,
        status: "OPEN",
        score: meta?.score ?? null,
        qty,
        initialQty: meta?.initialQty ?? qty,
        setupReason: meta?.setupReason ?? null,
        reason: meta?.setupReason ?? null,
        confirmations: meta?.confirmations ?? null,
        scoreBreakdown: meta?.scoreBreakdown ?? null,
        riskReward: meta?.riskReward ?? null,
        audit: meta?.audit ?? null,
        positionSource: "BINGX_VST_EXCHANGE",
        metadataAvailable: !!meta,
        openedAtSource: meta ? "BINGX_VST_ENTRY_METADATA" : "NOT_RECORDED",
        protectionStatus: stopOrder && tpOrders.length ? "EXCHANGE_ORDERS_VISIBLE" : "PROTECTION_UNVERIFIED",
        stopLossSource: meta ? "BOT_METADATA" : stopOrder ? "BINGX_OPEN_ORDER" : "MISSING",
        takeProfitSource: meta ? "BOT_METADATA" : tpOrders.length ? "BINGX_OPEN_ORDER" : "MISSING",
        entry,
        stopLoss,
        takeProfit: (meta?.tp2 ?? Number(tpOrders.at(-1)?.stopPrice)) || void 0,
        tp1: meta?.tp1 ?? (tpOrders.length > 1 ? Number(tpOrders[0].stopPrice) : void 0),
        tp2: (meta?.tp2 ?? Number(tpOrders.at(-1)?.stopPrice)) || void 0,
        targetStage: meta?.stage ?? 0,
        leverage: Number(position.leverage) || 0,
        effectiveLeverage: Number(position.leverage) || 0,
        leverageMaxSupported: 50,
        leverageVerifiedAt: snapshot.fetchedAt,
        leverageSource: "BINGX_VST_ACCOUNT",
        marginUsdt: Number(position.initialMargin) || 0,
        allocationUsdt: Number(position.initialMargin) || 0,
        initialMarginUsdt: Number(position.initialMargin) || 0,
        notionalUsdt: Number(position.positionValue) || qty * entry,
        liquidationPrice: Number(position.liquidationPrice) || 0,
        marginMode: position.isolated ? "ISOLATED" : "CROSS",
        markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
        currentPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
        unrealizedPnlUsdt: Number.isFinite(unrealized) ? unrealized : null,
        livePriceAvailable: Number.isFinite(mark) && mark > 0,
        livePriceAt: snapshot.fetchedAt,
        openedAt: meta?.openedAt ?? null,
        setupCandleTime: void 0,
        candleTime: meta?.openedAt ?? void 0,
        riskUsdt: Number.isFinite(Number(stopLoss)) && Number(stopLoss) > 0 && entry > 0 ? Math.abs(entry - Number(stopLoss)) * qty : void 0,
        feeRate: 5e-4,
        positionId: null
      };
    });
    const orderById = new Map((exchangeOrders ?? []).map((order) => [String(order.orderID ?? order.orderId), order]));
    const orderByNumericId = /* @__PURE__ */ new Map();
    for (const order of exchangeOrders ?? []) {
      const rawId = order.orderID ?? order.orderId;
      const numericId = Number(rawId);
      if (rawId != null && Number.isFinite(numericId)) orderByNumericId.set(String(numericId), order);
    }
    const findHistoricalOrder = /* @__PURE__ */ __name((rawId) => {
      if (rawId == null) return void 0;
      const exact = orderById.get(String(rawId));
      if (exact) return exact;
      const numericId = Number(rawId);
      return Number.isFinite(numericId) ? orderByNumericId.get(String(numericId)) : void 0;
    }, "findHistoricalOrder");
    const exchangeClosedTrades = exchangeFills === null ? [] : (() => {
      const grouped = /* @__PURE__ */ new Map();
      const inventory = /* @__PURE__ */ new Map(), entryByOrder = /* @__PURE__ */ new Map();
      const resolvedFillSide = /* @__PURE__ */ __name((fill, currentInventory) => {
        const explicit = String(fill.positionSide ?? "").toUpperCase();
        if (explicit === "LONG" || explicit === "SHORT") return explicit;
        const side = String(fill.side ?? "").toUpperCase(), symbol = String(fill.symbol);
        const reduceOnly = fill.reduceOnly === true || String(fill.reduceOnly).toLowerCase() === "true" || fill.closePosition === true || String(fill.closePosition).toLowerCase() === "true";
        if (side === "SELL" && (reduceOnly || Number(currentInventory?.get(symbol + "|LONG")?.qty ?? 0) > 1e-10 || Math.abs(Number(fill.realizedPnl) || 0) > 1e-10)) return "LONG";
        if (side === "BUY" && (reduceOnly || Number(currentInventory?.get(symbol + "|SHORT")?.qty ?? 0) > 1e-10 || Math.abs(Number(fill.realizedPnl) || 0) > 1e-10)) return "SHORT";
        return side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : "";
      }, "resolvedFillSide");
      const fillSideByRecord = /* @__PURE__ */ new WeakMap();
      const chronological = [...exchangeFills].sort((a, b) => Number(a.time) - Number(b.time));
      for (const fill of chronological) {
        const symbol = String(fill.symbol), positionSide2 = resolvedFillSide(fill, inventory), fillSide = String(fill.side ?? "").toUpperCase();
        fillSideByRecord.set(fill, positionSide2);
        if (positionSide2 !== "LONG" && positionSide2 !== "SHORT") continue;
        const qty = Math.abs(Number(fill.qty) || 0), price = Number(fill.price) || 0;
        if (!(qty > 0 && price > 0)) continue;
        const inventoryKey = symbol + "|" + positionSide2, lot = inventory.get(inventoryKey) ?? { qty: 0, quote: 0 };
        const isClosing = positionSide2 === "LONG" && fillSide === "SELL" || positionSide2 === "SHORT" && fillSide === "BUY";
        if (isClosing) {
          const matchedQty = Math.min(qty, lot.qty), avgEntry = lot.qty > 0 ? lot.quote / lot.qty : 0;
          const orderId2 = String(fill.orderId ?? fill.orderID ?? fill.tradeId ?? "unknown"), orderKey = symbol + "|" + orderId2;
          const entry = entryByOrder.get(orderKey) ?? { qty: 0, quote: 0 };
          entry.qty += matchedQty;
          entry.quote += matchedQty * avgEntry;
          entryByOrder.set(orderKey, entry);
          lot.qty = Math.max(0, lot.qty - matchedQty);
          lot.quote = Math.max(0, lot.quote - matchedQty * avgEntry);
        } else {
          lot.quote += qty * price;
          lot.qty += qty;
        }
        inventory.set(inventoryKey, lot);
      }
      for (const fill of exchangeFills) {
        const realized = Number(fill.realizedPnl) || 0;
        const fillPositionSide = fillSideByRecord.get(fill) ?? resolvedFillSide(fill);
        const orderId2 = String(fill.orderId ?? fill.orderID ?? fill.tradeId ?? "unknown");
        const key = String(fill.symbol) + "|" + orderId2;
        const row = grouped.get(key) ?? { symbol: String(fill.symbol), side: fillPositionSide || (String(fill.side).toUpperCase() === "SELL" ? "SHORT" : "LONG"), qty: 0, quote: 0, entryQuote: 0, entryQty: 0, realizedPnl: 0, fees: 0, closedAt: 0, orderId: orderId2, orderType: String(fill.type ?? ""), positionSide: fillPositionSide, fillSide: String(fill.side ?? ""), fills: [] };
        const qty = Math.abs(Number(fill.qty) || 0), price = Number(fill.price) || 0;
        row.qty += qty;
        row.quote += qty * price;
        row.realizedPnl += realized;
        row.fees += Number(fill.fee) || 0;
        row.closedAt = Math.max(row.closedAt, Number(fill.time) || 0);
        const matchedOrder = findHistoricalOrder(fill.orderId ?? fill.orderID ?? orderId2);
        const fillType = String(fill.type ?? "").trim(), historicalType = String(matchedOrder?.type ?? "").trim();
        row.orderType = fillType || historicalType || String(row.orderType ?? "").trim();
        row.positionSide = fillPositionSide || String(row.positionSide ?? "");
        row.fillSide = String(fill.side ?? row.fillSide ?? "");
        row.fills.push({ event: "BINGX_FILL", qty, executionPrice: price, triggerPrice: matchedOrder?.stopPrice ?? matchedOrder?.price ?? null, orderType: row.orderType || null, at: Number(fill.time) || 0, realizedPnl: realized, fee: Number(fill.fee) || 0 });
        grouped.set(key, row);
      }
      for (const [key, row] of grouped) {
        const entry = entryByOrder.get(key);
        if (entry) {
          row.entryQty = entry.qty;
          row.entryQuote = entry.quote;
        }
      }
      return [...grouped.values()].map((row) => {
        const matchedOrder = findHistoricalOrder(row.orderId);
        const orderType = (String(row.orderType ?? "").trim() || String(matchedOrder?.type ?? "").trim()).toUpperCase();
        const clientOrderId = String(matchedOrder?.clientOrderId ?? "").toLowerCase();
        const positionSide2 = String(row.positionSide ?? "").toUpperCase();
        const fillSide = String(row.fillSide ?? "").toUpperCase();
        const closingDirection = positionSide2 === "LONG" && fillSide === "SELL" || positionSide2 === "SHORT" && fillSide === "BUY";
        const closeReason2 = { TAKE_PROFIT_MARKET: "TP", TAKE_PROFIT: "TP", STOP_MARKET: "SL", STOP: "SL", LIQUIDATION: "LIQUIDATION", ADL: "LIQUIDATION" }[orderType] ?? (closingDirection || clientOrderId.startsWith("smc-close-") || matchedOrder?.reduceOnly === true || String(matchedOrder?.reduceOnly).toLowerCase() === "true" || matchedOrder?.closePosition === true || String(matchedOrder?.closePosition).toLowerCase() === "true" ? "MANUAL_CLOSE" : "OTHER");
        return {
          id: "bingx-vst-" + row.symbol + "-" + row.orderId,
          symbol: row.symbol,
          side: row.side,
          model: "BINGX VST",
          entry: row.entryQty > 0 ? row.entryQuote / row.entryQty : null,
          exitPrice: row.qty ? row.quote / row.qty : null,
          qty: row.qty,
          feesPaidUsdt: Number(Math.abs(row.fees).toFixed(8)),
          pnlUsdt: Number((row.realizedPnl - Math.abs(row.fees)).toFixed(8)),
          closeReason: closeReason2,
          orderType: orderType || null,
          closedAt: row.closedAt,
          executionEvents: row.fills,
          source: "BINGX_VST_ALL_FILL_ORDERS"
        };
      }).sort((a, b) => Number(b.closedAt) - Number(a.closedAt));
    })();
    const orderHistoryFallbackTrades = buildBingXOrderHistoryClosedTrades(exchangeOrders);
    const persistedClosedTrades = await persistBingXDemoClosedTrades(env, [...orderHistoryFallbackTrades, ...exchangeClosedTrades]);
    const dailyPnl = snapshot.dailyIncome.filter((item) => ["REALIZED_PNL", "FUNDING_FEE", "TRADING_FEE"].includes(String(item.incomeType ?? "").toUpperCase())).reduce((sum, item) => sum + (Number(item.income) || 0), 0);
    return Response.json({
      ok: true,
      mode: "bingx-demo",
      exchange: "BingX VST",
      demoBaseUrl: snapshot.baseUrl,
      paperTradingEnabled: false,
      liveTradingEnabled: false,
      demoTradingEnabled: true,
      demoConnected: true,
      positionManagementEnabled: true,
      strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
      newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
      scannerPaused: false,
      scannerActive: !SCANNER_PAUSED && !AUTOMATION_STOP && (paperStatusResult.status ? paperStatusResult.status.runnerEnabled === true : engine?.runnerEnabled === true),
      strategyMode: "SCALP_SWING_INDEPENDENT",
      balance: snapshot.balance?.balance ?? null,
      equity: snapshot.balance?.equity ?? null,
      availableMargin: snapshot.balance?.availableMargin ?? null,
      usedMargin: snapshot.balance?.usedMargin ?? null,
      freezedMargin: snapshot.balance?.freezedMargin ?? null,
      unrealizedProfit: snapshot.balance?.unrealizedProfit ?? null,
      realisedProfit: snapshot.balance?.realisedProfit ?? null,
      dailyPnl: snapshot.dailyIncomeAvailable ? Number(dailyPnl.toFixed(8)) : null,
      dailyPnlSource: snapshot.dailyIncomeAvailable ? "BINGX_DEMO_INCOME_REALIZED_PNL_FUNDING_FEE_TRADING_FEE" : "NOT_AVAILABLE",
      dailyIncome: snapshot.dailyIncomeAvailable ? snapshot.dailyIncome : [],
      positions,
      openOrders: snapshot.openOrders,
      closedTrades: persistedClosedTrades,
      closedTradesSource: "BINGX_VST_PERSISTED_FILL_AND_ORDER_HISTORY",
      closedTradesHistoryAvailable: exchangeFills !== null || exchangeOrders.length > 0 || persistedClosedTrades.length > 0,
      closedTradeClassificationAvailable: exchangeOrders.length > 0,
      closedTradesHistoryWindowDays: 90,
      closedTradesFallbackWindowDays: 7,
      closedTradeHistoryDiagnostics: { fillApiAvailable: exchangeFills !== null, fillCount: exchangeFills?.length ?? null, orderHistoryCount: exchangeOrders.length, orderHistoryCloseCount: orderHistoryFallbackTrades.length, persistedClosedTradeCount: persistedClosedTrades.length, fillHistorySource: exchangeFills === null ? "UNAVAILABLE" : exchangeFills.length === 0 ? "EMPTY" : "AVAILABLE" },
      setups: filterActiveSwingSetups(ledger?.setups),
      scannedSymbols: ledger?.scannedSymbols ?? [],
      lastScanAt: ledger?.lastScanAt ?? null,
      scanDiagnostics: filterActiveSwingDiagnostics(ledger?.scanDiagnostics),
      scanTelemetry: ledger?.scanTelemetry ?? null,
      quotaTelemetry: ledger?.quotaTelemetry ?? null,
      modelTelemetry: filterActiveSwingModelTelemetry(ledger?.modelTelemetry) ?? null,
      scanUniverseSize: ledger?.scanUniverseSize ?? 0,
      scanBatchSize: ledger?.scanBatchSize ?? PAPER_SCAN_BATCH_NORMAL,
      scanCursor: Math.max(0, Number(ledger?.cursor ?? 0)),
      lastScannedSymbol: engine?.lastScannedSymbol ?? null,
      scanRotation: ledger?.scanRotation ? { ...ledger.scanRotation, seenCount: ledger.scanRotation.seenSymbols.length, seenSymbols: [] } : null,
      scanLogicalBatchRemaining: ledger?.scanLogicalBatchRemaining ?? null,
      activityRanking: null,
      activityRankingBySymbol: {},
      marketContextSnapshot: null,
      maxOpenPositions: Math.min(10, Math.max(0, Number(ledger?.maxOpenPositions ?? 10))),
      runnerEnabled: paperStatusResult.status ? paperStatusResult.status.runnerEnabled === true : engine?.runnerEnabled === true,
      automationStopped: AUTOMATION_STOP,
      manualResumeRequired: AUTOMATION_STOP,
      storageDegraded: paperStatusResult.storageDegraded || !ledger,
      livePnlUpdatedAt: snapshot.fetchedAt,
      dashboardSource: "bingx-vst-demo",
      hedgeMode: snapshot.hedgeMode,
      positionCount: positions.length,
      note: exchangeFills === null ? "BingX VST fill ge\xE7mi\u015Fi al\u0131namad\u0131; son 7 g\xFCnl\xFCk ger\xE7ekle\u015Fmi\u015F kapan\u0131\u015Flar emir ge\xE7mi\u015Finden yedeklenir." : "Kapanan \u0130\u015Flemler BingX VST fill ve emir ge\xE7mi\u015Finden kal\u0131c\u0131 olarak saklan\u0131r; ayn\u0131 emir tek kez say\u0131l\u0131r."
    }, { headers: { ...headers, "cache-control": "no-store", "x-dashboard-source": "bingx-vst-demo" } });
  } catch (error) {
    console.error("BingX VST dashboard sync failed", String(error).slice(0, 220));
    return Response.json({
      ok: false,
      mode: "bingx-demo",
      exchange: "BingX VST",
      demoConnected: false,
      paperTradingEnabled: false,
      balance: null,
      equity: null,
      availableMargin: null,
      positions: [],
      openOrders: [],
      closedTrades: [],
      error: "BingX VST demo account could not be read: " + String(error).slice(0, 220)
    }, { status: 503, headers: { ...headers, "cache-control": "no-store" } });
  }
}
__name(loadBingXDemoStatus, "loadBingXDemoStatus");
var bingxDemoStatusCache = null;
function isDemoControlAuthorized(request, env) {
  const expected = env.LIVE_CONTROL_TOKEN ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!expected || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
}
__name(isDemoControlAuthorized, "isDemoControlAuthorized");
async function dashboardBingXDemoStatus(env) {
  const toResponse = /* @__PURE__ */ __name((payload2) => new Response(payload2.body, {
    status: payload2.status,
    headers: new Headers(payload2.headers)
  }), "toResponse");
  if (bingxDemoStatusCache && bingxDemoStatusCache.expiresAt > Date.now()) {
    return toResponse(bingxDemoStatusCache.payload);
  }
  const response = await loadBingXDemoStatus(env);
  const payload = {
    body: await response.text(),
    status: response.status,
    headers: [...response.headers.entries()]
  };
  if (response.ok) bingxDemoStatusCache = { expiresAt: Date.now() + 3e4, payload };
  return toResponse(payload);
}
__name(dashboardBingXDemoStatus, "dashboardBingXDemoStatus");
async function dashboardBingXDemoLivePnl(env) {
  if (!isBingXDemoConfigured(env)) return Response.json({ ok: false, mode: "bingx-demo", paperTradingEnabled: false, error: "BingX VST demo is not configured." }, { status: 503, headers });
  try {
    if (!bingxDemoStatusCache) await dashboardBingXDemoStatus(env);
    const [exchangePositions, metaRaw] = await Promise.all([
      getBingXDemoPositions(env.BINGX_API_KEY, env.BINGX_API_SECRET),
      readEnginePaperState(env, "bingx-demo-position-meta")
    ]);
    const openOrders = await getBingXDemoOpenOrders(env.BINGX_API_KEY, env.BINGX_API_SECRET, exchangePositions.map((position) => position.symbol));
    let metadata = [];
    try {
      metadata = metaRaw ? JSON.parse(metaRaw) : [];
    } catch {
      metadata = [];
    }
    const symbols = exchangePositions.map((position) => position.symbol);
    const marks = symbols.length ? await getBingXMarkPrices(symbols, 5e3) : {};
    const positions = exchangePositions.map((position) => {
      const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && Number(position.positionAmt) < 0 ? "SHORT" : "LONG";
      const meta = metadata.find((item) => item.symbol === position.symbol && item.side === side);
      const qty = Math.abs(Number(position.positionAmt) || 0);
      const entry = Number(position.avgPrice) || 0;
      const mark = Number(marks[position.symbol]);
      const unrealized = Number(position.unrealizedProfit);
      const closeOrders = openOrders.filter((order) => order.symbol === position.symbol && String(order.side ?? "").toUpperCase() === (side === "LONG" ? "SELL" : "BUY") && (!order.positionSide || String(order.positionSide).toUpperCase() === "BOTH" || String(order.positionSide).toUpperCase() === side));
      const tpOrders = closeOrders.filter((order) => ["TAKE_PROFIT_MARKET", "TAKE_PROFIT"].includes(String(order.type).toUpperCase()));
      const stopOrder = closeOrders.find((order) => ["STOP_MARKET", "STOP"].includes(String(order.type).toUpperCase()));
      const exchangeStop = Number(stopOrder?.stopPrice);
      const exchangeTp = Number(tpOrders.at(-1)?.stopPrice);
      return {
        id: position.symbol + "-" + side,
        symbol: position.symbol,
        side,
        model: meta?.model ?? "UNTRACKED",
        tradeStyle: meta?.tradeStyle ?? (meta ? "SWING" : "\u2014"),
        setupTimeframe: meta?.setupTimeframe,
        setupSourceTimeframe: meta?.setupTimeframe,
        entryTimeframe: meta?.entryTimeframe,
        status: "OPEN",
        score: meta?.score ?? null,
        qty,
        initialQty: meta?.initialQty ?? qty,
        entry,
        setupReason: meta?.setupReason ?? null,
        reason: meta?.setupReason ?? null,
        confirmations: meta?.confirmations ?? null,
        scoreBreakdown: meta?.scoreBreakdown ?? null,
        riskReward: meta?.riskReward ?? null,
        audit: meta?.audit ?? null,
        positionSource: "BINGX_VST_EXCHANGE",
        metadataAvailable: !!meta,
        openedAtSource: meta ? "BINGX_VST_ENTRY_METADATA" : "NOT_RECORDED",
        protectionStatus: stopOrder && tpOrders.length ? "EXCHANGE_ORDERS_VISIBLE" : "PROTECTION_UNVERIFIED",
        stopLossSource: meta ? "BOT_METADATA" : stopOrder ? "BINGX_OPEN_ORDER" : "MISSING",
        takeProfitSource: meta ? "BOT_METADATA" : tpOrders.length ? "BINGX_OPEN_ORDER" : "MISSING",
        stopLoss: meta ? meta.stage === 1 ? meta.entry : meta.stopLoss : Number.isFinite(exchangeStop) && exchangeStop > 0 ? exchangeStop : void 0,
        takeProfit: meta?.tp2 ?? (Number.isFinite(exchangeTp) && exchangeTp > 0 ? exchangeTp : void 0),
        tp1: meta?.tp1 ?? (tpOrders.length > 1 ? Number(tpOrders[0].stopPrice) : void 0),
        tp2: meta?.tp2 ?? (Number.isFinite(exchangeTp) ? exchangeTp : void 0),
        targetStage: meta?.stage ?? 0,
        leverage: Number(position.leverage) || 0,
        effectiveLeverage: Number(position.leverage) || 0,
        leverageMaxSupported: 50,
        leverageVerifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
        leverageSource: "BINGX_VST_ACCOUNT",
        marginUsdt: Number(position.initialMargin) || 0,
        allocationUsdt: Number(position.initialMargin) || 0,
        initialMarginUsdt: Number(position.initialMargin) || 0,
        notionalUsdt: Number(position.positionValue) || qty * entry,
        liquidationPrice: Number(position.liquidationPrice) || 0,
        marginMode: position.isolated ? "ISOLATED" : "CROSS",
        markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
        currentPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
        unrealizedPnlUsdt: Number.isFinite(unrealized) ? unrealized : null,
        livePriceAvailable: Number.isFinite(mark) && mark > 0,
        livePriceAt: (/* @__PURE__ */ new Date()).toISOString(),
        openedAt: meta?.openedAt ?? null,
        candleTime: meta?.openedAt ?? void 0,
        riskUsdt: Number.isFinite(meta ? meta.stage === 1 ? entry : meta.stopLoss : exchangeStop) && Number(meta ? meta.stage === 1 ? entry : meta.stopLoss : exchangeStop) > 0 && entry > 0 ? Math.abs(entry - Number(meta ? meta.stage === 1 ? entry : meta.stopLoss : exchangeStop)) * qty : void 0,
        feeRate: 5e-4,
        positionId: null
      };
    });
    let balanceFields = {};
    if (bingxDemoStatusCache && bingxDemoStatusCache.expiresAt > Date.now()) {
      try {
        const cached = JSON.parse(bingxDemoStatusCache.payload.body);
        balanceFields = { balance: cached.balance, equity: cached.equity, availableMargin: cached.availableMargin, usedMargin: cached.usedMargin, freezedMargin: cached.freezedMargin, dailyPnl: cached.dailyPnl, realisedProfit: cached.realisedProfit };
      } catch {
      }
    }
    return Response.json({
      ok: true,
      mode: "bingx-demo",
      demoConnected: true,
      paperTradingEnabled: false,
      liveTradingEnabled: false,
      positions,
      closedTrades: [],
      livePnlUpdatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...balanceFields,
      source: "bingx-vst-demo-live-pnl"
    }, { headers: { ...headers, "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, mode: "bingx-demo", paperTradingEnabled: false, error: "BingX VST live position refresh failed: " + String(error).slice(0, 200) }, { status: 503, headers });
  }
}
__name(dashboardBingXDemoLivePnl, "dashboardBingXDemoLivePnl");
async function dashboardPaperStatus(env) {
  try {
    const [notice, retryRaw, engine, explicitPause] = await Promise.all([
      readEnginePaperState(env, "state-recovery-notice"),
      readEnginePaperState(env, "state-recovery-retry"),
      readEnginePaperState(env, "engine-state"),
      readEnginePaperState(env, "paper-runner-explicitly-paused")
    ]);
    if (notice) return degradedPaperSnapshot("Original paper ledger recovery is pending; no replacement balance is shown.", notice, retryRaw);
    if (!engine || !engine.paperLedger || typeof engine.paperLedger.balance !== "number") {
      return degradedPaperSnapshot("No verified paper-ledger snapshot is available yet; no default balance is shown.", null, retryRaw);
    }
    const ledger = engine.paperLedger;
    const livePositions = (ledger.positions ?? []).filter((p) => p.status === "OPEN").map((position) => {
      const stored = position;
      const candidate = Number(stored.markPrice ?? stored.lastMarkPrice);
      const markPrice = Number.isFinite(candidate) && candidate > 0 ? candidate : null;
      const unrealizedPnlUsdt = stored.unrealizedPnlUsdt != null && Number.isFinite(Number(stored.unrealizedPnlUsdt)) ? Number(stored.unrealizedPnlUsdt) : null;
      return {
        ...position,
        markPrice,
        currentPrice: markPrice,
        unrealizedPnlUsdt,
        livePriceAvailable: markPrice !== null,
        livePriceAt: stored.markPriceAt ?? stored.livePriceAt ?? engine.lastScanAt ?? null
      };
    });
    const liveUnrealized = livePositions.reduce((sum, position) => sum + (Number.isFinite(position.unrealizedPnlUsdt) ? Number(position.unrealizedPnlUsdt) : 0), 0);
    return Response.json({
      ok: true,
      mode: env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo",
      manualPause: explicitPause === "true",
      ...ledger,
      scanRotation: ledger.scanRotation ? { ...ledger.scanRotation, seenSymbols: [] } : ledger.scanRotation,
      positions: livePositions,
      equity: Number((ledger.balance + liveUnrealized).toFixed(4)),
      strategyMode: "SCALP_SWING_INDEPENDENT",
      strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
      newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
      positionManagementEnabled: true,
      scannerPaused: SCANNER_PAUSED,
      paperTradingEnabled: env.BINGX_TRADING_MODE === "paper" && env.PAPER_TRADING_ONLY === "true",
      liveTradingEnabled: false,
      demoTradingEnabled: false,
      demoConnected: false,
      scannerActive: !SCANNER_PAUSED && !AUTOMATION_STOP && engine.runnerEnabled === true,
      scanBatchSize: PAPER_SCAN_BATCH_NORMAL,
      livePnlUpdatedAt: engine.lastScanAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      runnerEnabled: AUTOMATION_STOP ? false : engine.runnerEnabled,
      stateRecoveryNotice: null,
      automationStopped: AUTOMATION_STOP,
      manualResumeRequired: AUTOMATION_STOP,
      storageDegraded: false,
      dashboardSource: "kv-snapshot"
    }, { headers: { ...headers, "x-dashboard-source": "kv-snapshot" } });
  } catch (error) {
    console.error("Dashboard paper snapshot failed", String(error).slice(0, 180));
    return degradedPaperSnapshot("Dashboard snapshot is temporarily unavailable from KV; scanner state is not assumed.", null, null);
  }
}
__name(dashboardPaperStatus, "dashboardPaperStatus");
async function cloudflareAccountUsage(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || CLOUDFLARE_ACCOUNT_ID_DEFAULT;
  const source = "Cloudflare Billable Usage API";
  const base = {
    configured: !!env.CLOUDFLARE_BILLING_API_TOKEN,
    source,
    note: "Cloudflare returns daily billable usage rows, including metered usage within free-tier allowances. Values are reported only when the corresponding metric row is returned; this endpoint does not provide an overall plan-quota percentage."
  };
  const emptyMetrics = {
    workersRequests: null,
    workersDurationGbSeconds: null,
    workersKVReads: null,
    workersKVWrites: null,
    durableObjectSqlRowsRead: null,
    durableObjectSqlRowsWritten: null,
    durableObjectSqlRowsAvailable: false
  };
  if (!env.CLOUDFLARE_BILLING_API_TOKEN) {
    return Response.json({
      ok: false,
      ...base,
      configured: false,
      ...emptyMetrics,
      error: "CLOUDFLARE_BILLING_API_TOKEN secret is not configured on the Worker. Add the GitHub Actions secret using a least-privilege Cloudflare token with Account Billing: Read."
    }, { headers });
  }
  const now = /* @__PURE__ */ new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1e3);
  const from = periodStart.toISOString().slice(0, 10);
  const to = periodEnd.toISOString().slice(0, 10);
  const query = new URLSearchParams({ from, to });
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/billable/usage?${query}`, {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_BILLING_API_TOKEN}`, accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
    const payload = await response.json();
    if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
      const errorText = [...payload.errors ?? [], ...payload.messages ?? []].map((x) => x.message).filter(Boolean).join("; ");
      return Response.json({
        ok: false,
        ...base,
        configured: true,
        periodStart: from,
        periodEnd: to,
        ...emptyMetrics,
        error: response.status === 403 ? "Cloudflare rejected the token. It needs Account Billing: Read permission for billable usage." : `Cloudflare billable usage query failed (HTTP ${response.status}): ${errorText || "Cloudflare returned success=false or an invalid result payload."}`
      }, { headers });
    }
    const summary = summarizeCloudflareBillableUsage(payload.result);
    const durableObjectSqlRowsAvailable = summary.durableObjectSqlRowsRead !== null || summary.durableObjectSqlRowsWritten !== null;
    const missingMetrics = [
      summary.workersRequests === null ? "Workers requests" : null,
      summary.workersDurationGbSeconds === null ? "Workers duration" : null,
      summary.workersKVReads === null ? "Workers KV reads" : null,
      summary.workersKVWrites === null ? "Workers KV writes" : null,
      !durableObjectSqlRowsAvailable ? "Durable Objects SQL rows" : null
    ].filter(Boolean);
    const note = base.note + (missingMetrics.length ? ` Not returned for this period: ${missingMetrics.join(", ")}.` : "") + (!durableObjectSqlRowsAvailable ? " DO SQL counters shown elsewhere remain application-observed last-hour values, not account totals." : "");
    return Response.json({
      ok: true,
      ...base,
      configured: true,
      periodStart: from,
      periodEnd: to,
      periodKind: "current UTC day",
      workersRequests: summary.workersRequests,
      workersDurationGbSeconds: summary.workersDurationGbSeconds,
      workersKVReads: summary.workersKVReads,
      workersKVWrites: summary.workersKVWrites,
      durableObjectSqlRowsRead: summary.durableObjectSqlRowsRead,
      durableObjectSqlRowsWritten: summary.durableObjectSqlRowsWritten,
      durableObjectSqlRowsAvailable,
      rowsReturned: payload.result.length,
      matchedMetrics: summary.matchedMetrics,
      availableMetrics: summary.availableMetrics,
      samples: summary.samples,
      note
    }, { headers });
  } catch (error) {
    return Response.json({
      ok: false,
      ...base,
      configured: true,
      ...emptyMetrics,
      error: `Cloudflare billable usage query failed: ${String(error).slice(0, 180)}`
    }, { headers });
  }
}
__name(cloudflareAccountUsage, "cloudflareAccountUsage");
function taskKey(task) {
  return `${task.symbol}|${task.interval}`;
}
__name(taskKey, "taskKey");
function intervalMs(interval) {
  const ms = { "5m": 3e5, "15m": 9e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "1d": 864e5 };
  return ms[interval] ?? 6e4;
}
__name(intervalMs, "intervalMs");
function normalizeCandle(item) {
  const arr = Array.isArray(item) ? item : null;
  const obj = item && typeof item === "object" && !arr ? item : null;
  const time = Number(arr ? arr[0] : obj?.time ?? obj?.timestamp ?? obj?.openTime ?? obj?.open_time);
  if (!Number.isFinite(time)) return null;
  const num = /* @__PURE__ */ __name((v) => v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null, "num");
  return { time, open: num(arr ? arr[1] : obj?.open), high: num(arr ? arr[2] : obj?.high), low: num(arr ? arr[3] : obj?.low), close: num(arr ? arr[4] : obj?.close), volume: num(arr ? arr[5] : obj?.volume), quoteVolume: num(arr ? arr[7] : obj?.quoteVolume ?? obj?.quote_volume), takerBuyVolume: num(arr ? arr[9] : obj?.takerBuyVolume ?? obj?.taker_buy_volume), takerBuyQuoteVolume: num(arr ? arr[10] : obj?.takerBuyQuoteVolume ?? obj?.taker_buy_quote_volume) };
}
__name(normalizeCandle, "normalizeCandle");
async function bingx(path) {
  const ttl = path.includes("/quote/contracts") ? 300 : path.includes("/quote/ticker") ? 2 : path.includes("/quote/klines") ? 5 : 5;
  const response = await fetch(BINGX + path, {
    headers: { "accept": "application/json" },
    signal: AbortSignal.timeout(15e3),
    cf: { cacheTtl: ttl, cacheEverything: true }
  });
  const body = await response.text();
  const headers2 = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": `public, max-age=${ttl}`
  });
  return new Response(body, { status: response.status, headers: headers2 });
}
__name(bingx, "bingx");

const DASHBOARD_HTML = "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>SMC PRO V2</title><style>\n*{box-sizing:border-box}body{margin:0;background:#08111f;color:#e8eef8;font:14px system-ui}.wrap{max-width:1450px;margin:auto;padding:16px}.top,.panel,.stat,.engine,.pc{background:#111d2d;border:1px solid #293a50;border-radius:13px}.top{padding:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.brand{font-size:21px;font-weight:800}.muted,small{color:#91a3ba}.muted{font-size:12px}.token{display:flex;gap:6px}.token input{width:190px;background:#091728;border:1px solid #354a63;border-radius:8px;color:#fff;padding:8px}.stats,.engines{display:grid;gap:10px;margin:12px 0}.stats{grid-template-columns:repeat(4,1fr)}.engines{grid-template-columns:repeat(2,1fr)}.summary{grid-template-columns:repeat(3,1fr)}.summary .stat{min-height:104px}.summary .num{font-size:21px}.limit-scale{display:flex;justify-content:space-between;color:#91a3ba;font-size:10px;margin-top:8px}.summary .sub{color:#91a3ba;font-size:11px;margin-top:5px;line-height:1.35}.stat,.engine{padding:12px 14px}.num{font-size:23px;font-weight:750;margin-top:5px}.engine{display:flex;justify-content:space-between}.ok{color:#3bd39a}.warn{color:#e6b35f}.tabs{display:flex;gap:7px;overflow:auto;padding:2px 0 12px}.btn,.tabs button{background:#15263b;border:1px solid #354b66;color:#d3deed;border-radius:8px;padding:9px 11px;cursor:pointer;white-space:nowrap}.tabs button.active{background:#28528a;color:#fff}.panel{padding:15px;min-height:380px}.head{display:flex;justify-content:space-between;align-items:center}.head h2{font-size:17px;margin:0}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:850px;margin-top:13px}td,th{padding:10px 8px;border-bottom:1px solid #26374c;text-align:left;font-size:12px}th{color:#91a3ba}.sym{font-weight:800}.long{color:#3bd39a}.short{color:#ff7786}.why{max-width:270px;color:#c3d0e0;line-height:1.4}.small{font-size:11px;padding:7px 9px}.close{background:#4a2632;border-color:#87404e}.chartbtn{background:#1c3c5d}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:14px}.pc{padding:14px}.pchead{display:flex;justify-content:space-between;gap:8px}.pcname{font-size:16px;font-weight:800}.actions{display:flex;gap:6px}.details{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}.details div,.metric{background:#0b1727;padding:9px;border-radius:8px}.details small{display:block;font-size:10px;margin-bottom:4px}.details b{font-size:12px}.reason{line-height:1.5;color:#c5d1e0;margin:10px 0}.scalehead,.scalefoot{display:flex;justify-content:space-between;color:#98abc1;font-size:10px}.scale{height:10px;border-radius:20px;background:linear-gradient(90deg,#d95d6b,#d4a44d,#30b887);position:relative;margin:7px 0}.needle{position:absolute;top:-4px;height:18px;width:3px;background:white;box-shadow:0 0 6px white;left:50%;transition:left .8s ease}.tpmark{position:absolute;top:1px;height:8px;width:2px;background:#fff;opacity:.85;transform:translateX(-1px)}.empty{padding:34px;text-align:center;border:1px dashed #384a60;border-radius:10px;color:#91a3ba;margin-top:14px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}.healthbox{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0}.healthline{display:flex;justify-content:space-between;gap:10px;background:#0b1727;padding:10px;border-radius:8px}.healthline span{color:#91a3ba}@media(max-width:720px){.healthbox{grid-template-columns:1fr}}.metric b{display:block;font-size:18px;margin-top:5px}.tag{font-size:10px;padding:4px 6px;border-radius:6px;background:#283c55}.ready{background:#174336;color:#8ae0c0}.wait{background:#493b24;color:#f3cd83}.chart{width:100%;height:620px;border:0;border-radius:10px;margin-top:12px}.modal{display:none;position:fixed;inset:0;background:#000b;z-index:5;align-items:center;justify-content:center;padding:16px}.modal.show{display:flex}.box{width:min(420px,100%);background:#111d2d;border:1px solid #3b506b;border-radius:14px;padding:20px}.box input{width:100%;margin:18px 0}.end{display:flex;justify-content:flex-end;gap:8px}.note{font-size:11px;color:#9aacc2;line-height:1.5;margin-top:12px}@media(max-width:720px){.wrap{padding:9px}.stats{grid-template-columns:repeat(2,1fr)}.summary{grid-template-columns:repeat(2,1fr)}.cards,.engines,.grid{grid-template-columns:1fr}.details{grid-template-columns:repeat(2,1fr)}.token input{width:135px}.chart{height:500px}}\n.scanner-scroll{max-height:520px;overflow-y:auto;overflow-x:auto;border:1px solid #293a50;border-radius:9px;margin:10px 0 18px;overscroll-behavior:contain}.scanner-scroll .tablewrap{overflow:visible}.scanner-scroll table{margin-top:0}.scanner-scroll thead th{position:sticky;top:0;background:#111d2d;z-index:2}.tsicol{white-space:nowrap;font-variant-numeric:tabular-nums}.limit-details{margin-top:9px;border-top:1px solid #293a50;padding-top:7px}.limit-details summary{cursor:pointer;color:#9fc5f5;font-size:11px}.limit-controls{display:flex;align-items:center;gap:8px;margin-top:8px}.limit-controls input{min-width:70px;flex:1;accent-color:#7db4ff}.limit-controls b{min-width:18px;text-align:center}.limit-controls .btn{padding:6px 10px}.limit-card{min-width:0}.reason-details{margin-top:6px;border-top:1px solid #2b3c50;padding-top:5px;max-width:430px}.reason-details summary{cursor:pointer;color:#9fc5f5;font-size:11px;font-weight:600}.reason-details p{margin:4px 0;font-size:10px;line-height:1.4;color:#c7d6e6}.reason-summary{max-width:260px;white-space:normal;line-height:1.4}</style></head><body><main class=\"wrap\">\n<header class=\"top\"><div><div class=\"brand\">SMC PRO <span style=\"color:#7db4ff\">V2</span></div><div class=\"muted\">MARKET INTELLIGENCE · PAPER TRADING CONTROL CENTER</div></div><div style=\"display:flex;align-items:center;gap:10px;flex-wrap:wrap\"><span class=\"tag wait\">PAPER MODE · GERÇEK EMİR KAPALI</span><div class=\"token\"><input id=\"controlToken\" type=\"password\" autocomplete=\"off\" placeholder=\"VST kontrol anahtarı\" aria-label=\"VST kontrol anahtarı\"></div><span id=\"conn\" class=\"statusline muted\">Motor ve tarayıcı kontrol ediliyor</span><button id=\"refresh\" class=\"btn\">↻ Yenile</button></div></header>\n<section id=\"accountSummary\" class=\"stats summary\"><div class=\"empty\">Demo hesap verileri yükleniyor…</div></section><section class=\"engines\"><div class=\"engine\"><b>Scalp Engine</b><b id=\"se\" class=\"warn\">Kontrol ediliyor</b></div><div class=\"engine\"><b>Swing Engine</b><b id=\"we\" class=\"warn\">Kontrol ediliyor</b></div></section>\n<nav id=\"tabs\" class=\"tabs\"></nav><section class=\"panel\"><div class=\"head\"><h2 id=\"heading\">Market Overview</h2><span id=\"updated\" class=\"muted\"></span></div><div id=\"content\"><div class=\"empty\">Veriler yükleniyor…</div></div></section><p class=\"note\">Paper ledger ve BingX piyasa verileri gösterilir. Scalp ve Swing motorları bağımsız sinyal üretir; gerçek emirler kilitlidir.</p></main>\n<div id=\"modal\" class=\"modal\"><div class=\"box\"><h3 id=\"mt\">Pozisyonu kapat</h3><p class=\"muted\">Kapatılacak pozisyon yüzdesini seçin.</p><input id=\"pct\" type=\"range\" min=\"1\" max=\"100\" value=\"50\"><b id=\"pl\">%50 kapat</b><div class=\"end\"><button class=\"btn\" id=\"cancel\">Vazgeç</button><button class=\"btn close\" id=\"confirm\">Kapatmayı onayla</button></div></div></div>\n<script>\nconst T=['Market Overview','Açık İşlemler','Scalp Scanner','Swing Scanner','Positions','Statistics','Candidates (İşlem Adayları)','Trade History','Diagnostics','Grafik'];let tab=0,health=null,analytics=null,status=null,live=null,systemHealth=null,archiveHealth=null,historyHealth=null,cloudflareUsage=null,tickerData=null,universeData=null,globalContext=null,token='',chosen=null,symbol='BTCUSDT';const $=x=>document.getElementById(x),A=x=>Array.isArray(x)?x:[],N=x=>x==null||x===''?'—':Number(x).toLocaleString('tr-TR',{maximumFractionDigits:5}),E=x=>String(x??'').replace(/[&<>']/g,c=>c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&#39;').replaceAll(String.fromCharCode(34),'&quot;');$('controlToken').oninput=e=>token=e.target.value.trim();\nfunction ps(){return A(status&&status.positions).length?A(status.positions):A(live&&live.positions)}function setups(){let x=A(health&&health.setups);return x.length?x:A(status&&status.setups)}function candidates(){return setups().filter(x=>!['INVALIDATED','EXPIRED','REJECTED','CLOSED','OPENED'].includes(String(x.status||'').toUpperCase()))}\nfunction setupName(p){const m={S01_SWEEP_MSS_FVG:\"Likidite süpürmesi + MSS + FVG\",S02_BREAKER_RETEST:\"Breaker retest\",S03_BOS_DISPLACEMENT:\"BOS + displacement\",S04_RANGE_DEVIATION:\"Range deviation\",S05_FAILED_BREAKOUT:\"Başarısız kırılım\",S06_OB_REACTION:\"Order block tepkisi\",W01_HTF_OB_REVERSAL:\"HTF Order Block dönüşü\",W02_SUPPLY_DEMAND_REVERSAL:\"Supply Demand dönüşü\",W03_SWEEP_CHOCH:\"Sweep + CHoCH\",W04_BREAKER_RETEST:\"Breaker retest\",W05_RANGE_DEVIATION:\"Range deviation\",W06_CRT:\"CRT\",W07_OTE:\"OTE geri çekilmesi\",W08_BOS_CONTINUATION:\"BOS devam\"};return m[p.model]||p.model||\"Setup\";}\nfunction why(p){if(p.status===\"OPEN\")return p.openReasonTr||p.openReason||p.reason||\"Pozisyon açık\";return p.executionDecisionReason||p.reason||setupName(p);}\nfunction reasonDetails(p){const a=p.audit||{},z=a.zone||{},e=a.structureEvent||{},rows=[[\"Setup türü\",setupName(p)],[\"Motor ve yön\",String(p.tradeStyle||a.engine||\"UNAVAILABLE\")+\" / \"+String(p.side||\"UNAVAILABLE\")],[\"Setup zaman dilimi\",p.setupTimeframe],[\"Bölge zaman dilimi\",z.sourceTimeframe],[\"Giriş zaman dilimi\",p.entryTimeframe],[\"Üst zaman yönü\",a.htfTrend],[\"Üst zaman uyumu\",a.htfAligned],[\"Piyasa rejimi\",a.marketRegime],[\"Yapısal olay\",e.type],[\"Yapısal seviye\",e.level],[\"Displacement\",e.displacement],[\"Bölge\",z.kind],[\"Bölge alt sınır\",z.bottom],[\"Bölge üst sınır\",z.top],[\"Karar\",p.status],[\"Karar nedeni\",p.executionDecisionReason||why(p)],[\"Giriş\",p.entry],[\"Stop\",p.stopLoss],[\"Hedef\",p.takeProfit],[\"Güven durumu\",a.confidenceStatus||p.confidenceStatus],[\"Güven örneklemi\",a.confidenceSampleSize]];return '<details class=\"reason-details\"><summary>Analiz ve karar ayrıntısı</summary>'+rows.map(x=>'<p><b>'+E(x[0])+':</b> '+E(x[1]===null||x[1]===undefined?\"UNAVAILABLE\":String(x[1]))+'</p>').join(\"\")+'</details>';}\n\nfunction tf(p){return String(p.setupTimeframe||p.setupSourceTimeframe||'—').toUpperCase()+' kurulum · '+String(p.entryTimeframe||'—').toUpperCase()+' giriş'}\nfunction scale(p){let v=Number(p.markPrice??p.currentPrice),s=Number(p.stopLoss),t=Number(p.tp3??p.takeProfit??p.tp2);if(![v,s,t].every(Number.isFinite)||v<=0||s<=0||t<=0||s===t)return{pos:50,t1:null,t2:null,t3:null,sd:'—',td:'—'};let f=x=>{let n=Number(x);if(!Number.isFinite(n)||n<=0)return null;return Math.max(0,Math.min(100,p.side==='LONG'?(n-s)/(t-s)*100:(s-n)/(s-t)*100))};return{pos:f(v)??50,t1:f(p.tp1),t2:f(p.tp2),t3:f(p.tp3??p.takeProfit??p.tp2),sd:(Math.abs(v-s)/v*100).toFixed(2)+'%',td:(Math.abs(t-v)/v*100).toFixed(2)+'%'}}\nfunction renderTabs(){$('tabs').innerHTML=T.map((x,i)=>'<button class=\"'+(i===tab?'active':'')+'\" data-t=\"'+i+'\">'+x+'</button>').join('');document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{tab=+b.dataset.t;renderTabs();draw()})}\nfunction tickerPrice(symbol){\n const root=tickerData?.data??tickerData, key=String(symbol||\"\").toUpperCase().replace(/[^A-Z0-9]/g,\"\");\n const rows=Array.isArray(root)?root:Array.isArray(root?.tickers)?root.tickers:Array.isArray(root?.data)?root.data:[root];\n const item=rows.find(x=>String(x?.symbol||x?.s||\"\").toUpperCase().replace(/[^A-Z0-9]/g,\"\")===key)||root?.[symbol]||root?.[key];\n const value=item?.lastPrice??item?.last??item?.price??item?.close??item?.markPrice??item?.last_price;\n const n=Number(value);return Number.isFinite(n)&&n>0?n:null;\n}\nfunction positionMark(p){const live=tickerPrice(p.symbol);if(Number.isFinite(live)&&live>0)return live;const mark=Number(p.markPrice??p.currentPrice);return Number.isFinite(mark)&&mark>0?mark:null}\nfunction positionPnl(p){const mark=positionMark(p),entry=Number(p.entry),qty=Number(p.qty);if(mark!==null&&Number.isFinite(entry)&&entry>0&&Number.isFinite(qty)&&qty>0){const feeRate=Number.isFinite(Number(p.feeRate))?Math.max(0,Number(p.feeRate)):0.0005;const gross=(p.side===\"LONG\"?mark-entry:entry-mark)*qty;return gross-qty*mark*(feeRate+0.0002)}const v=Number(p.unrealizedPnlUsdt);return p.unrealizedPnlUsdt!=null&&Number.isFinite(v)?v:null}\nfunction positionRoi(p){const pnl=positionPnl(p),margin=Number(p.marginUsdt??p.initialMarginUsdt);return pnl!==null&&Number.isFinite(margin)&&margin>0?pnl/margin*100:null}\nfunction positionPnlLabel(p){const pnl=positionPnl(p),roi=positionRoi(p);if(pnl===null)return \"Veri yok\";const fmt=x=>x.toLocaleString(\"tr-TR\",{minimumFractionDigits:2,maximumFractionDigits:2});return (pnl>=0?\"+\":\"\")+fmt(pnl)+\" USDT\"+(roi===null?\"\":\" · \"+(roi>=0?\"+\":\"\")+fmt(roi)+\"%\")}\nfunction table(rows,kind){\n  if(!rows.length)return '<div class=\"empty\">Bulunan setup veya pozisyon yok.</div>';\n  const now=new Intl.DateTimeFormat(\"tr-TR\",{timeZone:\"Europe/Istanbul\",dateStyle:\"short\",timeStyle:\"medium\"}).format(new Date());\n  return '<div class=\"scanner-scroll\"><div class=\"tablewrap\"><table><thead><tr><th>Parite</th><th>Yön</th><th>Anlık fiyat</th>'+(kind===\"pos\"?'<th>Kaldıraç</th><th>Anlık K/Z · ROI</th>':\"\")+'<th>Skor / Güven</th><th>Giriş</th><th>TP</th><th>SL</th><th>Ready / Wait</th><th>İşlem gerekçesi</th>'+(kind===\"pos\"?'<th>İşlem</th>':\"\")+'<th>TSİ · Tarih / Saat</th></tr></thead><tbody>'+rows.map(p=>{\n   const ready=[\"READY\",\"QUALIFIED\",\"OPEN\",\"HIGH_QUALITY\"].includes(String(p.status||\"\").toUpperCase()),price=positionMark(p),pnl=positionPnl(p),lev=Number(p.leverage??p.effectiveLeverage);\n   return '<tr><td class=\"sym\">'+E(p.symbol)+'</td><td class=\"'+(p.side===\"LONG\"?\"long\":\"short\")+'\">'+E(p.side)+'</td><td>'+N(price)+'</td>'+(kind===\"pos\"?'<td>'+(Number.isFinite(lev)&&lev>0?lev+\"x\":\"—\")+'</td><td class=\"'+(pnl===null?\"muted\":pnl>=0?\"ok\":\"warn\")+'\">'+E(positionPnlLabel(p))+'</td>':\"\")+'<td>'+N(p.score)+' / '+(p.confidence==null?\"Veri yetersiz\":N(p.confidence)+\"%\")+'</td><td>'+N(p.entry)+'</td><td>'+N(p.takeProfit??p.tp2??p.tp3)+'</td><td>'+N(p.stopLoss)+'</td><td><span class=\"tag '+(ready?\"ready\":\"wait\")+'\">'+E(kind===\"pos\"?\"OPEN\":ready?\"READY\":\"WAIT\")+'</span></td><td class=\"why\"><div class=\"reason-summary\">'+E(why(p))+'</div>'+reasonDetails(p)+'</td>'+(kind===\"pos\"?'<td><button class=\"btn small close\" data-close=\"'+E(p.id||p.symbol+\"-\"+p.side)+'\">Kapat</button></td>':\"\")+'<td class=\"tsicol\">'+E(now)+'</td></tr>';\n  }).join(\"\")+'</tbody></table></div></div>';\n }\nfunction cards(){if(!ps().length)return '';return '<div class=\"cards\">'+ps().map(p=>{let q=scale(p),lev=Number(p.leverage??p.effectiveLeverage),pnl=positionPnl(p);return '<article class=\"pc\"><div class=\"pchead\"><div><div class=\"pcname\">'+E(p.symbol)+' <span class=\"'+(p.side==='LONG'?'long':'short')+'\">'+E(p.side)+'</span></div><div class=\"muted\">'+E(p.tradeStyle||p.model||'')+' · '+E(tf(p))+'</div></div><div class=\"actions\"><button class=\"btn small chartbtn\" data-chart=\"'+E(p.symbol)+'\">Grafik</button><button class=\"btn small close\" data-close=\"'+E(p.id||p.symbol+'-'+p.side)+'\">Kapat</button></div></div><div class=\"details\"><div><small>Anlık fiyat</small><b>'+N(positionMark(p))+'</b></div><div><small>Giriş</small><b>'+N(p.entry)+'</b></div><div><small>TP / SL</small><b>'+N(p.takeProfit??p.tp2)+' / '+N(p.stopLoss)+'</b></div><div><small>Kaldıraç</small><b>'+(Number.isFinite(lev)&&lev>0?lev+'x':'—')+'</b></div><div><small>Anlık K/Z · ROI</small><b class=\"'+(pnl===null?'muted':pnl>=0?'ok':'warn')+'\">'+E(positionPnlLabel(p))+'</b></div><div><small>Kurulum / giriş TF</small><b>'+E(tf(p))+'</b></div><div><small>Yapısal yapı</small><b>'+E(p.structureType||p.structure||p.pattern||p.model||'—')+'</b></div><div><small>Skor</small><b>'+N(p.score)+'</b></div><div><small>Güven</small><b>'+(p.confidence==null?'Veri yetersiz':N(p.confidence)+'%')+'</b></div></div><div class=\"reason\"><b>İşlem gerekçesi:</b> '+E(why(p))+'</div><div class=\"scalehead\"><span>Stop mesafesi '+q.sd+'</span><span>Hedef mesafesi '+q.td+'</span></div><div class=\"scale\">'+(q.t1==null?'':'<i class=\"tpmark\" style=\"left:'+q.t1+'%\"></i>')+(q.t2==null?'':'<i class=\"tpmark\" style=\"left:'+q.t2+'%\"></i>')+(q.t3==null?'':'<i class=\"tpmark\" style=\"left:'+q.t3+'%\"></i>')+'<i class=\"needle\" style=\"left:'+q.pos+'%\"></i></div><div class=\"scalefoot\"><span>STOP</span><span>ANLIK FİYAT</span><span>TP1</span><span>TP2</span><span>TP3</span></div></article>'}).join('')+'</div>'}\nfunction historyTable(rows){if(!rows.length)return '<div class=\"empty\">Henüz kapanmış paper işlem yok.</div>';return '<div class=\"tablewrap\"><table><thead><tr><th>Açılış</th><th>Kapanış</th><th>Parite</th><th>Motor / Setup</th><th>Yön</th><th>Giriş</th><th>Çıkış</th><th>Net PnL</th><th>Getiri %</th><th>Yapısal gerekçe</th><th>Setup TF</th><th>Giriş TF</th><th>Kapanış nedeni</th></tr></thead><tbody>'+rows.slice().sort((a,b)=>Number(b.closedAt||0)-Number(a.closedAt||0)).map(p=>'<tr><td>'+E(p.openedAt?new Date(p.openedAt).toLocaleString('tr-TR'):'—')+'</td><td>'+E(p.closedAt?new Date(p.closedAt).toLocaleString('tr-TR'):'—')+'</td><td class=\"sym\">'+E(p.symbol)+'</td><td>'+E(p.tradeStyle||p.engine||p.model||'—')+'</td><td>'+E(p.side)+'</td><td>'+N(p.entry)+'</td><td>'+N(p.exitPrice)+'</td><td>'+N(p.pnlUsdt)+' USDT</td><td>'+N(p.returnPct??p.pnlPct??p.roiPct)+'%</td><td class=\"why\">'+E(p.setupReason||p.openReasonTr||p.reasonTr||p.structureType||p.model||'—')+'</td><td>'+E(p.setupTimeframe||p.setupSourceTimeframe||'—')+'</td><td>'+E(p.entryTimeframe||'—')+'</td><td>'+E(p.closeReason||'—')+'</td></tr>').join('')+'</tbody></table></div>'}function val(x){return x===null||x===undefined||x===''?'—':N(x)}function metric(label,value,sub=''){return '<div class=\"metric\"><small>'+E(label)+'</small><b>'+E(value)+'</b>'+(sub?'<div class=\"muted\">'+E(sub)+'</div>':'')+'</div>'}function healthLine(label,value,ok){return '<div class=\"healthline\"><span>'+E(label)+'</span><b class=\"'+(ok===true?'ok':ok===false?'warn':'muted')+'\">'+E(value)+'</b></div>'}function accountSummary(){\n let h=health||{},p=ps(),open=Number(h.unrealizedProfit),real=h.realisedProfit==null?null:Number(h.realisedProfit),today=h.dailyPnl==null?null:Number(h.dailyPnl),max=Math.max(0,Math.min(10,Number(h.maxOpenPositions??10))),hasOpen=h.unrealizedProfit!==null&&h.unrealizedProfit!==undefined&&Number.isFinite(open),total=real===null?null:real+(hasOpen?open:0),money=x=>x===null||x===undefined||!Number.isFinite(Number(x))?'Veri alınamadı':N(Number(x))+' USDT',run=h.runnerEnabled===true&&h.alarmScheduled===true&&h.scannerPaused!==true&&h.automationStopped!==true&&!h.storageDegraded,realLine=real===null?'Gerçekleşen PnL yok':'Gerçekleşen '+money(real),openLine=hasOpen?'Açık '+money(open):'Açık PnL verisi yok',clock=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());\n $('accountSummary').innerHTML='<div class=\"stat\"><small>MOTOR DURUMU · RUNNER</small><div class=\"num '+(run?'ok':'warn')+'\">'+(run?'ÇALIŞIYOR':'KONTROL')+'</div><div class=\"sub\">Scalp + Swing · PAPER MODE · gerçek emir kilitli</div></div><div class=\"stat\"><small>PAPER HESAP BAKİYESİ · USDT</small><div class=\"num\">'+money(h.balance)+'</div><div class=\"sub\">Paper equity: '+money(h.equity)+' · Kullanılabilir marjin: '+money(h.availableMargin)+'</div></div><div class=\"stat\"><small>TOPLAM KÂR / ZARAR · TOTAL PnL</small><div class=\"num\">'+(total===null?realLine:money(total))+'</div><div class=\"sub\">'+realLine+' · '+openLine+'</div></div><div class=\"stat\"><small>AÇIK POZİSYON ANLIK K/Z · LIVE PnL</small><div class=\"num '+(hasOpen?(open>=0?'ok':'short'):'')+'\">'+money(hasOpen?open:null)+'</div><div class=\"sub\">'+p.length+' açık pozisyon · marjin getirisi pozisyon detaylarında</div></div><div class=\"stat\"><small>GÜNLÜK KÂR / ZARAR · TODAY PnL</small><div class=\"num '+(today===null?'':today>=0?'ok':'short')+'\">'+money(today)+'</div><div class=\"sub\">TSİ · '+clock+'</div></div><div class=\"stat limit-card\"><small>MAKS. AÇIK POZİSYON</small><div class=\"num\">'+p.length+' / '+max+'</div><div class=\"sub\">Pozisyon yönetimi · en fazla '+max+' açık işlem · BingX VST paper</div><details class=\"limit-details\"><summary>Limit ayarını aç / kapat</summary><div class=\"limit-controls\"><input id=\"maxPositions\" type=\"range\" min=\"0\" max=\"10\" step=\"1\" value=\"'+max+'\"><b id=\"maxPositionsValue\">'+max+'</b><button id=\"saveMaxPositions\" class=\"btn small\">Kaydet</button></div><div id=\"maxPositionsStatus\" class=\"muted\">0–10 açık pozisyon sınırı</div></details></div>';\n const slider=$('maxPositions'),value=$('maxPositionsValue'),save=$('saveMaxPositions'),note=$('maxPositionsStatus');\n if(slider)slider.oninput=()=>{value.textContent=slider.value};\n if(save)save.onclick=async()=>{try{save.disabled=true;note.textContent='Kaydediliyor…';const result=await get('/api/paper/settings',{method:'POST',headers:{'content-type':'application/json','authorization':token?'Bearer '+token:''},body:JSON.stringify({maxOpenPositions:Number(slider.value)})});note.textContent=result.ok?'Kaydedildi · Maksimum '+result.maxOpenPositions+' pozisyon':'Kaydetme başarısız';await load()}catch(e){note.textContent='Kaydedilemedi: '+e.message}finally{save.disabled=false}};\n}\nfunction overview(){\n const h=health||{},u=cloudflareUsage||{},tick=tickerData||{},gc=globalContext||{};\n const positions=ps(),setups=candidates(),sc=setups.filter(x=>String(x.tradeStyle||x.engine||\"\").toUpperCase()===\"SCALP\").length,sw=setups.filter(x=>String(x.tradeStyle||x.engine||\"\").toUpperCase()===\"SWING\").length;\n const metric=(label,value)=>`<div class=\"metric\"><small>${E(label)}</small><b>${E(value)}</b></div>`;\n const fmt=value=>value===null||value===undefined||value===\"\"?\"UNAVAILABLE\":N(value);\n const rows=[[\"BTC\",\"BTC-USDT\"],[\"ETH\",\"ETH-USDT\"],[\"SOL\",\"SOL-USDT\"],[\"BNB\",\"BNB-USDT\"],[\"XRP\",\"XRP-USDT\"]];\n const market=rows.map(([label,symbol])=>{const list=Array.isArray(tick)?tick:(tick.data||tick.result||[]);const item=list.find(x=>String(x.symbol||\"\").toUpperCase()===symbol);return metric(label,item?(fmt(item.lastPrice??item.last??item.close??item.price)+\" USDT\"):\"UNAVAILABLE\")}).join(\"\");\n return `<h3>Piyasa özeti</h3><div class=\"grid\">${market}</div><h3>Motor ve tarama durumu</h3><div class=\"grid\">${metric(\"Scalp Engine\",h.scannerActive===true&&h.runnerEnabled===true?\"ACTIVE\":\"CHECK\")}${metric(\"Swing Engine\",h.scannerActive===true&&h.runnerEnabled===true?\"ACTIVE\":\"CHECK\")}${metric(\"Açık pozisyon\",String(positions.length))}${metric(\"Scalp aday\",String(sc))}${metric(\"Swing aday\",String(sw))}${metric(\"Tarama evreni\",fmt(h.scanUniverseSize))}${metric(\"Son tarama\",h.lastScanAt?new Date(h.lastScanAt).toLocaleString(\"tr-TR\"):\"UNAVAILABLE\")}${metric(\"Cloudflare Workers isteği\",fmt(u.workersRequests))}</div><p class=\"note\">Eksik piyasa ve kullanım verileri UNAVAILABLE olarak gösterilir; tahmini değer üretilmez.</p>`;\n}function stats(style){let a=analytics||{},groups=A(a.byStyle),x=groups.find(v=>String(v.key||'').toUpperCase()===String(style).toUpperCase())||{},fmt=v=>v==null?'—':N(v),rows=[['İşlem',x.trades],['Kazanma oranı',x.winRatePct==null?'—':Number(x.winRatePct).toFixed(1)+'%'],['Profit Factor',fmt(x.profitFactor)],['Beklenti',x.expectancyUsdt==null?'—':N(x.expectancyUsdt)+' USDT'],['Net PnL',x.netPnlUsdt==null?'—':N(x.netPnlUsdt)+' USDT'],['Bilinen ücret',x.feesKnownUsdt==null?'—':N(x.feesKnownUsdt)+' USDT'],['Net fonlama',x.fundingPaidUsdt==null?'—':N(x.fundingPaidUsdt)+' USDT'],['Slippage',x.slippagePaidUsdt==null?'—':N(x.slippagePaidUsdt)+' USDT']];return '<h3>'+E(style)+' performansı</h3><div class=\"grid\">'+rows.map(v=>'<div class=\"metric\"><small>'+v[0]+'</small><b>'+v[1]+'</b></div>').join('')+'</div><p class=\"note\">Bu rapor yalnızca '+E(style)+' işlemlerini içerir. Scalp ve Swing istatistikleri birleştirilmez. Yetersiz örneklemde metrikler boş gösterilir.</p>'}\nfunction diag(){let f=candidates(),run=!!(health&&health.scannerActive===true&&health.runnerEnabled===true);return '<div class=\"grid\"><div class=\"metric\"><small>Tarayıcı / Runner</small><b>'+(run?'Aktif':'Kontrol gerekli')+'</b></div><div class=\"metric\"><small>Otomasyon kilidi</small><b>'+(health&&health.automationStopped?'Durduruldu':'Aktif değil')+'</b></div><div class=\"metric\"><small>BingX VST demo</small><b>'+(health&&health.demoConnected?'Bağlı':'Doğrulanamadı')+'</b></div><div class=\"metric\"><small>Depolama</small><b>'+(health&&health.storageDegraded?'Sorun var':'Durum normal / doğrulanıyor')+'</b></div><div class=\"metric\"><small>Tarama paketi</small><b>'+N(health&&health.scanBatchSize)+' / '+N(health&&health.scanUniverseSize)+'</b></div><div class=\"metric\"><small>Son tarama</small><b>'+(health&&health.lastScanAt?new Date(health.lastScanAt).toLocaleString('tr-TR'):'Henüz yok')+'</b></div></div><h3>Bulunan setup kayıtları</h3>'+table(f,'setup')+'<p class=\"note\">Boş model/zaman dilimi retleri listelenmez. Altyapı ve veri sağlığı uyarıları yukarıda tutulur.</p>'}function chartPanel(){let tv=String(symbol||'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g,'').replace('.P','');let tvSymbol='BINGX:'+tv+'.P';let src='https://www.tradingview.com/widgetembed/?symbol='+encodeURIComponent(tvSymbol)+'&interval=60&hidesidetoolbar=0&symboledit=0&saveimage=0&toolbarbg=08111f&theme=dark&style=1&timezone=Etc%2FUTC&withdateranges=1&hideideas=1&locale=tr';return '<div class=\\\"note\\\">TradingView · '+E(tvSymbol)+' · 1 saatlik BingX perpetual grafik</div><iframe id=\\\"tvchart\\\" class=\\\"chart\\\" data-symbol=\\\"'+E(tvSymbol)+'\\\" src=\\\"'+src+'\\\" allowfullscreen></iframe>';}function openChart(pair){symbol=String(pair||'BTCUSDT');tab=9;renderTabs();draw()}\nfunction calendarPanel(){return '<h3>Günlük işlem takvimi</h3><div class=\"note\">Tarih seçerek o gün kapanan işlemleri görüntüleyin. Saatler Türkiye saatidir.</div><label for=\"trade-day\">İşlem günü</label> <input id=\"trade-day\" type=\"date\"><div id=\"day-result\" class=\"empty\">Gün seçin.</div>'}\nfunction draw(){let p=ps(),c=candidates(),style=x=>String(x.tradeStyle||x.engine||'').toUpperCase(),sc=c.filter(x=>style(x)==='SCALP'||String(x.model||'').startsWith('S')),sw=c.filter(x=>style(x)==='SWING'||String(x.model||'').startsWith('W')),ready=x=>['READY','QUALIFIED','HIGH_QUALITY'].includes(String(x.status||'').toUpperCase());$('heading').textContent=T[tab];$('updated').textContent='Güncelleme '+new Date().toLocaleTimeString('tr-TR');if(tab===9){let old=$('content').querySelector('#tvchart'),tv=String(symbol||'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g,'');if(old&&old.dataset.symbol===tv)return}let h='';if(tab===0)h=overview();else if(tab===1)h=table(p,'pos')+cards();else if(tab===2)h='<h3>Scalp Scanner · 1H / 15M / 5M</h3>'+table(sc,'setup');else if(tab===3)h='<h3>Swing Scanner · 1D / 4H / 1H / 15M</h3>'+table(sw,'setup');else if(tab===4)h=table(p,'pos')+cards();else if(tab===5)h=stats('SCALP')+stats('SWING')+calendarPanel();else if(tab===6)h=table(c.filter(ready),'setup');else if(tab===7)h=historyTable(A(status&&status.closedTrades));else if(tab===8)h=diag();else h=chartPanel();$('content').innerHTML=h;document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>openClose(b.dataset.close));document.querySelectorAll('[data-chart]').forEach(b=>b.onclick=()=>openChart(b.dataset.chart));let day=$('trade-day');if(day){day.value=new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});let renderDay=()=>{let key=day.value,rows=A(status&&status.closedTrades).filter(t=>t.closedAt&&new Date(t.closedAt).toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'})===key),total=rows.reduce((n,t)=>n+Number(t.pnlUsdt||0),0);$('day-result').className='';$('day-result').innerHTML='<div class=\\\"note\\\">'+rows.length+' kapanan işlem · Günlük net sonuç: '+N(total)+' USDT</div>'+historyTable(rows)};day.onchange=renderDay;renderDay()}}async function get(path,opts){let r=await fetch(path,opts||{}),d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'HTTP '+r.status);return d}\nasync function load(){try{let d=await get('/api/data',{signal:AbortSignal.timeout(18000)});health=d.health;systemHealth=d.systemHealth;analytics=d.analytics;archiveHealth=d.archiveHealth;historyHealth=d.historyHealth;cloudflareUsage=d.cloudflareUsage;tickerData=d.tickerData;universeData=d.universeData;globalContext=d.globalContext;status=health?{...health,positions:A(health.positions),setups:A(health.setups),closedTrades:A(health.closedTrades)}:null;live={positions:A(health&&health.positions)};if(status){$('conn').textContent='Paper işlem modu aktif';$('conn').className='ok'}else{$('conn').textContent='Paper hesap verisi alınamadı';$('conn').className='warn'}let run=health&&health.runnerEnabled===true&&health.alarmScheduled===true&&health.scannerPaused!==true&&health.automationStopped!==true&&!health.storageDegraded;$('conn').textContent=run?'Motor ve tarayıcı aktif':'Motor / tarayıcı kontrol gerekli';$('conn').className=run?'ok':'warn';$('se').textContent=run?'ACTIVE':'CHECK';$('we').textContent=run?'ACTIVE':'CHECK';$('se').className=run?'ok':'warn';$('we').className=run?'ok':'warn';accountSummary();draw()}catch(e){$('conn').textContent='API hatası: '+e.message;$('conn').className='warn';$('accountSummary').innerHTML='<div class=\"empty\">Paper hesap verisi alınamadı: '+E(e.message)+'</div>';$('content').innerHTML='<div class=\"empty\">Veri alınamadı: '+E(e.message)+'</div>'}}\nfunction openClose(id){chosen=id;$('mt').textContent=id+' pozisyonunu kapat';$('pct').value=50;$('pl').textContent='%50 kapat';$('modal').classList.add('show')}\n$('pct').oninput=()=>$('pl').textContent='%'+$('pct').value+' kapat';$('cancel').onclick=()=>$('modal').classList.remove('show');\n$('confirm').onclick=async()=>{let fraction=Number($('pct').value)/100;if(!confirm('%'+Math.round(fraction*100)+' pozisyon kapatılacak. Onaylıyor musunuz?'))return;try{$('confirm').disabled=true;let r=await get('/api/close',{method:'POST',headers:{'content-type':'application/json','authorization':token?'Bearer '+token:''},body:JSON.stringify({positionId:chosen,fraction,confirmedByUser:true})});$('modal').classList.remove('show');alert(r.ok?'Kapatma isteği işlendi. Pozisyon durumu yenileniyor.':r.error||'Kapatma başarısız');await load()}catch(e){alert('Kapatma başarısız: '+e.message)}finally{$('confirm').disabled=false}};renderTabs();load();</script></body></html>";
async function ensureInternalPaperAccount(engine, env) {
  if (env.BINGX_TRADING_MODE !== "paper" || env.PAPER_TRADING_ONLY !== "true") return { ok: true, skipped: true };
  const stateResponse = await engine.fetch(new Request("https://engine.internal/state"));
  if (!stateResponse.ok) throw new Error("Could not read canonical Durable Object paper state: HTTP " + stateResponse.status);
  const state = await stateResponse.json();
  const ledger = state?.paperLedger;
  if (ledger && Number.isFinite(Number(ledger.balance)) && Number(ledger.balance) > 0) return { ok: true, initialized: false, preservedExistingLedger: true, balance: Number(ledger.balance) };
  if (typeof state?.paperBalanceUsdt === "number" && Number.isFinite(state.paperBalanceUsdt) && state.paperBalanceUsdt > 0) return { ok: true, initialized: false, preservedLegacyLedger: true, balance: state.paperBalanceUsdt };
  if (ledger || (Array.isArray(state?.positions) && state.positions.length) || (Array.isArray(state?.closedTrades) && state.closedTrades.length)) throw new Error("Existing paper records were detected without a verifiable balance; automatic reset is disabled.");
  throw new Error("Canonical internal paper ledger is missing; automatic account creation is disabled to protect existing capital and trade history.");
}
class EngineStateV2 extends EngineState {
  async alarm() { console.log("EngineStateV2 alarm fired", new Date().toISOString()); return super.alarm(false); }
}
var index_default = {
  async scheduled(controller, env, _ctx) {
    if (env.BINGX_LIVE_API_KEY && env.BINGX_LIVE_API_SECRET) {
      try {
        const liveStub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
        const liveStore = new DurableObjectLiveStore({ stub: liveStub });
        const liveClient = new BingXLiveClient({ apiKey: env.BINGX_LIVE_API_KEY, apiSecret: env.BINGX_LIVE_API_SECRET });
        const liveAdapter = new BingXLiveExecutionAdapter({ env, client: liveClient, store: liveStore });
        const management = await manageLivePositions({ env, client: liveClient, store: liveStore, adapter: liveAdapter });
        console.info("BingX live position management", JSON.stringify(management));
        if (env.LIVE_TRADING_ENABLED === "true" && !AUTOMATION_STOP) {
          const stateResponse = await liveStub.fetch(new Request("https://engine.internal/paper/status"));
          const state = await stateResponse.json();
          if (stateResponse.ok && state.storageDegraded !== true && Array.isArray(state.setups)) {
            const entries = await runLiveSetupQueue({ env, setups: state.setups, client: liveClient, store: liveStore, adapter: liveAdapter, automationStopped: AUTOMATION_STOP });
            if (entries.results?.length) console.info("BingX live scanner execution", JSON.stringify(entries));
          } else console.warn("BingX live scanner execution skipped: scanner state unavailable");
        }
      } catch (error) {
        console.error("BingX live position management blocked", String(error).slice(0, 220));
      }
    }
    if (AUTOMATION_STOP) return;
    const id = env.ENGINE_STATE_V2.idFromName("main-engine");
    const engine = env.ENGINE_STATE_V2.get(id);
    if (env.BINGX_TRADING_MODE === "paper" && env.PAPER_TRADING_ONLY === "true") {
      try {
        await ensureInternalPaperAccount(engine, env);
      } catch (error) {
        console.error("Paper account initialization guard blocked scan", String(error));
        return;
      }
    }
    let wakeReady = false;
    let wakeRunnerEnabled = false;
    let scanStale = true;
    let wake = null;
    try {
      const response = await engine.fetch(new Request("https://engine.internal/scheduler/wake", { method: "POST" }));
      if (!response.ok) throw new Error("Runner scheduler wake returned HTTP " + response.status);
      wake = await response.json();
      wakeRunnerEnabled = wake.runnerEnabled === true;
      wakeReady = wakeRunnerEnabled && wake.alarmScheduled === true;
      const lastScanMs = Date.parse(wake.lastScanAt ?? "");
      scanStale = !Number.isFinite(lastScanMs) || Date.now() - lastScanMs > 3 * 60 * 1000;
      console.info("Paper runner scheduler wake", JSON.stringify({ cron: controller.cron, at: (/* @__PURE__ */ new Date()).toISOString(), ...wake, scanStale }));
    } catch (error) {
      console.error("Paper runner scheduler wake failed", String(error));
      try {
        const snapshot = await env.PAPER_STATE.get("engine-state", "json");
        wakeRunnerEnabled = snapshot?.runnerEnabled === true && snapshot?.paperLedger?.runnerEnabled === true;
      } catch (snapshotError) {
        console.error("Paper runner KV fallback check failed", String(snapshotError));
      }
    }
    if (wakeRunnerEnabled && (!wakeReady || scanStale && wake?.scanInProgress !== true)) {
      try {
        const scanResponse = await engine.fetch(new Request("https://engine.internal/paper/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
        if (!scanResponse.ok) throw new Error("Paper cron fallback scan returned HTTP " + scanResponse.status);
        const scan = await scanResponse.json();
        console.info("Paper cron fallback scan", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), lastScanAt: scan.lastScanAt ?? null, scannedSymbols: scan.scannedSymbols?.length ?? null, logicalBatchRemaining: scan.logicalBatchRemaining ?? null, error: scan.error ?? null }));
      } catch (error) {
        console.error("Paper cron fallback scan failed", String(error));
      }
    }
    if (controller.cron === "5 0 * * *") {
      try {
        const dominance = await collectDailyDominanceHistory(env);
        console.info("Daily BTC/USDT/altcoin dominance collection", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...dominance }));
      } catch (error) {
        console.error("Daily dominance collection failed", String(error));
      }
    }
    // Historical archive polling is paused so its Durable Object SQL reads cannot starve the live paper scanner.
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const dashboardHeaders = { "cache-control": "no-store" };
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(DASHBOARD_HTML, { headers: { ...dashboardHeaders, "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "OPTIONS" && (url.pathname === "/api/data" || url.pathname === "/api/close")) {
      return new Response(null, { headers: { ...dashboardHeaders, "access-control-allow-origin": url.origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" } });
    }
    if (request.method === "GET" && url.pathname === "/api/data") {
      const healthPath = env.BINGX_TRADING_MODE === "paper" ? "/api/paper/status" : "/api/demo/health";
      const paths = [healthPath, "/api/health", "/api/paper/analytics", "/api/history/archive/status", "/api/history/status", "/api/ops/cloudflare-usage", "/api/market/ticker", "/api/market/universe", "/api/market/global-context"];
      const results = await Promise.all(paths.map(async (path) => {
        try {
          const internal = new Request(new URL(path, request.url), { method: "GET", headers: request.headers });
          const controller = new AbortController();
                    const internalWithTimeout = new Request(internal, { signal: controller.signal });
                    let timeoutId;
                    try {
                      return await Promise.race([
                        (async () => {
                          const response = await index_default.fetch(internalWithTimeout, env);
                          const data = await response.json();
                          return { ok: response.ok, data };
                        })(),
                        new Promise((_, reject) => {
                          timeoutId = setTimeout(() => {
                            controller.abort();
                            reject(new Error("Dashboard data endpoint timed out after 7s"));
                          }, 7000);
                        })
                      ]);
                    } finally {
                      if (timeoutId) clearTimeout(timeoutId);
                    }
        } catch (error) {
          return { ok: false, data: { error: String(error) } };
        }
      }));
      const [h, sys, an, ar, hi, cf, tk, un, gc] = results;
      return Response.json({ health: h.data, systemHealth: sys.data, analytics: an.data, archiveHealth: ar.data, historyHealth: hi.data, cloudflareUsage: cf.data, tickerData: tk.data, universeData: un.data, globalContext: gc.data }, { headers: dashboardHeaders });
    }
    if (request.method === "POST" && url.pathname === "/api/close") {
      const browserOrigin = request.headers.get("origin") || "";
      if (browserOrigin !== url.origin) return Response.json({ ok: false, error: "Dashboard origin required." }, { status: 403, headers: dashboardHeaders });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Geçersiz istek." }, { status: 400, headers: dashboardHeaders }); }
      if (body.confirmedByUser !== true || !body.positionId || !(Number(body.fraction) > 0 && Number(body.fraction) <= 1)) {
        return Response.json({ ok: false, error: "Pozisyon, miktar ve kullanıcı onayı gerekli." }, { status: 400, headers: dashboardHeaders });
      }
      const headers = new Headers(request.headers);
      headers.set("origin", url.origin);
      headers.set("x-smcprov2-public-origin", url.origin);
      headers.set("content-type", "application/json");
      const internal = new Request(new URL("/api/paper/close", request.url), { method: "POST", headers, body: JSON.stringify(body) });
      return index_default.fetch(internal, env);
    }
    if (request.method === "GET" && url.pathname === "/api/demo/health" && env.BINGX_TRADING_MODE === "demo") {
      const status = await dashboardBingXDemoStatus(env);
      const data = await status.json();
      const activeSetups = filterActiveSwingSetups(data.setups);
      const activeDiagnostics = filterActiveSwingDiagnostics(data.scanDiagnostics);
      const activeTelemetry = filterActiveSwingModelTelemetry(data.modelTelemetry);
      return Response.json({
        ok: data.demoConnected === true,
        mode: "bingx-demo",
        demoConnected: data.demoConnected === true,
        paperTradingEnabled: false,
        liveTradingEnabled: false,
        demoTradingEnabled: isBingXDemoConfigured(env),
        runnerEnabled: data.runnerEnabled === true,
        scannerActive: !SCANNER_PAUSED && !AUTOMATION_STOP && data.runnerEnabled === true,
        positionManagementEnabled: true,
        automationStopped: data.automationStopped === true,
        storageDegraded: data.storageDegraded === true,
        lastScanAt: data.lastScanAt ?? null,
        strategyMode: "SCALP_SWING_INDEPENDENT",
        strategyGenerationEnabled: STRATEGY_GENERATION_ENABLED,
        newPaperEntriesEnabled: NEW_PAPER_ENTRIES_ENABLED,
        scannerPaused: SCANNER_PAUSED,
        scanUniverseSize: data.scanUniverseSize ?? 0,
        scanBatchSize: Number(data.scanBatchSize ?? 0),
        configuredScanBatchSize: PAPER_SCAN_BATCH_NORMAL,
        scannedSymbolsCount: Array.isArray(data.scannedSymbols) ? data.scannedSymbols.length : 0,
        scanCursor: Number(data.scanCursor ?? 0),
        lastScannedSymbol: typeof data.lastScannedSymbol === "string" ? data.lastScannedSymbol : null,
        scannedSymbols: Array.isArray(data.scannedSymbols) ? data.scannedSymbols : [],
        scanRotationSeenCount: Number(data.scanRotation?.seenCount ?? (Array.isArray(data.scanRotation?.seenSymbols) ? data.scanRotation.seenSymbols.length : 0)),
        scanRotationGeneration: Number(data.scanRotation?.generation ?? 0),
        scanLogicalBatchRemaining: data.scanLogicalBatchRemaining ?? null,
        positionCount: Array.isArray(data.positions) ? data.positions.length : 0,
        positions: Array.isArray(data.positions) ? data.positions : [],
        closedTrades: Array.isArray(data.closedTrades) ? data.closedTrades.slice(-500) : [],
        balance: data.balance ?? null,
        setupCount: activeSetups.length,
        readySetupCount: activeSetups.filter((setup) => setup.status === "READY").length,
        waitSetupCount: activeSetups.filter((setup) => setup.status !== "READY").length,
        scanDiagnosticsCount: activeDiagnostics.length,
        scanTelemetry: data.scanTelemetry ?? null,
        modelTelemetry: activeTelemetry ?? null,
        scanDiagnostics: activeDiagnostics.slice(0, 25).map((d) => ({
          symbol: d.symbol,
          status: d.status,
          scannedAt: d.scannedAt,
          missingCandleFrames: d.missingCandleFrames ?? [],
          timeframeDiagnostics: d.timeframeDiagnostics ?? {},
          activityMetrics: d.activityMetrics ?? null,
          activityDataStatus: d.activityDataStatus ?? null,
          candleDiagnostics: d.candleDiagnostics ?? null,
          setupDetails: Array.isArray(d.setupDetails) ? d.setupDetails.map((item) => ({
            model: item.model,
            side: item.side,
            score: item.score,
            scoreBreakdown: item.scoreBreakdown ?? null,
            confirmations: item.confirmations ?? [],
            audit: item.audit ?? null,
            status: item.status,
            reason: String(item.reason ?? "").slice(0, 320)
          })) : []
        })),
        equity: data.equity ?? null,
        availableMargin: data.availableMargin ?? null,
        positionSymbols: Array.isArray(data.positions) ? data.positions.map((p) => p.symbol) : [],
        openOrderCount: Array.isArray(data.openOrders) ? data.openOrders.length : 0,
        unprotectedPositionSymbols: Array.isArray(data.positions) ? data.positions.filter(
          (position) => !Array.isArray(data.openOrders) || !data.openOrders.some((order) => order.symbol === position.symbol && order.type === "STOP_MARKET" && order.status === "NEW")
        ).map((position) => position.symbol) : [],
        openOrderSummary: Array.isArray(data.openOrders) ? data.openOrders.slice(0, 40).map((o) => ({
          symbol: o.symbol,
          type: o.type,
          side: o.side,
          status: o.status,
          stopPrice: o.stopPrice ?? null,
          clientOrderId: o.clientOrderId ?? o.clientOrderID ?? null
        })) : [],
        recentSetupCandidates: activeSetups.slice(-20).map((setup) => ({
          symbol: setup.symbol,
          model: setup.model,
          tradeStyle: setup.tradeStyle,
          entryTimeframe: setup.entryTimeframe,
          setupTimeframe: setup.setupTimeframe,
          side: setup.side,
          score: setup.score,
          scoreBreakdown: setup.scoreBreakdown ?? null,
          confirmations: setup.confirmations ?? [],
          audit: setup.audit ?? null,
          executionDecisionCode: setup.executionDecisionCode ?? null,
          executionDecisionReason: setup.executionDecisionReason ?? null,
          executionDecisionAt: setup.executionDecisionAt ?? null,
          status: setup.status,
          reason: String(setup.reason ?? "").slice(0, 500)
        })),
        recentExecutionDecisions: Array.isArray(activeTelemetry?.recentDecisions) ? activeTelemetry.recentDecisions.slice(-20).map((d) => ({
          at: d.at,
          symbol: d.symbol,
          side: d.side,
          score: d.score,
          code: d.code,
          stage: d.stage
        })) : [],
        maxOpenPositions: Math.min(10, Math.max(0, Number(data.maxOpenPositions ?? 10))),
        error: data.demoConnected === true ? void 0 : "BingX VST demo account authentication or balance check failed."
      }, { status: status.ok ? 200 : 503, headers });
    }
    if (request.method === "GET" && env.BINGX_TRADING_MODE === "demo" && ["/api/paper/status", "/api/paper/live-pnl", "/api/demo/status"].includes(url.pathname)) {
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, mode: "bingx-demo", error: "BingX demo control token required." }, { status: 401, headers });
      return url.pathname === "/api/paper/live-pnl" ? dashboardBingXDemoLivePnl(env) : dashboardBingXDemoStatus(env);
    }
    if (request.method === "GET" && url.pathname === "/api/paper/status") {
      const id = env.ENGINE_STATE_V2.idFromName("main-engine");
      const engine = env.ENGINE_STATE_V2.get(id);
      try {
        await ensureInternalPaperAccount(engine, env);
        return await engine.fetch(new Request("https://engine.internal/paper/status"));
      } catch (error) {
        return Response.json({ ok: false, mode: "internal-paper", storageDegraded: true, runnerEnabled: false, balance: null, equity: null, positions: [], error: "Internal paper account initialization failed: " + String(error).slice(0, 220) }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    if (env.BINGX_TRADING_MODE === "demo" && request.method === "POST" && url.pathname === "/api/paper/capital-adjustment") {
      return Response.json({ ok: false, mode: "bingx-demo", error: "Paper capital adjustments are disabled. BingX VST demo balance is authoritative." }, { status: 403, headers });
    }
    if (request.method === "GET" && url.pathname === "/api/paper/analytics" && env.BINGX_TRADING_MODE === "demo") {
      const status = await dashboardBingXDemoStatus(env);
      let data = {};
      try {
        data = await status.clone().json();
      } catch {
      }
      if (!status.ok || data.ok !== true) return Response.json({ ok: false, mode: "bingx-demo", source: "BINGX_VST_PERSISTED_FILL_HISTORY", closedTrades: [], error: data.error ?? "BingX VST history is unavailable." }, { status: status.status || 503, headers: { "cache-control": "no-store" } });
      const trades = Array.isArray(data.closedTrades) ? data.closedTrades : [];
      const wins = trades.filter((x) => Number(x.pnlUsdt) > 0), losses = trades.filter((x) => Number(x.pnlUsdt) < 0);
      const grossProfit = wins.reduce((n, x) => n + Number(x.pnlUsdt), 0), grossLoss = Math.abs(losses.reduce((n, x) => n + Number(x.pnlUsdt), 0));
      return Response.json({ ok: true, mode: "bingx-demo", source: "BINGX_VST_PERSISTED_FILL_HISTORY", generatedAt: (/* @__PURE__ */ new Date()).toISOString(), closedTrades: trades, totalTrades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length * 100 : 0, realizedPnl: trades.reduce((n, x) => n + Number(x.pnlUsdt || 0), 0), grossProfit, grossLoss, profitFactor: grossLoss ? grossProfit / grossLoss : null, historyAvailable: data.closedTradesHistoryAvailable === true, historyWindowDays: data.closedTradesHistoryWindowDays ?? 90 }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/api/paper/analytics") {
      const id = env.ENGINE_STATE_V2.idFromName("main-engine");
      return env.ENGINE_STATE_V2.get(id).fetch(new Request("https://engine.internal/paper/analytics"));
    }
    if (request.method === "GET" && url.pathname === "/api/paper/live-pnl") {
      return edgeCachedGet(request, 3, () => dashboardLivePositionPnl(env));
    }
    if (request.method === "GET" && url.pathname === "/api/paper/status") {
      const id = env.ENGINE_STATE_V2.idFromName("main-engine");
      const engine = env.ENGINE_STATE_V2.get(id);
      try {
        await ensureInternalPaperAccount(engine, env);
        return await engine.fetch(new Request("https://engine.internal/paper/status"));
      } catch (error) {
        return Response.json({ ok: false, mode: "internal-paper", storageDegraded: true, runnerEnabled: false, balance: null, equity: null, positions: [], error: "Internal paper account initialization failed: " + String(error).slice(0, 220) }, { status: 503, headers: { "cache-control": "no-store" } });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/market/global-context") {
      return edgeCachedGet(request, 300, async () => Response.json(await fetchGlobalDominanceSnapshot(env), { headers: { "cache-control": "public, max-age=300" } }));
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        project: "smcprov2",
        mode: env.BINGX_TRADING_MODE === "paper" ? "internal-paper" : "bingx-demo",
        d1Enabled: false,
        workerApi: "available",
        paperTradingEnabled: env.BINGX_TRADING_MODE === "paper" && env.PAPER_TRADING_ONLY === "true",
        demoTradingConfigured: isBingXDemoConfigured(env),
        liveTradingEnabled: false,
        strategyMode: "SCALP_SWING_INDEPENDENT",
        serverTime: (/* @__PURE__ */ new Date()).toISOString(),
        storageHealth: "reported-separately"
      }, { headers: { ...headers, "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/api/ops/cloudflare-usage") {
      return edgeCachedGet(request, 300, () => cloudflareAccountUsage(env));
    }
    if (request.method === "GET" && ["/api/history/status", "/api/history/archive/status"].includes(url.pathname)) {
      return edgeCachedGet(request, 300, async () => {
        const archive = url.pathname === "/api/history/archive/status";
        const fallback = archive ? { ok: true, storageDegraded: true, processingEnabled: false, archive: { symbols: 0, active: 0, fetched: 0, lastFetch: null }, archiveSample: [], automationStopped: AUTOMATION_STOP, alarmScheduled: false, sqlReads: 0, bounded: true, note: "History summary is unavailable while legacy-ledger recovery is pending; no archive job was started." } : { ok: true, storageDegraded: true, processingEnabled: false, tasks: [], taskCounts: null, storedCandles: null, candleSymbols: null, latestCandle: null, latestSample: [], automationStopped: AUTOMATION_STOP, alarmScheduled: false, sqlReads: 0, bounded: true, note: "History summary is unavailable while legacy-ledger recovery is pending; no archive job was started." };
        try {
          if (await readEnginePaperState(env, "state-recovery-notice")) return Response.json(fallback, { headers });
        } catch {
          return Response.json(fallback, { headers });
        }
        const target = archive ? "/history/archive/status" : "/history/status";
        try {
          const id = env.ENGINE_STATE_V2.idFromName("main-engine");
          return await env.ENGINE_STATE_V2.get(id).fetch(new Request("https://engine.internal" + target));
        } catch {
          return Response.json(fallback, { headers });
        }
      });
    }
    if (AUTOMATION_STOP && request.method === "GET" && ["/api/market/contracts", "/api/market/ticker", "/api/market/klines", "/api/history/candles"].includes(url.pathname)) {
      return Response.json({
        ok: false,
        automationStopped: true,
        manualResumeRequired: true,
        error: "BingX market-data requests are disabled by the emergency stop."
      }, { status: 503, headers });
    }
    if (url.pathname === "/api/live/status" && request.method === "GET") {
      const readiness = getLiveReadiness(env);
      const blockers = [...readiness.blockers];
      const runtimeChecks = [];
      let activation = { active: false, id: null };
      try {
        if (env.ENGINE_STATE_V2) {
          const activationStub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
          activation = await new DurableObjectLiveStore({ stub: activationStub }).getActivation();
        }
      } catch { blockers.push("LIVE_ACTIVATION_STATE_UNAVAILABLE"); }
      if (!env.ENGINE_STATE_V2) blockers.push("LIVE_DURABLE_OBJECT_BINDING_MISSING");
      if (readiness.apiCredentialsConfigured && readiness.demoCredentialsIndependent) {
        try {
          const client = new BingXLiveClient({ apiKey: env.BINGX_LIVE_API_KEY, apiSecret: env.BINGX_LIVE_API_SECRET });
          const [account, hedgeMode, positions, orders] = await Promise.all([
            client.getAccountSnapshot(), client.getPositionMode(), client.getOpenPositions(), client.getOpenOrders()
          ]);
          runtimeChecks.push({ name: "LIVE_PRIVATE_API", passed: account?.source === "BINGX_LIVE" && account.asset === "USDT" });
          runtimeChecks.push({ name: "LIVE_HEDGE_MODE", passed: hedgeMode === true });
          runtimeChecks.push({ name: "LIVE_POSITION_SNAPSHOT", passed: Array.isArray(positions) });
          runtimeChecks.push({ name: "LIVE_OPEN_ORDER_SNAPSHOT", passed: Array.isArray(orders) });
          if (hedgeMode !== true) blockers.push("LIVE_HEDGE_MODE_REQUIRED");
          if (!Array.isArray(positions) || positions.length > 10) blockers.push("LIVE_POSITION_SNAPSHOT_INVALID_OR_OVER_LIMIT");
          if (positions.some(position => position.isolated !== true && String(position.marginType ?? "").toUpperCase() !== "ISOLATED"))
            blockers.push("EXISTING_LIVE_POSITION_NOT_ISOLATED");
        } catch (error) {
          runtimeChecks.push({ name: "LIVE_PRIVATE_API", passed: false, error: String(error).slice(0, 180) });
          blockers.push("LIVE_PRIVATE_API_OR_ACCOUNT_CHECK_FAILED");
        }
      }
      return Response.json({
        ok: true, mode: "live-readiness", ready: blockers.length === 0,
        liveTradingEnabled: env.LIVE_TRADING_ENABLED === "true",
        liveApiKeyConfigured: readiness.apiCredentialsConfigured,
        liveCredentialsIndependent: readiness.demoCredentialsIndependent,
        demoCredentialsConfigured: !!env.BINGX_API_KEY && !!env.BINGX_API_SECRET,
        demoModeSelected: env.BINGX_TRADING_MODE === "demo",
        demoTradingEnabled: isBingXDemoConfigured(env),
        liveExecutionIntegrated: true, liveRestClientIntegrated: true, durableIdempotencyIntegrated: true, livePositionManagementIntegrated: true,
        runtimeChecks, activation: { active: activation.active === true, activatedAt: activation.activatedAt ?? null },
        maxOpenPositions: 10, marginModeRequired: "ISOLATED", normalRiskR: 1, reducedRiskR: 0.5,
        normalLeverage: { min: 20, max: 50 }, reducedRiskLeverage: { min: 5, max: 10 },
        blockers, reason: blockers.length ? "Live execution is integrated but blocked until the listed prerequisites and account checks pass." : "Live execution is configured and remains disabled until the separate activation flag and fresh user confirmation are supplied."
      }, { headers: { ...headers, "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/live/activate" && request.method === "POST") {
      if (env.LIVE_TRADING_ENABLED !== "true") return Response.json({ ok: false, error: "LIVE_TRADING_DISABLED" }, { status: 403, headers });
      if (AUTOMATION_STOP) return Response.json({ ok: false, error: "AUTOMATION_EMERGENCY_STOP_ACTIVE" }, { status: 503, headers });
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "LIVE_CONTROL_AUTHORIZATION_REQUIRED" }, { status: 401, headers });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON_BODY" }, { status: 400, headers }); }
      const confirmedAt = Number(body?.confirmedAt);
      if (body?.confirmedByUser !== true || !Number.isFinite(confirmedAt) || Math.abs(Date.now() - confirmedAt) > 60000)
        return Response.json({ ok: false, error: "FRESH_EXPLICIT_LIVE_ACTIVATION_CONFIRMATION_REQUIRED" }, { status: 400, headers });
      const readiness = getLiveReadiness(env);
      if (!readiness.ready) return Response.json({ ok: false, error: "LIVE_READINESS_BLOCKED", blockers: readiness.blockers }, { status: 503, headers });
      const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
      const activation = { active: true, id: crypto.randomUUID(), confirmedByUser: true, confirmedAt, activatedAt: Date.now() };
      await new DurableObjectLiveStore({ stub }).setActivation(activation);
      return Response.json({ ok: true, liveTradingEnabled: true, activation: { active: true, activatedAt: activation.activatedAt } }, { headers: { ...headers, "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/live/deactivate" && request.method === "POST") {
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "LIVE_CONTROL_AUTHORIZATION_REQUIRED" }, { status: 401, headers });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON_BODY" }, { status: 400, headers }); }
      const confirmedAt = Number(body?.confirmedAt);
      if (body?.confirmedByUser !== true || !Number.isFinite(confirmedAt) || Math.abs(Date.now() - confirmedAt) > 60000)
        return Response.json({ ok: false, error: "FRESH_EXPLICIT_LIVE_DEACTIVATION_CONFIRMATION_REQUIRED" }, { status: 400, headers });
      const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
      await new DurableObjectLiveStore({ stub }).setActivation({ active: false, id: crypto.randomUUID(), confirmedByUser: true, confirmedAt, activatedAt: null });
      return Response.json({ ok: true, liveActivation: false }, { headers: { ...headers, "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/live/execute" && request.method === "POST") {
      if (AUTOMATION_STOP) return Response.json({ ok: false, error: "AUTOMATION_EMERGENCY_STOP_ACTIVE" }, { status: 503, headers });
      if (env.LIVE_TRADING_ENABLED !== "true") return Response.json({ ok: false, mode: "locked", liveTradingEnabled: false, error: "LIVE_TRADING_DISABLED" }, { status: 403, headers });
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "LIVE_CONTROL_AUTHORIZATION_REQUIRED" }, { status: 401, headers });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON_BODY" }, { status: 400, headers }); }
      const confirmedAt = Number(body?.confirmedAt);
      if (body?.confirmedByUser !== true || !Number.isFinite(confirmedAt) || Math.abs(Date.now() - confirmedAt) > 60000)
        return Response.json({ ok: false, error: "FRESH_EXPLICIT_LIVE_CONFIRMATION_REQUIRED" }, { status: 400, headers });
      const readiness = getLiveReadiness(env);
      if (!readiness.ready) return Response.json({ ok: false, error: "LIVE_READINESS_BLOCKED", blockers: readiness.blockers }, { status: 503, headers });
      try {
        const engineStub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
        const stateResponse = await engineStub.fetch(new Request("https://engine.internal/paper/status"));
        const state = await stateResponse.json();
        if (!stateResponse.ok || state.storageDegraded || !Array.isArray(state.setups))
          return Response.json({ ok: false, error: "LIVE_SIGNAL_STATE_UNAVAILABLE" }, { status: 503, headers });
        const setupId = String(body.setupId ?? "");
        const setup = state.setups.find(item => String(item.setupId ?? item.id ?? item.setupKey ?? [item.model, item.symbol, item.side, item.tradeStyle, item.setupCandleTime].join("|")) === setupId);
        const setupConfirmed = setup?.entryConfirmed === true || Array.isArray(setup?.confirmations) && setup.confirmations.includes("CLOSED_CANDLE_CONFIRMATION");
        if (!setup || !setupConfirmed || !["READY", "QUALIFIED", "HIGH_QUALITY"].includes(String(setup.status).toUpperCase()))
          return Response.json({ ok: false, error: "LIVE_SETUP_NOT_CURRENTLY_READY" }, { status: 409, headers });
        const engineName = String(setup.tradeStyle ?? setup.engine ?? "").toLowerCase();
        if (!["scalp", "swing"].includes(engineName)) return Response.json({ ok: false, error: "LIVE_SETUP_ENGINE_INVALID" }, { status: 409, headers });
        const symbol = String(setup.symbol ?? "");
        const side = String(setup.side ?? "").toUpperCase();
        if (!validSymbol.test(symbol) || !["LONG", "SHORT"].includes(side)) return Response.json({ ok: false, error: "LIVE_SETUP_MARKET_FIELDS_INVALID" }, { status: 409, headers });
        const riskMultiple = Number(setup.riskMultiplier) === 0.5 || setup.countertrend === true || setup.htfAligned === false || Number(setup.score) < 80 ? 0.5 : 1;
        const client = new BingXLiveClient({ apiKey: env.BINGX_LIVE_API_KEY, apiSecret: env.BINGX_LIVE_API_SECRET });
        const markPrice = await client.getMarkPrice(symbol);
        const stopLoss = Number(setup.stopLoss), takeProfit = Number(setup.takeProfit ?? setup.tp3 ?? setup.tp2 ?? setup.tp1);
        const unitRiskFraction = (Math.abs(markPrice - stopLoss) + markPrice * (FEE_RATE + SLIPPAGE_RATE) + stopLoss * (FEE_RATE + SLIPPAGE_RATE)) / markPrice;
        const minLeverage = riskMultiple === 0.5 ? 5 : 20, maxLeverage = riskMultiple === 0.5 ? 10 : 50;
        if (!Number.isFinite(unitRiskFraction) || unitRiskFraction <= 0 || unitRiskFraction > 1 / minLeverage * 0.8)
          return Response.json({ ok: false, error: "LIVE_STOP_DISTANCE_LIQUIDATION_GUARD" }, { status: 409, headers });
        const leverage = Math.max(minLeverage, Math.min(maxLeverage, Math.floor((riskMultiple === 0.5 ? 0.4 : 0.8) / unitRiskFraction)));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([setupId, symbol, side, setup.scannedAt ?? setup.candleTime ?? setup.setupTimeframe].join("|")));
        const idempotencyKey = "smc-" + Array.from(new Uint8Array(digest)).slice(0, 16).map(byte => byte.toString(16).padStart(2, "0")).join("");
        const store = new DurableObjectLiveStore({ stub: engineStub });
        const adapter = new BingXLiveExecutionAdapter({ env, client, store });
        const candidate = {
          id: setupId, engine: engineName, symbol, direction: side, status: "QUALIFIED", entryEligible: true,
          entryConfirmation: { status: "CONFIRMED" }, entry: Number(setup.entry), stopLoss, takeProfit,
          tp1: Number(setup.tp1), tp2: Number(setup.tp2),
          score: Number(setup.score), leverage, marginMode: "ISOLATED", riskMultiplier
        };
        const result = await adapter.submit(candidate, {
          riskMultiple, idempotencyKey,
          confirmation: { confirmedByUser: true, token: env.LIVE_CONTROL_TOKEN, confirmedAt }
        });
        return Response.json({ ok: true, mode: "BINGX_LIVE", result }, { headers: { ...headers, "cache-control": "no-store" } });
      } catch (error) {
        console.error("BingX live execution rejected", String(error).slice(0, 240));
        return Response.json({ ok: false, error: String(error).slice(0, 320) }, { status: 409, headers });
      }
    }
    if (url.pathname === "/api/live/positions" && request.method === "GET") {
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "LIVE_CONTROL_AUTHORIZATION_REQUIRED" }, { status: 401, headers });
      try {
        const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
        const store = new DurableObjectLiveStore({ stub });
        return Response.json({ ok: true, mode: "BINGX_LIVE", positions: await store.listLivePositions() }, { headers: { ...headers, "cache-control": "no-store" } });
      } catch (error) { return Response.json({ ok: false, error: String(error).slice(0, 200) }, { status: 503, headers }); }
    }
    if (["/api/live/close", "/api/live/protection", "/api/live/partial-close"].includes(url.pathname) && request.method === "POST") {
      if (!getLiveReadiness(env).ready) return Response.json({ ok: false, error: "LIVE_READINESS_BLOCKED", blockers: getLiveReadiness(env).blockers }, { status: 503, headers });
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "LIVE_CONTROL_AUTHORIZATION_REQUIRED" }, { status: 401, headers });
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON_BODY" }, { status: 400, headers }); }
      if (body?.confirmedByUser !== true || !Number.isFinite(Number(body.confirmedAt)) || Math.abs(Date.now() - Number(body.confirmedAt)) > 60000)
        return Response.json({ ok: false, error: "FRESH_EXPLICIT_LIVE_CONFIRMATION_REQUIRED" }, { status: 400, headers });
      try {
        const stub = env.ENGINE_STATE_V2.get(env.ENGINE_STATE_V2.idFromName("main-engine"));
        const store = new DurableObjectLiveStore({ stub });
        const positions = await store.listLivePositions();
        const position = positions.find(item => String(item.id) === String(body.positionId) && item.mode === "BINGX_LIVE" && item.state === "OPEN");
        if (!position) return Response.json({ ok: false, error: "LIVE_POSITION_NOT_FOUND" }, { status: 404, headers });
        const client = new BingXLiveClient({ apiKey: env.BINGX_LIVE_API_KEY, apiSecret: env.BINGX_LIVE_API_SECRET });
        const adapter = new BingXLiveExecutionAdapter({ env, client, store });
        let result;
        if (url.pathname === "/api/live/close") result = await adapter.close(position);
        else if (url.pathname === "/api/live/protection") result = await adapter.updateProtection(position, { stopLoss: body.stopLoss, takeProfit: body.takeProfit });
        else result = await adapter.partialClose(position, Number(body.fraction));
        return Response.json({ ok: true, mode: "BINGX_LIVE", result }, { headers: { ...headers, "cache-control": "no-store" } });
      } catch (error) { return Response.json({ ok: false, error: String(error).slice(0, 260) }, { status: 409, headers }); }
    }
    if (env.BINGX_TRADING_MODE === "demo" && request.method === "POST" && (url.pathname === "/api/paper/close" || url.pathname === "/api/paper/close-all")) {
      if (!isBingXDemoConfigured(env)) return Response.json({ ok: false, mode: "bingx-demo", error: "BingX VST demo account is not configured." }, { status: 503, headers });
      if (!isTrustedManualCloseOrigin(request.headers.get("origin"), url.origin)) return Response.json({ ok: false, error: "Manual close must originate from the dashboard." }, { status: 403, headers });
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "BingX demo control token required." }, { status: 401, headers });
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400, headers });
      }
      if (body.confirmedByUser !== true) return Response.json({ ok: false, error: "Explicit dashboard close confirmation is required." }, { status: 400, headers });
      try {
        const snapshot = await getBingXDemoSnapshot(env.BINGX_API_KEY, env.BINGX_API_SECRET);
        const rawMeta = await readEnginePaperState(env, "bingx-demo-position-meta");
        let metadata = [];
        try {
          metadata = rawMeta ? JSON.parse(rawMeta) : [];
        } catch {
          metadata = [];
        }
        if (url.pathname === "/api/paper/close-all") {
          const failures = [];
          let closed = 0;
          for (const position2 of snapshot.positions) {
            try {
              const side2 = position2.positionSide === "SHORT" || position2.positionSide === "BOTH" && Number(position2.positionAmt) < 0 ? "SHORT" : "LONG";
              const meta2 = metadata.find((item) => item.symbol === position2.symbol && item.side === side2);
              await closeBingXDemoPosition(env.BINGX_API_KEY, env.BINGX_API_SECRET, position2, snapshot.hedgeMode, 1, meta2);
              for (const order of snapshot.openOrders.filter((item) => item.symbol === position2.symbol && String(item.side ?? "").toUpperCase() === (side2 === "LONG" ? "SELL" : "BUY") && (!item.positionSide || String(item.positionSide).toUpperCase() === "BOTH" || String(item.positionSide).toUpperCase() === side2))) {
                const id = String(order.orderID ?? order.orderId ?? "");
                if (id) try {
                  await cancelBingXDemoOrder(env.BINGX_API_KEY, env.BINGX_API_SECRET, position2.symbol, id);
                } catch {
                }
              }
              closed++;
              if (meta2) await archiveBingXDemoClosedStrategyMetadata(env, [{ ...meta2, closedAt: Date.now() }]);
              metadata = metadata.filter((item) => !(item.symbol === position2.symbol && item.side === side2));
            } catch (error) {
              failures.push({ symbol: position2.symbol, error: String(error).slice(0, 180) });
            }
          }
          await writeEnginePaperState(env, "bingx-demo-position-meta", JSON.stringify(metadata));
          bingxDemoStatusCache = null;
          bingxClosedFillMemoryCache = null;
          const refreshed2 = await getBingXDemoSnapshot(env.BINGX_API_KEY, env.BINGX_API_SECRET);
          const residualPositions = refreshed2.positions;
          for (const residual of residualPositions) if (!failures.some((item) => item.symbol === residual.symbol)) failures.push({ symbol: residual.symbol, error: "Exchange still reports an open position after close-all." });
          return Response.json({ ok: failures.length === 0 && residualPositions.length === 0, mode: "bingx-demo", closed, remaining: residualPositions.length, failures, balance: refreshed2.balance?.balance ?? null, equity: refreshed2.balance?.equity ?? null });
        }
        const positionId = String(body.positionId ?? "");
        const fraction = Number(body.fraction ?? 1);
        const position = snapshot.positions.find((item) => String(item.positionId ?? "") === positionId || item.symbol + "-" + (item.positionSide === "SHORT" || item.positionSide === "BOTH" && Number(item.positionAmt) < 0 ? "SHORT" : "LONG") === positionId);
        if (!position) return Response.json({ ok: false, error: "The requested position is not open in the BingX VST demo account." }, { status: 404, headers });
        if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return Response.json({ ok: false, error: "fraction must be greater than 0 and at most 1." }, { status: 400, headers });
        const side = position.positionSide === "SHORT" || position.positionSide === "BOTH" && Number(position.positionAmt) < 0 ? "SHORT" : "LONG";
        const meta = metadata.find((item) => item.symbol === position.symbol && item.side === side);
        let result;
        try {
          result = await closeBingXDemoPosition(env.BINGX_API_KEY, env.BINGX_API_SECRET, position, snapshot.hedgeMode, fraction, meta);
        } catch (error) {
          await writeEnginePaperState(env, "bingx-demo-position-meta", JSON.stringify(metadata));
          throw error;
        }
        const refreshed = await getBingXDemoSnapshot(env.BINGX_API_KEY, env.BINGX_API_SECRET);
        const remainingPosition = refreshed.positions.find((item) => {
          if (item.symbol !== position.symbol) return false;
          const itemSide = item.positionSide === "SHORT" || item.positionSide === "BOTH" && Number(item.positionAmt) < 0 ? "SHORT" : "LONG";
          return itemSide === side;
        });
        const remainingQty = remainingPosition ? Math.abs(Number(remainingPosition.positionAmt) || 0) : 0;
        const fullyClosed = remainingQty <= 1e-12;
        if (fullyClosed) {
          for (const order of snapshot.openOrders.filter((item) => {
            if (item.symbol !== position.symbol) return false;
            const orderSide = String(item.side ?? "").toUpperCase();
            const orderPositionSide = String(item.positionSide ?? "").toUpperCase();
            return orderSide === (side === "LONG" ? "SELL" : "BUY") && (!orderPositionSide || orderPositionSide === "BOTH" || orderPositionSide === side);
          })) {
            const id = String(order.orderID ?? order.orderId ?? "");
            if (id) try {
              await cancelBingXDemoOrder(env.BINGX_API_KEY, env.BINGX_API_SECRET, position.symbol, id);
            } catch {
            }
          }
          if (meta) await archiveBingXDemoClosedStrategyMetadata(env, [{ ...meta, closedAt: Date.now() }]);
          metadata = metadata.filter((item) => !(item.symbol === position.symbol && item.side === side));
        }
        await writeEnginePaperState(env, "bingx-demo-position-meta", JSON.stringify(metadata));
        bingxDemoStatusCache = null;
        bingxClosedFillMemoryCache = null;
        const originalQty = Math.abs(Number(position.positionAmt) || 0);
        const requestedCloseQty = Number(result.requestedCloseQty) || originalQty * fraction;
        const closedQty = Math.max(0, originalQty - remainingQty);
        const closeTolerance = Math.max(1e-10, requestedCloseQty * 1e-6);
        const partialCloseConfirmed = fraction < 1 && closedQty + closeTolerance >= requestedCloseQty;
        const closeOk = fraction >= 1 ? fullyClosed : partialCloseConfirmed;
        return Response.json(
          {
            ok: closeOk,
            mode: "bingx-demo",
            symbol: position.symbol,
            fraction,
            order: result,
            requestedCloseQty,
            closedQty,
            remainingQty,
            pnlUsdt: null,
            balance: refreshed.balance?.balance ?? null,
            equity: refreshed.balance?.equity ?? null,
            message: fullyClosed ? "BingX VST demo position is confirmed flat." : partialCloseConfirmed ? "BingX VST demo partial close was confirmed by the exchange; remaining position and protection are retained." : "BingX VST demo close reduction was not confirmed; remaining quantity and protection were retained."
          },
          { status: closeOk ? 200 : 502, headers }
        );
      } catch (error) {
        bingxDemoStatusCache = null;
        bingxClosedFillMemoryCache = null;
        return Response.json({ ok: false, mode: "bingx-demo", error: "BingX VST demo close failed: " + String(error).slice(0, 240) }, { status: 502, headers });
      }
    }
    if (env.BINGX_TRADING_MODE === "demo" && (request.method === "GET" && url.pathname === "/api/state" || request.method === "POST" && ["/api/runner", "/api/paper/scan", "/api/paper/settings"].includes(url.pathname))) {
      if (!isDemoControlAuthorized(request, env)) return Response.json({ ok: false, mode: "bingx-demo", error: "BingX demo control token required." }, { status: 401, headers });
    }
    if (request.method === "GET" && url.pathname === "/api/market/universe") {
      try {
        const response = await fetch(BINGX + "/openApi/swap/v2/quote/contracts", {
          headers: { "X-SOURCE-KEY": "BX-AI-SKILL", accept: "application/json" },
          signal: AbortSignal.timeout(15e3),
          cache: "no-store"
        });
        if (!response.ok) return Response.json({ ok: false, error: "BingX contracts unavailable", httpStatus: response.status }, { status: 502 });
        const payload = await response.json();
        if (payload.code !== 0 || !Array.isArray(payload.data)) return Response.json({ ok: false, error: payload.msg || "Invalid BingX contracts response" }, { status: 502 });
        const eligible = payload.data.filter(isEligibleUsdtPerpetualContract);
        const symbols = buildEligibleCryptoUsdtPerpetualUniverse(payload.data, payload.data.length);
        const eligibleSet = new Set(eligible.map((c) => String(c.symbol ?? "").toUpperCase()));
        const knownCryptoSymbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "ADA-USDT", "BNB-USDT", "TRX-USDT", "TON-USDT", "LINK-USDT", "AVAX-USDT", "SUI-USDT", "APT-USDT", "SEI-USDT", "ARB-USDT", "OP-USDT", "1INCH-USDT", "1000SATS-USDT", "1000PEPE-USDT", "1000SHIB-USDT", "1000BONK-USDT", "WIF-USDT", "ONDO-USDT", "NEM-USDT", "XEM-USDT", "LTC-USDT", "BCH-USDT", "DOT-USDT", "UNI-USDT", "AAVE-USDT"];
        const knownCryptoAudit = knownCryptoSymbols.map((symbol) => {
          const contract = payload.data.find((c) => String(c.symbol ?? "").toUpperCase() === symbol);
          return { symbol, listed: !!contract, eligible: eligibleSet.has(symbol), metadata: contract ? { currency: contract.currency, asset: contract.asset, status: contract.status, apiStateOpen: contract.apiStateOpen, name: contract.name } : null };
        });
        const leverageFields = ["maxLongLeverage", "maxShortLeverage", "maxLeverage", "longMaxLeverage", "shortMaxLeverage"];
        const leverageMetadataAudit = {
          contractsWithDirectionalLong: payload.data.filter((c) => c.maxLongLeverage !== void 0 && c.maxLongLeverage !== null && String(c.maxLongLeverage).trim() !== "").length,
          contractsWithDirectionalShort: payload.data.filter((c) => c.maxShortLeverage !== void 0 && c.maxShortLeverage !== null && String(c.maxShortLeverage).trim() !== "").length,
          contractsWithGenericCap: payload.data.filter((c) => c.maxLeverage !== void 0 && c.maxLeverage !== null && String(c.maxLeverage).trim() !== "").length,
          fieldNamesSeen: [...new Set(payload.data.flatMap((c) => Object.keys(c).filter((k) => /leverage|max.*lev/i.test(k))))].sort(),
          sample: knownCryptoSymbols.map((symbol) => {
            const c = payload.data.find((x) => String(x.symbol ?? "").toUpperCase() === symbol);
            return c ? { symbol, contractFound: true, keys: Object.keys(c).filter((k) => /leverage|max.*lev/i.test(k)), maxLongLeverage: c.maxLongLeverage ?? null, maxShortLeverage: c.maxShortLeverage ?? null, maxLeverage: c.maxLeverage ?? null, resolvedLong: resolveContractLeverage(c, "LONG"), resolvedShort: resolveContractLeverage(c, "SHORT") } : { symbol, contractFound: false };
          }).filter((x) => x.contractFound).slice(0, 30)
        };
        const excluded = payload.data.filter((c) => !isEligibleUsdtPerpetualContract(c));
        const symbolOnlyCandidates = payload.data.filter((c) => isEligibleUsdtPerpetualSymbol(c.symbol));
        const metadataRejectedSymbolCandidates = symbolOnlyCandidates.filter((c) => !eligibleSet.has(String(c.symbol ?? "").toUpperCase())).map((c) => ({
          symbol: c.symbol,
          currency: c.currency,
          asset: c.asset,
          status: c.status,
          apiStateOpen: c.apiStateOpen,
          name: c.name
        }));
        return Response.json({
          ok: true,
          source: "BingX /openApi/swap/v2/quote/contracts",
          checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
          contractsReceived: payload.data.length,
          eligibleBeforeLimit: eligible.length,
          universeSize: symbols.length,
          universeLimit: payload.data.length,
          limitReached: false,
          btcIncluded: symbols.includes("BTC-USDT"),
          selectedSymbols: symbols,
          excludedCount: excluded.length,
          excludedSymbols: excluded.map((c) => ({ symbol: c.symbol, currency: c.currency, asset: c.asset, status: c.status, apiStateOpen: c.apiStateOpen, name: c.name })),
          metadataRejectedSymbolCandidateCount: metadataRejectedSymbolCandidates.length,
          metadataRejectedSymbolCandidates,
          leverageMetadataAudit,
          knownCryptoAudit
        }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ ok: false, error: "BingX universe audit failed: " + String(error).slice(0, 180) }, { status: 502 });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/market/contracts") return bingx("/openApi/swap/v2/quote/contracts");
    if (request.method === "GET" && url.pathname === "/api/market/ticker") {
      const symbol = url.searchParams.get("symbol");
      if (symbol && !isEligibleUsdtPerpetualSymbol(symbol)) return Response.json({ ok: false, error: "Only BASE-USDT crypto perpetual symbols are accepted." }, { status: 400 });
      return bingx("/openApi/swap/v2/quote/ticker" + (symbol ? "?symbol=" + encodeURIComponent(symbol) : ""));
    }
    if (request.method === "GET" && url.pathname === "/api/history/candles") {
      const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
      const rawIntervals = url.searchParams.get("intervals") ?? url.searchParams.get("interval") ?? "15m";
      const intervals = [...new Set(rawIntervals.split(",").map((x) => x.trim() === "1D" ? "1d" : x.trim()))];
      const rawLimit = Number(url.searchParams.get("limit") ?? "500");
      if (!isEligibleUsdtPerpetualSymbol(symbol)) return Response.json({ ok: false, error: "symbol must be a crypto BASE-USDT pair, e.g. BTC-USDT." }, { status: 400 });
      if (!intervals.length || intervals.length > 8 || intervals.some((x) => !ALLOWED_INTERVALS.has(x))) {
        return Response.json({ ok: false, error: "Use 1-6 supported intervals: 5m,15m,1h,2h,4h,1d." }, { status: 400 });
      }
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1440) {
        return Response.json({ ok: false, error: "limit must be an integer from 1 to 1440 candles per interval." }, { status: 400 });
      }
      const results = await Promise.all(intervals.map(async (interval) => {
        const params = new URLSearchParams({ symbol, interval, limit: String(rawLimit) });
        const response = await fetch(`${BINGX}/openApi/swap/v3/quote/klines?${params}`, {
          headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
          cf: { cacheTtl: 30, cacheEverything: true }
        });
        if (!response.ok) throw new Error(`BingX HTTP ${response.status} for ${interval}`);
        const payload = await response.json();
        if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error(payload.msg || `Invalid BingX candles for ${interval}`);
        const candles = payload.data.map(normalizeCandle).filter((c) => !!c && c.open != null && c.high != null && c.low != null && c.close != null).sort((a, b) => a.time - b.time).map((c) => ({ open_time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
        return [interval, candles];
      }));
      const candlesByInterval = Object.fromEntries(results);
      return Response.json({
        ok: true,
        source: "bingx-on-demand",
        persistentArchive: false,
        symbol,
        intervals: candlesByInterval,
        candleCount: results.reduce((n, [, candles]) => n + candles.length, 0),
        candlesPerInterval: rawLimit,
        note: "No Durable Object SQL reads/writes; request each symbol with up to 8 timeframes."
      }, { headers: { ...headers, "cache-control": "public, max-age=5" } });
    }
    if (request.method === "GET" && url.pathname === "/api/market/klines") {
      const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
      const interval = url.searchParams.get("interval") ?? "15m";
      const rawLimit = Number(url.searchParams.get("limit") ?? "100");
      const startTimeRaw = url.searchParams.get("startTime");
      const endTimeRaw = url.searchParams.get("endTime");
      const startTime = startTimeRaw === null ? null : Number(startTimeRaw);
      const endTime = endTimeRaw === null ? null : Number(endTimeRaw);
      if (!isEligibleUsdtPerpetualSymbol(symbol)) return Response.json({ ok: false, error: "symbol must be a crypto BASE-USDT pair, e.g. BTC-USDT." }, { status: 400 });
      if (!ALLOWED_INTERVALS.has(interval)) return Response.json({ ok: false, error: "Unsupported interval." }, { status: 400 });
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1440) return Response.json({ ok: false, error: "limit must be an integer from 1 to 1440." }, { status: 400 });
      if (startTimeRaw !== null && (!Number.isSafeInteger(startTime) || startTime < 0) || endTimeRaw !== null && (!Number.isSafeInteger(endTime) || endTime < 0) || startTime !== null && endTime !== null && endTime <= startTime) {
        return Response.json({ ok: false, error: "startTime/endTime must be valid increasing Unix-millisecond timestamps." }, { status: 400 });
      }
      const params = new URLSearchParams({ symbol, interval, limit: String(rawLimit) });
      if (startTime !== null) params.set("startTime", String(startTime));
      if (endTime !== null) params.set("endTime", String(endTime));
      return bingx("/openApi/swap/v3/quote/klines?" + params.toString());
    }
    if ((url.pathname === "/api/state" || url.pathname === "/api/runner" || request.method === "POST" && (url.pathname === "/api/paper/settings" || url.pathname === "/api/paper/scan")) && !isDemoControlAuthorized(request, env)) return Response.json({ ok: false, error: "Administrative bearer token required." }, { status: 401, headers });
    if (url.pathname.startsWith("/api/history/") || url.pathname.startsWith("/api/paper/") || url.pathname === "/api/runner" || url.pathname === "/api/state") {
      const id = env.ENGINE_STATE_V2.idFromName("main-engine");
      const path = url.pathname === "/api/history/start" ? "/history/start" : url.pathname === "/api/history/status" ? "/history/status" : url.pathname === "/api/history/archive/start" ? "/history/archive/start" : url.pathname === "/api/history/archive/bootstrap" ? "/history/archive/bootstrap" : url.pathname === "/api/history/archive/status" ? "/history/archive/status" : url.pathname === "/api/history/archive/tick" ? "/history/archive/tick" : url.pathname === "/api/history/archive/pause" ? "/history/archive/pause" : url.pathname === "/api/history/candles" ? "/history/candles" : url.pathname === "/api/history/pause" ? "/history/pause" : url.pathname === "/api/history/resume" ? "/history/resume" : url.pathname === "/api/history/safety" ? "/history/safety" : url.pathname === "/api/paper/status" ? "/paper/status" : url.pathname === "/api/paper/close" ? "/paper/close" : url.pathname === "/api/paper/close-all" ? "/paper/close-all" : url.pathname === "/api/paper/settings" ? "/paper/settings" : url.pathname === "/api/paper/capital-adjustment" ? "/paper/capital-adjustment" : url.pathname === "/api/paper/scan" ? "/paper/scan" : url.pathname === "/api/runner" ? "/runner" : "/state";
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.set("x-smcprov2-public-origin", new URL(request.url).origin);
      const init = { method: request.method, headers: forwardedHeaders };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
      return env.ENGINE_STATE_V2.get(id).fetch(new Request("https://engine.internal" + path + url.search, init));
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  EngineState,
  EngineStateV2,
  index_default as default
};
//# sourceMappingURL=index.js.map
