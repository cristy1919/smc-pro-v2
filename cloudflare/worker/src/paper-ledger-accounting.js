const AUTOMATED_CLOSE_SOURCES = new Set(["AUTOMATED_SL_TP", "LIQUIDATION"]);

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Rebuild the internal paper cash balance from the persisted transaction ledger.
 *
 * Closed automated exits are unique by position ID because the same position
 * can only be finally closed once. Manual partial closes remain distinct by
 * close ID/time/reason. Open positions contribute realized PnL less the
 * uncharged entry fee; their entry slippage is already included in realizedPnl.
 */
export function computeCanonicalPaperBalance(ledger) {
  const capitalEvents = Array.isArray(ledger?.capitalAdjustments)
    ? ledger.capitalAdjustments
    : [];
  const firstCapital = capitalEvents[0] ?? {};
  const baseCapital = numeric(
    firstCapital.balanceAfter ?? firstCapital.targetUsdt,
    numeric(ledger?.startingBalance, 1000),
  );
  const laterCapital = capitalEvents
    .slice(1)
    .reduce((sum, event) => sum + numeric(event.amountUsdt), 0);

  const automatedIds = new Set();
  const manualCloseKeys = new Set();
  const closedTrades = [...(ledger?.closedTrades ?? [])].sort(
    (left, right) => numeric(left.closedAt) - numeric(right.closedAt),
  );

  let closedNetPnl = 0;
  for (const trade of closedTrades) {
    const automated = AUTOMATED_CLOSE_SOURCES.has(trade.closeSource);
    if (automated) {
      const positionId = String(trade.positionId ?? trade.id ?? "");
      if (automatedIds.has(positionId)) continue;
      automatedIds.add(positionId);
    } else {
      const closeKey = [
        String(trade.id ?? ""),
        String(trade.closedAt ?? ""),
        String(trade.closeReason ?? ""),
      ].join("|");
      if (manualCloseKeys.has(closeKey)) continue;
      manualCloseKeys.add(closeKey);
    }

    const recordedPnl = Number(trade.pnlUsdt);
    const fallbackPnl =
      numeric(trade.realizedPnlUsdt) - numeric(trade.entryFeeUsdt);
    closedNetPnl += Number.isFinite(recordedPnl) ? recordedPnl : fallbackPnl;
  }

  const openRealizedNet = (ledger?.positions ?? [])
    .filter((position) => position.status === "OPEN")
    .reduce(
      (sum, position) =>
        sum +
        numeric(position.realizedPnlUsdt) -
        numeric(position.entryFeeUsdt),
      0,
    );

  return Number(
    (baseCapital + laterCapital + closedNetPnl + openRealizedNet).toFixed(8),
  );
}

/**
 * Reconstruct the account balance at the start of a UTC day from pre-day
 * entry, exit, and funding events. This is a bootstrap path; after it is
 * persisted as dailyStartBalance, daily PnL is balance minus that baseline.
 */
export function computeDailyStartBalance(ledger, dayStartMs, slippageRate = 0.0002, liquidationFeeRate = 0) {
  const capitalEvents = Array.isArray(ledger?.capitalAdjustments)
    ? ledger.capitalAdjustments
    : [];
  const firstCapital = capitalEvents[0] ?? {};
  let startBalance = numeric(
    firstCapital.balanceAfter ?? firstCapital.targetUsdt,
    numeric(ledger?.startingBalance, 1000),
  );
  for (const event of capitalEvents.slice(1)) {
    const at = typeof event.at === "string" ? Date.parse(event.at) : numeric(event.at, NaN);
    if (Number.isFinite(at) && at < dayStartMs) startBalance += numeric(event.amountUsdt);
  }

  const seen = new Set();
  const records = [
    ...(ledger?.closedTrades ?? []),
    ...(ledger?.positions ?? []).filter((position) => position.status === "OPEN"),
  ];
  for (const position of records) {
    const id = String(position.positionId ?? position.id ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const feeRate = Math.max(0, numeric(position.feeRate, 0.0005));
    for (const event of position.executionEvents ?? []) {
      const at = typeof event.at === "string" ? Date.parse(event.at) : numeric(event.at, NaN);
      const qty = numeric(event.qty);
      if (!Number.isFinite(at) || at >= dayStartMs || qty <= 0) continue;
      if (event.event === "PAPER_ENTRY") {
        const entry = numeric(event.entry ?? position.entry, NaN);
        if (Number.isFinite(entry) && entry > 0) {
          startBalance -= qty * entry * (feeRate + slippageRate);
        }
        continue;
      }
      const exit = numeric(event.executionPrice, NaN);
      if (!Number.isFinite(exit) || exit <= 0) continue;
      const gross =
        (position.side === "LONG" ? exit - numeric(position.entry) : numeric(position.entry) - exit) *
        qty;
      const liquidationFee =
        event.event === "LIQUIDATION" ? qty * exit * liquidationFeeRate : 0;
      startBalance += gross - qty * exit * feeRate - qty * exit * slippageRate - liquidationFee;
    }
    for (const funding of position.fundingEvents ?? []) {
      const at = numeric(funding.fundingTime, NaN);
      if (Number.isFinite(at) && at < dayStartMs) startBalance += numeric(funding.pnlUsdt);
    }
  }
  return Number(startBalance.toFixed(8));
}

export function computeCanonicalDailyPnl(ledger, dayStartMs, slippageRate = 0.0002) {
  const start =
    Number.isFinite(Number(ledger?.dailyStartBalance))
      ? Number(ledger.dailyStartBalance)
      : computeDailyStartBalance(ledger, dayStartMs, slippageRate);
  const todayCapital = (ledger?.capitalAdjustments ?? []).slice(1).reduce((sum, event) => {
    const at = typeof event.at === "string" ? Date.parse(event.at) : numeric(event.at, NaN);
    return Number.isFinite(at) && at >= dayStartMs ? sum + numeric(event.amountUsdt) : sum;
  }, 0);
  return Number((computeCanonicalPaperBalance(ledger) - start - todayCapital).toFixed(8));
}

/** Requests that can mutate the shared paper ledger must use one serial lock. */
export function isPaperLedgerMutation(method, path) {
  if (method === "PUT" && path === "/state") return true;
  return (
    method === "POST" &&
    [
      "/paper/scan",
      "/paper/close",
      "/paper/close-all",
      "/paper/settings",
      "/paper/capital-adjustment",
      "/runner",
    ].includes(path)
  );
}
