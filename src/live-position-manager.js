import { getLiveReadiness } from "./live-execution.js";

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export async function manageLivePositions({ env, client, store, adapter, clock = () => Date.now() } = {}) {
  if (env?.LIVE_TRADING_ENABLED !== "true") return { ok: true, skipped: true, reason: "LIVE_TRADING_DISABLED" };
  const readiness = getLiveReadiness(env);
  if (!readiness.ready) return { ok: false, skipped: true, reason: "LIVE_READINESS_BLOCKED", blockers: readiness.blockers };
  if (!client || !store || !adapter) return { ok: false, skipped: true, reason: "LIVE_MANAGEMENT_DEPENDENCIES_MISSING" };

  const [tracked, exchangePositions] = await Promise.all([store.listLivePositions(), client.getOpenPositions()]);
  const results = [];
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

      const tp1 = Number(position.tp1);
      const stage = Number(position.stage ?? 0);
      if (stage >= 1 && (position.side === "LONG" ? Number(position.stopLoss) < Number(position.entry) : Number(position.stopLoss) > Number(position.entry))) {
        await adapter.updateProtection(position, { stopLoss: Number(position.entry), takeProfit: Number(position.takeProfit) });
        await store.saveLivePosition({ ...position, stopLoss: Number(position.entry), lastManagedAt: clock() });
        results.push({ id: position.id, action: "BREAKEVEN_PROTECTION_REPAIRED" });
        continue;
      }
      const reachedTp1 = stage === 0 && positive(tp1) &&
        (position.side === "LONG" ? markPrice >= tp1 : markPrice <= tp1);
      if (reachedTp1) {
        const partial = await adapter.partialClose(position, 0.5);
        const updated = {
          ...position,
          quantity: partial.remainingQuantity,
          stage: 1,
          tp1ReachedAt: clock(),
          lastManagedAt: clock()
        };
        await store.saveLivePosition(updated);
        await adapter.updateProtection(updated, { stopLoss: Number(position.entry), takeProfit: Number(position.takeProfit) });
        results.push({ id: position.id, action: "TP1_HALF_CLOSED_STOP_TO_BREAKEVEN", remainingQuantity: partial.remainingQuantity });
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
