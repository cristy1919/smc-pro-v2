import { validateCandles } from "./market-data.js";
import { detectPivots, classifyStructure, detectStructureEvents } from "./market-structure.js";

const DEFAULTS = Object.freeze({
  leftBars: 2,
  rightBars: 2,
  rangeLookback: 24,
  rangeWidthPct: 0.035,
  transitionMaxBars: 24,
  displacementBodyRatio: 0.55,
  displacementCloseLocation: 0.7
});

function rangeWidth(candles, end, lookback) {
  const start = Math.max(0, end - lookback + 1);
  const rows = candles.slice(start, end + 1);
  if (rows.length < Math.min(lookback, 8)) return null;
  const high = Math.max(...rows.map(x => x.high));
  const low = Math.min(...rows.map(x => x.low));
  const mid = rows.reduce((sum, x) => sum + x.close, 0) / rows.length;
  return mid > 0 ? (high - low) / mid : null;
}

/**
 * Builds a causal market-regime timeline. A pivot is usable only at confirmedAt;
 * a structure break is usable only after the candle closes. No future candle is read
 * when assigning a timeline row.
 */
export function detectMarketRegimeTimeline(candles, options = {}) {
  validateCandles(candles);
  const cfg = { ...DEFAULTS, ...options };
  for (const key of ["leftBars", "rightBars", "rangeLookback", "transitionMaxBars"]) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < 1) throw new RangeError("INVALID_REGIME_OPTION_" + key);
  }
  if (!(cfg.rangeWidthPct > 0) || !(cfg.displacementBodyRatio > 0 && cfg.displacementBodyRatio <= 1)) {
    throw new RangeError("INVALID_REGIME_THRESHOLDS");
  }

  const pivots = classifyStructure(detectPivots(candles, {
    leftBars: cfg.leftBars, rightBars: cfg.rightBars
  }));
  const events = detectStructureEvents(candles, pivots, {
    minBodyRatio: cfg.displacementBodyRatio,
    minCloseLocation: cfg.displacementCloseLocation
  });
  const pivotsAt = new Map();
  for (const pivot of pivots) {
    const rows = pivotsAt.get(pivot.confirmedAt) ?? [];
    rows.push(pivot);
    pivotsAt.set(pivot.confirmedAt, rows);
  }
  const eventsAt = new Map(events.map(event => [event.index, event]));
  const highs = [], lows = [], timeline = [], transitions = [];
  let confirmedRegime = "UNCERTAIN";
  let transition = null;

  for (let i = 0; i < candles.length; i++) {
    for (const pivot of pivotsAt.get(i) ?? []) {
      const row = { ...pivot };
      (pivot.type === "HIGH" ? highs : lows).push(row);
    }
    const recentHighs = highs.slice(-2);
    const recentLows = lows.slice(-2);
    const bullishStructure = recentHighs.length === 2 && recentLows.length === 2 &&
      recentHighs[1].label === "HH" && recentLows[1].label === "HL";
    const bearishStructure = recentHighs.length === 2 && recentLows.length === 2 &&
      recentHighs[1].label === "LH" && recentLows[1].label === "LL";
    const event = eventsAt.get(i) ?? null;

    if (event && (event.type === "CHoCH" || event.mss) &&
        (confirmedRegime === "BULL" && event.direction === "BEARISH" ||
         confirmedRegime === "BEAR" && event.direction === "BULLISH")) {
      transition = {
        from: confirmedRegime,
        toward: event.direction === "BULLISH" ? "BULL" : "BEAR",
        startedAt: i,
        startedTimestamp: candles[i].timestamp,
        trigger: event.type,
        level: event.level,
        displacement: event.displacement
      };
    }

    let regime = "UNCERTAIN";
    let confidence = 0;
    let reason = "INSUFFICIENT_CONFIRMED_STRUCTURE";

    if (bullishStructure && !bearishStructure) {
      regime = "BULL"; confidence = event?.direction === "BULLISH" && event.displacement ? 0.95 : 0.82;
      reason = "HH_HL_CONFIRMED";
    } else if (bearishStructure && !bullishStructure) {
      regime = "BEAR"; confidence = event?.direction === "BEARISH" && event.displacement ? 0.95 : 0.82;
      reason = "LH_LL_CONFIRMED";
    } else {
      const width = rangeWidth(candles, i, cfg.rangeLookback);
      const freshDirectionalBreak = event && event.displacement &&
        (event.type === "BOS" || event.type === "CHoCH");
      if (width !== null && width <= cfg.rangeWidthPct && !freshDirectionalBreak) {
        regime = "SIDEWAYS"; confidence = Math.min(0.9, 0.65 + (cfg.rangeWidthPct - width) / cfg.rangeWidthPct * 0.25);
        reason = "COMPRESSED_RANGE_WITHOUT_CONFIRMED_TREND";
      } else if (transition && i - transition.startedAt <= cfg.transitionMaxBars) {
        regime = "TRANSITION"; confidence = transition.displacement ? 0.8 : 0.65;
        reason = "COUNTERTREND_CHOCH_OR_MSS_AWAITING_NEW_SWING_SEQUENCE";
      }
    }

    if (regime === "BULL" || regime === "BEAR") {
      if (transition && regime === transition.toward) {
        transitions.push({
          from: transition.from, to: regime, detectedAt: transition.startedTimestamp,
          confirmedAt: candles[i].timestamp, trigger: transition.trigger,
          triggerLevel: transition.level, confirmation: reason,
          barsToConfirm: i - transition.startedAt
        });
      }
      confirmedRegime = regime;
      transition = null;
    } else if (regime === "TRANSITION" && transition) {
      // Keep the last confirmed regime separately; do not relabel it as the new trend.
    } else if (regime === "SIDEWAYS") {
      confirmedRegime = "SIDEWAYS";
      transition = null;
    } else if (transition && i - transition.startedAt > cfg.transitionMaxBars) {
      transition = null;
    }

    timeline.push({
      index: i,
      timestamp: candles[i].timestamp,
      regime,
      confirmedRegime,
      direction: regime === "BULL" ? "BULLISH" : regime === "BEAR" ? "BEARISH" : "NEUTRAL",
      confidence: Number(confidence.toFixed(4)),
      reason,
      structure: {
        bullish: bullishStructure,
        bearish: bearishStructure,
        lastHighLabel: recentHighs.at(-1)?.label ?? null,
        lastLowLabel: recentLows.at(-1)?.label ?? null
      },
      event: event ? {
        type: event.type, direction: event.direction, level: event.level,
        displacement: event.displacement, msb: event.msb, mss: event.mss
      } : null,
      transition: transition ? { ...transition } : null
    });
  }

  return {
    timeline,
    pivots,
    events,
    transitions,
    summary: {
      bullBars: timeline.filter(x => x.regime === "BULL").length,
      bearBars: timeline.filter(x => x.regime === "BEAR").length,
      sidewaysBars: timeline.filter(x => x.regime === "SIDEWAYS").length,
      transitionBars: timeline.filter(x => x.regime === "TRANSITION").length,
      uncertainBars: timeline.filter(x => x.regime === "UNCERTAIN").length,
      transitionCount: transitions.length
    }
  };
}

export function regimeAtTimestamp(result, timestamp) {
  if (!result || !Array.isArray(result.timeline) || !Number.isFinite(timestamp)) return null;
  let low = 0, high = result.timeline.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (result.timeline[mid].timestamp <= timestamp) { found = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return found >= 0 ? result.timeline[found] : null;
}

/** Preserve disagreement rather than forcing the pair to follow BTC. */
export function combineMarketRegimes({ macro, pair, execution } = {}) {
  const values = [macro, pair, execution].filter(Boolean);
  const directions = values.map(x => x.regime).filter(x => x === "BULL" || x === "BEAR");
  const conflict = directions.includes("BULL") && directions.includes("BEAR");
  const pairRegime = pair?.regime ?? "UNCERTAIN";
  const executionRegime = execution?.regime ?? "UNCERTAIN";
  return {
    macroRegime: macro?.regime ?? "UNCERTAIN",
    pairRegime,
    executionRegime,
    conflict,
    compositeRegime: conflict ? "MIXED" : pairRegime,
    confidence: Math.min(...values.map(x => Number.isFinite(x.confidence) ? x.confidence : 0), 1)
  };
}
