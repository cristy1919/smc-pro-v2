const DIRECTION = Object.freeze({ BULLISH: 1, BEARISH: -1 });
const directionalClose = (candle, direction) => direction === "BULLISH" ? candle.close > candle.open : candle.close < candle.open;

export function advanceEntryConfirmation(candidate, candles, { maxWaitBars = 6, minBodyRatio = 0.35 } = {}) {
  if (!candidate || !Array.isArray(candles)) throw new TypeError("candidate and candles are required");
  if (!Number.isInteger(maxWaitBars) || maxWaitBars < 1) throw new RangeError("maxWaitBars must be positive");
  const signalTime = candidate.createdAt;
  const future = candles.filter(c => c.timestamp > signalTime && c.closed === true).slice(0, maxWaitBars);
  const isBreakout = /S03_|W08_|S05_|W06_/.test(candidate.setupId);
  const bounds = candidate.zoneBounds;
  for (let i = 0; i < future.length; i++) {
    const c = future[i], range = c.high - c.low;
    if (!(range > 0) || !directionalClose(c, candidate.direction)) continue;
    const bodyRatio = Math.abs(c.close - c.open) / range;
    if (bodyRatio < minBodyRatio) continue;
    if (isBreakout) return { status:"CONFIRMED", method:"CLOSE_CONFIRMATION", confirmedAt:c.timestamp, entry:c.close, barsWaited:i+1 };
    if (!bounds || !Number.isFinite(bounds.low) || !Number.isFinite(bounds.high)) continue;
    const touched = c.low <= bounds.high && c.high >= bounds.low;
    const reclaimed = candidate.direction === "BULLISH" ? c.close >= bounds.low : c.close <= bounds.high;
    if (touched && reclaimed) return { status:"CONFIRMED", method:"ZONE_RETEST_CLOSE", confirmedAt:c.timestamp, entry:c.close, barsWaited:i+1 };
  }
  const expired = future.length >= maxWaitBars;
  return { status:expired ? "EXPIRED" : "WAIT", method:isBreakout ? "CLOSE_CONFIRMATION" : "ZONE_RETEST_CLOSE", barsWaited:future.length, reason:expired ? "RETEST_CONFIRMATION_TIMEOUT" : "AWAITING_CLOSED_CANDLE_CONFIRMATION" };
}
