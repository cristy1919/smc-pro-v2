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
    if (!Number.isFinite(markPrice) || markPrice <= 0) continue;
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
  const amountUsdt = Math.max(0, round(targetUsdt - balanceBe

--- TRUNCATED ---
Response was ~127,182 tokens (limit: 6,000). Use more specific queries to reduce response size.