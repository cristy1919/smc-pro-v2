import { getLiveManagementReadiness } from "./live-execution.js";

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function findConfirmedTrailingStop(candles, side, currentStop, markPrice, tickSize, openedAt = 0) {
  if (!Array.isArray(candles) || candles.length < 5 || !["LONG", "SHORT"].includes(side) ||
      ![currentStop, markPrice, tickSize].every(positive)) return null;
  let selected = null;
  for (let i = 2; i + 2 < candles.length; i++) {
    const pivot = candles[i], confirmation = candles[i + 2];
    if (Number(confirmation.time) <= Number(openedAt)) continue;
    if (side === "LONG") {
      const isPivot = candles.slice(i - 2, i).every(x => pivot.low <= x.low) &&
        candles.slice(i + 1, i + 3).every(x => pivot.low < x.low);
      const stopPrice = Number(pivot.low) - Number(tickSize);
      if (isPivot && stopPrice > currentStop && stopPrice < markPrice && (!selected || confirmation.time > selected.confirmedAt))
        selected = { stopPrice, pivotTime: pivot.time, confirmedAt: confirmation.time };
    } else {
      const isPivot = candles.slice(i - 2, i).every(x => pivot.high >= x.high) &&
        candles.slice(i + 1, i + 3).every(x => pivot.high > x.high);
      const stopPrice = Number(pivot.high) + Number(tickSize);
      if (isPivot && stopPrice < currentStop && stopPrice > markPrice && (!selected || confirmation.time > selected.confirmedAt))
        selected = { stopPrice, pivotTime: pivot.time, confirmedAt: confirmation.time };
    }
  }
  return selected;
}

export async function manageLivePositions({ env, client, store, adapter, clock = () => Date.now() } = {}) {
  const readiness = getLiveManagementReadiness(env);
  if (!readiness.ready) return { ok: false, skipped: true, reason: "LIVE_READINESS_BLOCKED", blockers: readiness.blockers };
  if (!client || !store || !adapter) return { ok: false, skipped: true, reason: "LIVE_MANAGEMENT_DEPENDENCIES_MISSING" };

  const [tracked, exchangePositions] = await Promise.all([store.listLivePositions(), client.getOpenPositions()]);
  const results = [];
  for (const pending of tracked.filter(item => item?.mode === "BINGX_LIVE" && item.state === "PENDING")) {
    try {
      if (typeof client.getOrder !== "function" || typeof client.getPosition !== "function") {
        results.push({ id: pending.id, action: "PENDING_ENTRY_REQUIRES_ORDER_RECONCILIATION" });
        continue;
      }
      let order = await client.getOrder(pending.symbol, {
        ...(pending.entryOrderId ? { orderId: pending.entryOrderId } : {}),
        clientOrderId: pending.entryClientOrderId
      });
      let status = String(order?.status ?? "").toUpperCase().replaceAll("_", "");
      let executed = Math.abs(Number(order?.executedQty ?? 0));
      let exchangePosition = await client.getPosition(pending.symbol, pending.side);
      if (["NEW", "PENDING", "PARTIALLYFILLED"].includes(status) &&
          (status === "PARTIALLYFILLED" || clock() - Number(pending.openedAt) > 90000)) {
        await client.cancelOrder(pending.symbol, {
          ...(pending.entryOrderId ? { orderId: pending.entryOrderId } : {}),
          clientOrderId: pending.entryClientOrderId
        });
        order = await client.getOrder(pending.symbol, {
          ...(pending.entryOrderId ? { orderId: pending.entryOrderId } : {}),
          clientOrderId: pending.entryClientOrderId
        });
        status = String(order?.status ?? "").toUpperCase().replaceAll("_", "");
        executed = Math.abs(Number(order?.executedQty ?? 0));
        exchangePosition = await client.getPosition(pending.symbol, pending.side);
      }
      if (!exchangePosition && ["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(status) && executed === 0) {
        await store.markLivePositionClosed(pending.id, {
          closedAt: clock(), closeReason: "PENDING_ENTRY_CANCELLED_WITHOUT_FILL"
        });
        if (pending.entryClientOrderId && typeof store.releaseEntrySlot === "function")
          await store.releaseEntrySlot(pending.entryClientOrderId);
        results.push({ id: pending.id, action: "PENDING_ENTRY_CANCELLED_UNFILLED" });
        continue;
      }
      if (!exchangePosition || !["FILLED", "PARTIALLYFILLED", "CANCELLED", "CANCELED"].includes(status)) {
        results.push({ id: pending.id, action: "PENDING_ENTRY_OUTCOME_UNKNOWN", status: status || "UNKNOWN" });
        continue;
      }
      if (exchangePosition.isolated !== true && String(exchangePosition.marginType ?? "").toUpperCase() !== "ISOLATED") {
        await client.emergencyClose({ symbol: pending.symbol, side: pending.side, position: exchangePosition });
        const after = await client.getPosition(pending.symbol, pending.side);
        if (after && Math.abs(Number(after.positionAmt)) > 0)
          throw new Error("PENDING_ENTRY_CROSS_MARGIN_CLOSE_UNCONFIRMED");
        await store.markLivePositionClosed(pending.id, { closedAt: clock(), closeReason: "PENDING_ENTRY_NOT_ISOLATED" });
        if (pending.entryClientOrderId && typeof store.releaseEntrySlot === "function")
          await store.releaseEntrySlot(pending.entryClientOrderId);
        results.push({ id: pending.id, action: "PENDING_ENTRY_CLOSED_CROSS_MARGIN" });
        continue;
      }
      const reconciled = await client.reconcilePosition(pending.symbol, pending.side);
      if (!reconciled?.position || reconciled.protection?.stopLoss !== true || reconciled.protection?.takeProfit !== true) {
        await client.emergencyClose({ symbol: pending.symbol, side: pending.side, position: reconciled?.position ?? exchangePosition });
        const after = await client.getPosition(pending.symbol, pending.side);
        if (after && Math.abs(Number(after.positionAmt)) > 0)
          throw new Error("PENDING_ENTRY_PROTECTION_CLOSE_UNCONFIRMED");
        await store.markLivePositionClosed(pending.id, { closedAt: clock(), closeReason: "PENDING_ENTRY_PROTECTION_MISSING" });
        if (pending.entryClientOrderId && typeof store.releaseEntrySlot === "function")
          await store.releaseEntrySlot(pending.entryClientOrderId);
        results.push({ id: pending.id, action: "PENDING_ENTRY_CLOSED_MISSING_PROTECTION" });
        continue;
      }
      const opened = {
        ...pending, state: "OPEN", status: "OPEN",
        positionId: String(exchangePosition.positionId ?? ""),
        entry: Number(exchangePosition.entryPrice ?? exchangePosition.avgPrice ?? pending.entry),
        quantity: Math.abs(Number(exchangePosition.positionAmt)),
        qty: Math.abs(Number(exchangePosition.positionAmt)),
        openedAt: Number(exchangePosition.time ?? pending.openedAt),
        riskStatus: "ENTRY_RECONCILED",
        exchangeOrderStatus: status
      };
      await store.saveLivePosition(opened);
      if (pending.entryClientOrderId && typeof store.releaseEntrySlot === "function")
        await store.releaseEntrySlot(pending.entryClientOrderId);
      results.push({ id: pending.id, action: "PENDING_ENTRY_RECONCILED_OPEN" });
    } catch (error) {
      console.error("Pending live entry reconciliation failed", pending.id, String(error).slice(0, 200));
      results.push({ id: pending.id, action: "PENDING_ENTRY_RECONCILIATION_ERROR", error: String(error).slice(0, 180) });
    }
  }
  for (const position of tracked.filter(item => item?.mode === "BINGX_LIVE" && item.state === "OPEN")) {
    try {
      const exchangePosition = exchangePositions.find(item =>
        item.symbol === position.symbol && String(item.side).toUpperCase() === position.side &&
        Math.abs(Number(item.positionAmt)) > 0
      );
      if (!exchangePosition) {
        await store.markLivePositionClosed(position.id, { closedAt: clock(), closeReason: "EXCHANGE_POSITION_NO_LONGER_OPEN" });
        results.push({ id: position.id, action: "RECONCILED_CLOSED" });
        continue;
      }
      if (exchangePosition.isolated !== true && String(exchangePosition.marginType ?? "").toUpperCase() !== "ISOLATED") {
        await client.emergencyClose({ symbol: position.symbol, side: position.side, position: exchangePosition });
        const after = await client.getPosition(position.symbol, position.side);
        if (after && Math.abs(Number(after.positionAmt)) > 0) throw new Error("LIVE_CROSS_MARGIN_POSITION_EMERGENCY_CLOSE_UNCONFIRMED");
        await store.markLivePositionClosed(position.id, { closedAt: clock(), closeReason: "ISOLATED_MARGIN_GUARD" });
        results.push({ id: position.id, action: "CLOSED_CROSS_MARGIN_GUARD" });
        continue;
      }

      const [markPrice, reconciled] = await Promise.all([
        client.getMarkPrice(position.symbol),
        client.reconcilePosition(position.symbol, position.side)
      ]);
      if (!positive(markPrice)) throw new Error("LIVE_MANAGEMENT_MARK_PRICE_UNAVAILABLE");
      if (!reconciled?.position || reconciled.protection?.stopLoss !== true || reconciled.protection?.takeProfit !== true) {
        await client.emergencyClose({ symbol: position.symbol, side: position.side, position: reconciled?.position ?? exchangePosition });
        const after = await client.getPosition(position.symbol, position.side);
        if (after && Math.abs(Number(after.positionAmt)) > 0)
          throw new Error("LIVE_PROTECTION_MISSING_EMERGENCY_CLOSE_UNCONFIRMED");
        await store.markLivePositionClosed(position.id, { closedAt: clock(), closeReason: "PROTECTION_MISSING" });
        results.push({ id: position.id, action: "CLOSED_MISSING_PROTECTION" });
        continue;
      }

      if (position.tp1ExecutionState === "PENDING") {
        if (typeof client.getOrder !== "function" || typeof client.getPosition !== "function") {
          results.push({ id: position.id, action: "TP1_REQUIRES_ORDER_RECONCILIATION" });
          continue;
        }
        let tp1Order = await client.getOrder(position.symbol, { clientOrderId: position.tp1ClientOrderId });
        let tp1Status = String(tp1Order?.status ?? "").toUpperCase().replaceAll("_", "");
        let tp1Executed = Math.abs(Number(tp1Order?.executedQty ?? 0));
        let currentPosition = await client.getPosition(position.symbol, position.side);
        if (["NEW", "PENDING", "PARTIALLYFILLED"].includes(tp1Status) &&
            (tp1Status === "PARTIALLYFILLED" || clock() - Number(position.tp1ExecutionStartedAt) > 90000)) {
          if (typeof client.cancelOrder !== "function") throw new Error("TP1_CANCEL_RECONCILIATION_REQUIRED");
          await client.cancelOrder(position.symbol, { clientOrderId: position.tp1ClientOrderId });
          tp1Order = await client.getOrder(position.symbol, { clientOrderId: position.tp1ClientOrderId });
          tp1Status = String(tp1Order?.status ?? "").toUpperCase().replaceAll("_", "");
          tp1Executed = Math.abs(Number(tp1Order?.executedQty ?? 0));
          currentPosition = await client.getPosition(position.symbol, position.side);
        }
        const currentQuantity = Math.abs(Number(currentPosition?.positionAmt ?? 0));
        const initialQuantity = Number(position.quantity ?? position.qty);
        const tp1FilledStatus = ["FILLED", "PARTIALLYFILLED", "CANCELLED", "CANCELED"].includes(tp1Status);
        if (currentPosition && finitePositive(currentQuantity) && finitePositive(initialQuantity) &&
            currentQuantity < initialQuantity - 1e-10 && tp1FilledStatus && finitePositive(tp1Executed)) {
          const confirmed = {
            ...position, quantity: currentQuantity, qty: currentQuantity, stage: 1,
            tp1ExecutionState: "CONFIRMED", tp1ReachedAt: Number(position.tp1ExecutionStartedAt) || clock(),
            lastManagedAt: clock()
          };
          await store.saveLivePosition(confirmed);
          await adapter.updateProtection(confirmed, { stopLoss: Number(position.entry), takeProfit: Number(position.takeProfit) });
          await store.saveLivePosition({ ...confirmed, stopLoss: Number(position.entry) });
          results.push({ id: position.id, action: "TP1_PARTIAL_CLOSE_RECOVERED", remainingQuantity: currentQuantity });
          continue;
        }
        if (!currentPosition && tp1Executed >= initialQuantity && tp1FilledStatus) {
          await store.markLivePositionClosed(position.id, { closedAt: clock(), closeReason: "TP1_ORDER_CLOSED_FULL_POSITION" });
          results.push({ id: position.id, action: "TP1_ORDER_CLOSED_FULL_POSITION" });
          continue;
        }
        if (["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(tp1Status) &&
            tp1Executed === 0 && currentQuantity >= initialQuantity - 1e-10) {
          const attempts = Number(position.tp1Attempt ?? 1);
          const retryState = attempts < 2 ? "RETRY_READY" : "REJECTED";
          await store.saveLivePosition({ ...position, tp1ExecutionState: retryState, tp1ExecutionError: tp1Status });
          results.push({ id: position.id, action: retryState === "RETRY_READY" ? "TP1_RETRY_READY" : "TP1_PARTIAL_CLOSE_REJECTED" });
          continue;
        }
        results.push({ id: position.id, action: "TP1_ORDER_OUTCOME_UNKNOWN", status: tp1Status || "UNKNOWN" });
        continue;
      }

      const tp1 = Number(position.tp1);
      const stage = Number(position.stage ?? 0);
      if (stage >= 1 && (position.side === "LONG" ? Number(position.stopLoss) < Number(position.entry) : Number(position.stopLoss) > Number(position.entry))) {
        await adapter.updateProtection(position, { stopLoss: Number(position.entry), takeProfit: Number(position.takeProfit) });
        await store.saveLivePosition({ ...position, stopLoss: Number(position.entry), lastManagedAt: clock() });
        results.push({ id: position.id, action: "BREAKEVEN_PROTECTION_REPAIRED" });
        continue;
      }
      if (stage >= 1 && typeof client.getCandles === "function" && positive(position.stopLoss)) {
        const interval = position.engine === "scalp" ? "15m" : "4h";
        const candles = await client.getCandles(position.symbol, interval, 120);
        const latestClosedTime = Number(candles.at(-1)?.time) || 0;
        if (latestClosedTime > Number(position.lastTrailingCandleTime ?? 0)) {
          const contract = await client.getContractRules(position.symbol);
          const trailing = findConfirmedTrailingStop(candles, position.side, Number(position.stopLoss), markPrice, Number(contract.tickSize), Number(position.openedAt));
          if (trailing) {
            await adapter.updateProtection(position, { stopLoss: trailing.stopPrice, takeProfit: Number(position.takeProfit) });
            await store.saveLivePosition({ ...position, stopLoss: trailing.stopPrice, lastTrailingCandleTime: latestClosedTime, lastManagedAt: clock() });
            results.push({ id: position.id, action: "STRUCTURAL_TRAILING_STOP_UPDATED", stopLoss: trailing.stopPrice, confirmedAt: trailing.confirmedAt });
            continue;
          }
          await store.saveLivePosition({ ...position, lastTrailingCandleTime: latestClosedTime });
        }
      }
      const reachedTp1 = stage === 0 && position.tp1ExecutionState !== "REJECTED" && positive(tp1) &&
        (position.side === "LONG" ? markPrice >= tp1 : markPrice <= tp1);
      if (reachedTp1) {
        const attempt = Number(position.tp1Attempt ?? 0) + 1;
        const clientOrderId = "tp1-" + String(position.id).slice(-30) + "-" + attempt;
        const pending = {
          ...position, tp1ExecutionState: "PENDING", tp1ClientOrderId: clientOrderId,
          tp1Attempt: attempt, tp1ExecutionStartedAt: clock()
        };
        await store.saveLivePosition(pending);
        const partial = await adapter.partialClose(pending, 0.5, clientOrderId);
        const updated = {
          ...pending,
          quantity: partial.remainingQuantity,
          qty: partial.remainingQuantity,
          stage: 1,
          tp1ExecutionState: "CONFIRMED",
          tp1ReachedAt: clock(),
          lastManagedAt: clock()
        };
        await store.saveLivePosition(updated);
        await adapter.updateProtection(updated, { stopLoss: Number(position.entry), takeProfit: Number(position.takeProfit) });
        await store.saveLivePosition({ ...updated, stopLoss: Number(position.entry) });
        results.push({ id: position.id, action: "TP1_HALF_CLOSED_STOP_TO_BREAKEVEN", remainingQuantity: partial.remainingQuantity });
      } else if (position.tp1ExecutionState === "REJECTED") {
        results.push({ id: position.id, action: "TP1_PARTIAL_CLOSE_REJECTED" });
      } else {
        results.push({ id: position.id, action: "PROTECTION_VERIFIED" });
      }
    } catch (error) {
      console.error("Live position management failed", position.id, String(error).slice(0, 200));
      results.push({ id: position.id, action: "MANAGEMENT_ERROR", error: String(error).slice(0, 180) });
    }
  }
  return { ok: results.every(item => item.action !== "MANAGEMENT_ERROR"), managed: results.length, results };
}
