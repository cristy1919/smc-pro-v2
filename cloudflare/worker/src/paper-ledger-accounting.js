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
