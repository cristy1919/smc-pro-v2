import { RISK_CONFIG } from "./config.js";

const LIVE_BASE = "https://open-api.bingx.com";
const SYMBOL_RE = /^[A-Z0-9]{2,20}-USDT$/;
const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function getLiveManagementReadiness(env = {}) {
  const livePair = !!env.BINGX_LIVE_API_KEY && !!env.BINGX_LIVE_API_SECRET;
  const demoKeyPresent = !!env.BINGX_API_KEY;
  const demoSecretPresent = !!env.BINGX_API_SECRET;
  const demoPairPresent = demoKeyPresent && demoSecretPresent;
  const demoAnyPresent = demoKeyPresent || demoSecretPresent;
  const independent = livePair && (!demoAnyPresent ||
    (demoPairPresent && env.BINGX_LIVE_API_KEY !== env.BINGX_API_KEY &&
      env.BINGX_LIVE_API_SECRET !== env.BINGX_API_SECRET));
  const checks = [
    ["LIVE_API_KEY", !!env.BINGX_LIVE_API_KEY],
    ["LIVE_API_SECRET", !!env.BINGX_LIVE_API_SECRET],
    ["LIVE_CREDENTIALS_SEPARATE_FROM_DEMO", independent],
    ["LIVE_CONFIRMATION_SECRET", !!env.LIVE_CONTROL_TOKEN],
    ["LIVE_BASE_URL_LOCKED", LIVE_BASE === "https://open-api.bingx.com"]
  ];
  const blockers = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return { ready: blockers.length === 0, blockers };
}

export function getLiveReadiness(env = {}) {
  const livePair = !!env.BINGX_LIVE_API_KEY && !!env.BINGX_LIVE_API_SECRET;
  const demoKeyPresent = !!env.BINGX_API_KEY;
  const demoSecretPresent = !!env.BINGX_API_SECRET;
  const demoPairPresent = demoKeyPresent && demoSecretPresent;
  const demoAnyPresent = demoKeyPresent || demoSecretPresent;
  const credentialsIndependent = livePair && (!demoAnyPresent ||
    (demoPairPresent && env.BINGX_LIVE_API_KEY !== env.BINGX_API_KEY &&
      env.BINGX_LIVE_API_SECRET !== env.BINGX_API_SECRET));
  const checks = [
    ["LIVE_API_KEY", !!env.BINGX_LIVE_API_KEY],
    ["LIVE_API_SECRET", !!env.BINGX_LIVE_API_SECRET],
    ["LIVE_CREDENTIALS_SEPARATE_FROM_DEMO", credentialsIndependent],
    ["LIVE_CONFIRMATION_SECRET", !!env.LIVE_CONTROL_TOKEN],
    ["LIVE_BASE_URL_LOCKED", LIVE_BASE === "https://open-api.bingx.com"]
  ];
  const blockers = checks.filter(([name, passed]) => !passed).map(([name]) => name);
  return {
    mode: "live-readiness",
    ready: blockers.length === 0,
    liveTradingEnabled: env.LIVE_TRADING_ENABLED === "true",
    apiCredentialsConfigured: livePair,
    demoCredentialsConfigured: demoPairPresent,
    demoCredentialsIndependent: credentialsIndependent,
    checks: checks.map(([name, passed]) => ({ name, passed })),
    blockers
  };
}

export function validateLiveCandidate(candidate, {
  equity, availableMargin, openPositions = [], contract, markPrice, riskMultiple = 1,
  explicitConfirmation = false, idempotencyKey
} = {}) {
  const reasons = [];
  if (!candidate || candidate.engine !== "swing") reasons.push("INVALID_ENGINE");
  if (!["4h", "1d"].includes(String(candidate?.setupTimeframe ?? "").toLowerCase())) reasons.push("FORBIDDEN_SETUP_TIMEFRAME");
  if (candidate?.status !== "QUALIFIED" || candidate?.entryEligible !== true) reasons.push("CANDIDATE_NOT_ENTRY_READY");
  if (candidate?.entryConfirmation?.status !== "CONFIRMED") reasons.push("ENTRY_CONFIRMATION_REQUIRED");
  if (!SYMBOL_RE.test(candidate?.symbol ?? "")) reasons.push("INVALID_SYMBOL");
  if (!["LONG", "SHORT", "BULLISH", "BEARISH"].includes(candidate?.direction)) reasons.push("INVALID_DIRECTION");
  if (!explicitConfirmation) reasons.push("EXPLICIT_LIVE_CONFIRMATION_REQUIRED");
  if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{12,40}$/.test(idempotencyKey)) reasons.push("IDEMPOTENCY_KEY_REQUIRED");
  if (!finitePositive(equity) || !finitePositive(availableMargin)) reasons.push("LIVE_ACCOUNT_BALANCE_UNAVAILABLE");
  if (!Array.isArray(openPositions)) reasons.push("LIVE_POSITION_SNAPSHOT_UNAVAILABLE");
  else if (openPositions.length >= RISK_CONFIG.maxOpenPositions) reasons.push("MAX_OPEN_POSITIONS");
  if (Array.isArray(openPositions) && openPositions.some(p =>
    p.symbol === candidate?.symbol &&
    p.side === (candidate?.direction === "BULLISH" || candidate?.direction === "LONG" ? "LONG" : "SHORT") && p.state === "OPEN"
  )) reasons.push("DUPLICATE_ENGINE_SYMBOL_SIDE");
  if (!finitePositive(markPrice)) reasons.push("LIVE_MARK_PRICE_UNAVAILABLE");
  if (!contract || !finitePositive(contract.minQty) || !finitePositive(contract.qtyStep) ||
      !finitePositive(contract.tickSize) || !Number.isFinite(Number(contract.minNotional ?? 0)) || Number(contract.minNotional ?? 0) < 0) reasons.push("CONTRACT_RULES_UNAVAILABLE");
  if (![1, 0.5].includes(riskMultiple)) reasons.push("INVALID_RISK_MULTIPLE");
  const side = candidate?.direction === "BULLISH" || candidate?.direction === "LONG" ? "LONG" : "SHORT";
  const entry = Number(markPrice), stop = Number(candidate?.stopLoss), target = Number(candidate?.takeProfit);
  if (!finitePositive(stop) || !finitePositive(target) ||
      (side === "LONG" ? !(stop < entry && target > entry) : !(target < entry && stop > entry))) reasons.push("INVALID_TRADE_LEVELS");
  const rr = finitePositive(stop) && finitePositive(target) && finitePositive(entry)
    ? Math.abs(target - entry) / Math.abs(entry - stop) : 0;
  if (rr < RISK_CONFIG.minRewardRisk) reasons.push("MINIMUM_RR_NOT_MET");
  if (rr > RISK_CONFIG.maxRewardRisk) reasons.push("MAXIMUM_RR_EXCEEDED");
  const risky = riskMultiple === 0.5;
  const minLeverage = RISK_CONFIG.minLeverage;
  const maxLeverage = RISK_CONFIG.maxLeverage;
  const requestedLeverage = Number(candidate?.leverage);
  if (!Number.isInteger(requestedLeverage) || requestedLeverage < minLeverage || requestedLeverage > maxLeverage)
    reasons.push("LEVERAGE_OUTSIDE_POLICY");
  if (candidate?.marginMode !== "ISOLATED") reasons.push("ISOLATED_MARGIN_REQUIRED");
  if (contract && finitePositive(contract.maxLeverage) && requestedLeverage > contract.maxLeverage)
    reasons.push("CONTRACT_LEVERAGE_LIMIT");
  return {
    eligible: reasons.length === 0,
    reasons,
    side,
    riskMultiple,
    riskBudget: finitePositive(equity) ? Number(equity) * RISK_CONFIG.riskUnitFraction * riskMultiple : null,
    marginMode: "ISOLATED",
    leverage: reasons.length === 0 ? requestedLeverage : null,
    rewardRisk: rr
  };
}

export class BingXLiveExecutionAdapter {
  constructor({ env, client, store, clock = () => Date.now() } = {}) {
    this.env = env ?? {};
    this.client = client;
    this.store = store;
    this.clock = clock;
  }

  readiness() { return getLiveReadiness(this.env); }
  managementReadiness() { return getLiveManagementReadiness(this.env); }

  async emergencyCloseAndVerify(record, exchangePosition, reason, reservationKey) {
    let persisted = false;
    try {
      await this.store.saveLivePosition(record);
      persisted = true;
    } catch { /* exchange closure is still attempted even if local persistence is degraded */ }
    await this.client.emergencyClose({ symbol: record.symbol, side: record.side, position: exchangePosition ?? null });
    const after = await this.client.getPosition(record.symbol, record.side);
    if (after && Math.abs(Number(after.positionAmt)) > 0)
      throw new Error(reason + "_EMERGENCY_CLOSE_NOT_CONFIRMED");
    if (persisted) {
      try { await this.store.markLivePositionClosed(record.id, { closedAt: this.clock(), closeReason: reason }); }
      catch { /* next reconciliation cycle will mark the now-flat record closed */ }
    }
    if (reservationKey && typeof this.store.releaseEntrySlot === "function") {
      try { await this.store.releaseEntrySlot(reservationKey); } catch { /* reservation expires automatically */ }
    }
    throw new Error(reason + "_POSITION_CLOSED");
  }

  async submit(candidate, { riskMultiple, confirmation, idempotencyKey } = {}) {
    riskMultiple = Number.isFinite(riskMultiple) ? riskMultiple : Number(candidate?.riskMultiplier ?? 1);
    const readiness = this.readiness();
    if (!readiness.ready || this.env.LIVE_TRADING_ENABLED !== "true")
      throw new Error("LIVE_EXECUTION_LOCKED:" + readiness.blockers.join(","));
    const freshConfirmation = confirmation?.confirmedByUser === true &&
      confirmation.token === this.env.LIVE_CONTROL_TOKEN &&
      Number.isFinite(confirmation.confirmedAt) &&
      this.clock() - confirmation.confirmedAt <= 60000 &&
      this.clock() >= confirmation.confirmedAt;
    let activationConfirmation = false;
    if (!freshConfirmation && typeof this.store?.getActivation === "function") {
      const activation = await this.store.getActivation();
      activationConfirmation = activation?.active === true && activation.confirmedByUser === true &&
        typeof activation.id === "string" && confirmation?.activationId === activation.id &&
        confirmation?.token === this.env.LIVE_CONTROL_TOKEN;
    }
    if (!freshConfirmation && !activationConfirmation)
      throw new Error("LIVE_CONFIRMATION_INVALID_OR_EXPIRED");
    if (!this.client || !this.store) throw new Error("LIVE_EXECUTION_DEPENDENCIES_UNAVAILABLE");
    if (typeof this.client.getPositionMode !== "function" || !(await this.client.getPositionMode()))
      throw new Error("LIVE_HEDGE_MODE_REQUIRED");
    if (typeof this.client.getOpenOrders !== "function") throw new Error("LIVE_OPEN_ORDER_SNAPSHOT_REQUIRED");
    if (typeof this.store.claimIdempotencyKey !== "function" ||
        typeof this.store.releaseIdempotencyKey !== "function" ||
        typeof this.store.reserveEntrySlot !== "function" ||
        typeof this.store.releaseEntrySlot !== "function")
      throw new Error("LIVE_IDEMPOTENCY_AND_CAPACITY_STORE_REQUIRED");
    if (!await this.store.claimIdempotencyKey(idempotencyKey, { ttlMs: 86400000 }))
      throw new Error("DUPLICATE_LIVE_REQUEST");

    let accepted = false;
    let reserved = false;
    try {
      const [account, positions, openOrders, markPrice, contract] = await Promise.all([
        this.client.getAccountSnapshot(), this.client.getOpenPositions(), this.client.getOpenOrders(),
        this.client.getMarkPrice(candidate?.symbol), this.client.getContractRules(candidate?.symbol)
      ]);
      const requestedSide = candidate?.direction === "BULLISH" || candidate?.direction === "LONG" ? "LONG" : "SHORT";
      if (openOrders.some(order => order.symbol === candidate?.symbol &&
        String(order.positionSide).toUpperCase() === requestedSide &&
        !["CANCELED", "CANCELLED", "FILLED", "EXPIRED", "FAILED"].includes(String(order.status).toUpperCase())))
        throw new Error("LIVE_DUPLICATE_PENDING_ORDER");
      if (account?.asset !== "USDT" || account?.source !== "BINGX_LIVE" ||
          !finitePositive(account?.equity) || !finitePositive(account?.availableMargin))
        throw new Error("VERIFIED_LIVE_USDT_EQUITY_REQUIRED");
      const normalizedCandidate = {
        ...candidate,
        stopLoss: this.client.roundPrice(candidate.stopLoss, contract),
        takeProfit: this.client.roundPrice(candidate.takeProfit, contract)
      };
      const decision = validateLiveCandidate(normalizedCandidate, {
        equity: account.equity, availableMargin: account.availableMargin, openPositions: positions,
        contract, markPrice, riskMultiple, explicitConfirmation: true, idempotencyKey
      });
      if (!decision.eligible) throw new Error("LIVE_RISK_REJECTED:" + decision.reasons.join(","));
      const sideMaxLeverage = decision.side === "LONG" ? Number(contract.maxLongLeverage ?? contract.maxLeverage) : Number(contract.maxShortLeverage ?? contract.maxLeverage);
      if (!finitePositive(sideMaxLeverage) || decision.leverage > sideMaxLeverage) throw new Error("LIVE_SIDE_LEVERAGE_LIMIT");
      const symbol = candidate.symbol;
      const margin = await this.client.getMarginMode(symbol);
      if (margin !== "ISOLATED") await this.client.setMarginMode(symbol, "ISOLATED");
      const verifiedMarginMode = await this.client.getMarginMode(symbol);
      if (verifiedMarginMode !== "ISOLATED") throw new Error("LIVE_ISOLATED_MARGIN_VERIFICATION_FAILED");
      const leverageSide = decision.side;
      await this.client.setLeverage(symbol, leverageSide, decision.leverage);
      const verifiedLeverage = await this.client.getLeverage(symbol, leverageSide);
      if (Number(verifiedLeverage) !== decision.leverage) throw new Error("LIVE_LEVERAGE_VERIFICATION_FAILED");
      const quantity = this.client.roundQuantity(decision.riskBudget, markPrice, normalizedCandidate.stopLoss, contract, decision.leverage, account.availableMargin);
      if (!finitePositive(quantity) || quantity < Number(contract.minQty) || (Number(contract.minNotional) > 0 && quantity * Number(markPrice) < Number(contract.minNotional)) ||
          Math.abs(quantity / Number(contract.qtyStep) - Math.round(quantity / Number(contract.qtyStep))) > 1e-8)
        throw new Error("LIVE_ORDER_QUANTITY_INVALID");
      const slot = await this.store.reserveEntrySlot(idempotencyKey, {
        symbol, side: decision.side, observedOpenPositions: positions.length,
        maxPositions: RISK_CONFIG.maxOpenPositions, ttlMs: 120000
      });
      if (slot?.claimed !== true) throw new Error("LIVE_ENTRY_SLOT_REJECTED:" + String(slot?.reason ?? "UNKNOWN"));
      reserved = true;
      const bracket = {
        stopLoss: Number(normalizedCandidate.stopLoss), takeProfit: Number(normalizedCandidate.takeProfit),
        workingType: "MARK_PRICE", quantity
      };
      if (typeof this.client.getOrder !== "function" || typeof this.client.cancelOrder !== "function")
        throw new Error("LIVE_ORDER_STATUS_AND_CANCEL_REQUIRED");
      const pendingId = "live-" + idempotencyKey;
      const pendingRecord = {
        id: pendingId, candidateId: candidate.id, engine: candidate.engine,
        tradeStyle: candidate.engine.toUpperCase(), symbol, side: decision.side,
        quantity, qty: quantity, entry: Number(markPrice),
        stopLoss: bracket.stopLoss, takeProfit: bracket.takeProfit,
        tp1: Number(candidate.tp1 ?? candidate.takeProfit),
        tp2: Number(candidate.tp2 ?? candidate.takeProfit),
        tp3: Number(candidate.tp3 ?? candidate.takeProfit),
        leverage: decision.leverage, marginMode: "ISOLATED", riskMultiple,
        riskBudget: decision.riskBudget, mode: "BINGX_LIVE", state: "PENDING",
        status: "PENDING", openedAt: this.clock(), entryClientOrderId: idempotencyKey,
        entryOrderId: null, riskStatus: "ENTRY_SUBMISSION_PENDING"
      };
      await this.store.saveLivePosition(pendingRecord);
      accepted = true; // A write timeout is an unknown outcome; the pending record and slot stay reserved.
      const order = await this.client.placeEntryWithProtection({
        symbol, side: decision.side, quantity, marginMode: "ISOLATED",
        leverage: decision.leverage, bracket, clientOrderId: idempotencyKey
      });
      const orderId = order?.orderID ?? order?.orderId ?? null;
      let orderState = await this.client.getOrder(symbol, {
        ...(orderId != null ? { orderId: String(orderId) } : {}),
        clientOrderId: idempotencyKey
      });
      let orderStatus = String(orderState?.status ?? "").toUpperCase().replaceAll("_", "");
      await this.store.saveLivePosition({
        ...pendingRecord, entryOrderId: String(orderId ?? idempotencyKey),
        exchangeOrderStatus: orderStatus || "UNKNOWN"
      });
      if (["NEW", "PENDING", "PARTIALLYFILLED"].includes(orderStatus)) {
        await this.client.cancelOrder(symbol, {
          ...(orderId != null ? { orderId: String(orderId) } : {}),
          clientOrderId: idempotencyKey
        });
        orderState = await this.client.getOrder(symbol, {
          ...(orderId != null ? { orderId: String(orderId) } : {}),
          clientOrderId: idempotencyKey
        });
        orderStatus = String(orderState?.status ?? "").toUpperCase().replaceAll("_", "");
      }
      const executedQuantity = Math.abs(Number(orderState?.executedQty ?? 0));
      const synced = await this.client.reconcilePosition(symbol, decision.side);
      if (!synced?.position && ["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(orderStatus) && executedQuantity === 0) {
        await this.store.markLivePositionClosed(pendingId, {
          closedAt: this.clock(), closeReason: "ENTRY_ORDER_CANCELLED_WITHOUT_FILL",
          entryOrderId: orderId == null ? null : String(orderId)
        });
        await this.store.releaseEntrySlot(idempotencyKey);
        reserved = false;
        throw new Error("LIVE_ENTRY_ORDER_CANCELLED_WITHOUT_FILL");
      }
      if (!synced?.position || !["FILLED", "PARTIALLYFILLED", "CANCELLED", "CANCELED"].includes(orderStatus))
        throw new Error("LIVE_ENTRY_OUTCOME_UNKNOWN_RECONCILIATION_REQUIRED:" + (orderStatus || "NO_ORDER_STATUS"));
      const actualEntry = Number(synced?.position?.entryPrice ?? markPrice);
      const actualQuantity = Math.abs(Number(synced?.position?.positionAmt ?? quantity));
      const actualStopValid = decision.side === "LONG"
        ? Number(normalizedCandidate.stopLoss) < actualEntry && Number(normalizedCandidate.takeProfit) > actualEntry
        : Number(normalizedCandidate.takeProfit) < actualEntry && Number(normalizedCandidate.stopLoss) > actualEntry;
      const actualRisk = actualQuantity * (Math.abs(actualEntry - Number(normalizedCandidate.stopLoss)) +
        actualEntry * 0.0007 + Number(normalizedCandidate.stopLoss) * 0.0007);
      const actualRewardRisk = Math.abs(Number(normalizedCandidate.takeProfit) - actualEntry) /
        Math.max(1e-12, Math.abs(actualEntry - Number(normalizedCandidate.stopLoss)));
      if (!synced?.position || synced.protection?.stopLoss !== true || synced.protection?.takeProfit !== true ||
          !finitePositive(actualEntry) || !finitePositive(actualQuantity) || !actualStopValid ||
          actualRewardRisk < RISK_CONFIG.minRewardRisk || actualRisk > decision.riskBudget * 1.1) {
        const emergencyRecord = {
          id: pendingId,
          candidateId: candidate.id, engine: candidate.engine, tradeStyle: candidate.engine.toUpperCase(), symbol, side: decision.side,
          quantity: finitePositive(actualQuantity) ? actualQuantity : quantity,
          qty: finitePositive(actualQuantity) ? actualQuantity : quantity,
          entry: finitePositive(actualEntry) ? actualEntry : markPrice,
          stopLoss: Number(normalizedCandidate.stopLoss), takeProfit: Number(normalizedCandidate.takeProfit),
          tp1: Number(candidate.tp1 ?? candidate.takeProfit), tp2: Number(candidate.tp2 ?? candidate.takeProfit),
          leverage: decision.leverage, marginMode: "ISOLATED", riskMultiple,
          marginUsdt: (finitePositive(actualQuantity) ? actualQuantity : quantity) * (finitePositive(actualEntry) ? actualEntry : markPrice) / decision.leverage,
          status: "OPEN", tp3: Number(candidate.tp3 ?? candidate.takeProfit),
          setupTimeframe: candidate.setupTimeframe, entryTimeframe: candidate.entryTimeframe,
          riskBudget: decision.riskBudget, mode: "BINGX_LIVE", state: "OPEN",
          openedAt: this.clock(), riskStatus: "EMERGENCY_CLOSE_REQUIRED",
          entryOrderId: String(orderId ?? idempotencyKey), entryClientOrderId: idempotencyKey
        };
        await this.emergencyCloseAndVerify(emergencyRecord, synced?.position, "LIVE_POST_FILL_GUARD", idempotencyKey);
      }
      const position = {
        id: pendingId, positionId: String(synced.position.positionId ?? ""),
        candidateId: candidate.id, engine: candidate.engine, symbol, side: decision.side,
        quantity: actualQuantity, qty: actualQuantity, entry: actualEntry, initialRiskUsdt: actualRisk,
        marginUsdt: actualQuantity * actualEntry / decision.leverage, status: "OPEN",
        stopLoss: bracket.stopLoss, takeProfit: bracket.takeProfit, tp1: Number(candidate.tp1 ?? candidate.takeProfit), tp2: Number(candidate.tp2 ?? candidate.takeProfit), tp3: Number(candidate.tp3 ?? candidate.takeProfit), stage: 0, leverage: decision.leverage, setupTimeframe: candidate.setupTimeframe, entryTimeframe: candidate.entryTimeframe,
        marginMode: "ISOLATED", riskMultiple, riskBudget: decision.riskBudget,
        mode: "BINGX_LIVE", state: "OPEN", openedAt: this.clock(),
        entryOrderId: String(order?.orderID ?? order?.orderId ?? idempotencyKey)
      };
      try {
        await this.store.saveLivePosition(position);
      } catch (storageError) {
        await this.emergencyCloseAndVerify({ ...position, riskStatus: "POSITION_PERSISTENCE_FAILED" }, synced.position,
          "LIVE_POSITION_PERSISTENCE_FAILED", idempotencyKey);
      }
      await this.store.releaseEntrySlot(idempotencyKey);
      reserved = false;
      return { ok: true, position };
    } catch (error) {
      if (!accepted) {
        if (reserved) await this.store.releaseEntrySlot(idempotencyKey);
        await this.store.releaseIdempotencyKey(idempotencyKey);
      }
      throw error;
    }
  }

  async updateProtection(position, { stopLoss, takeProfit } = {}) {
    if (!this.managementReadiness().ready)
      throw new Error("LIVE_PROTECTION_PATH_LOCKED");
    if (!position || position.mode !== "BINGX_LIVE" || position.state !== "OPEN")
      throw new Error("INVALID_LIVE_POSITION");
    if (!finitePositive(stopLoss) || !finitePositive(takeProfit) || !finitePositive(position.entry))
      throw new Error("INVALID_LIVE_PROTECTION_LEVELS");
    const [markPrice, contract] = await Promise.all([
      this.client.getMarkPrice(position.symbol), this.client.getContractRules(position.symbol)
    ]);
    const roundedStop = this.client.roundPrice(stopLoss, contract);
    const roundedTarget = this.client.roundPrice(takeProfit, contract);
    if (position.side === "LONG" ? !(roundedStop < markPrice && roundedTarget > markPrice && roundedStop < roundedTarget) :
      !(roundedTarget < markPrice && roundedStop > markPrice && roundedStop > roundedTarget))
      throw new Error("LIVE_PROTECTION_DIRECTION_INVALID");
    await this.client.setPositionProtection(position, {
      stopLoss: roundedStop, takeProfit: roundedTarget, workingType: "MARK_PRICE"
    });
    const check = await this.client.reconcilePosition(position.symbol, position.side);
    if (!check?.position || check.protection?.stopLoss !== true || check.protection?.takeProfit !== true)
      throw new Error("LIVE_PROTECTION_UPDATE_NOT_CONFIRMED");
    const updated = { ...position, stopLoss: roundedStop, takeProfit: roundedTarget, protectionVerifiedAt: this.clock() };
    await this.store.saveLivePosition(updated);
    return { ok: true, position: updated };
  }

  async partialClose(position, fraction, clientOrderId) {
    if (!this.managementReadiness().ready)
      throw new Error("LIVE_PARTIAL_CLOSE_PATH_LOCKED");
    if (!position || position.mode !== "BINGX_LIVE" || position.state !== "OPEN")
      throw new Error("INVALID_LIVE_POSITION");
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
      throw new Error("INVALID_PARTIAL_CLOSE_FRACTION");
    if (typeof clientOrderId !== "string" || !/^[a-zA-Z0-9_-]{12,40}$/.test(clientOrderId) ||
        typeof this.client.getOrder !== "function")
      throw new Error("LIVE_PARTIAL_CLOSE_IDEMPOTENCY_REQUIRED");
    const current = await this.client.getPosition(position.symbol, position.side);
    const currentQty = Math.abs(Number(current?.positionAmt));
    if (!finitePositive(currentQty)) throw new Error("LIVE_POSITION_QUANTITY_UNAVAILABLE");
    const contract = await this.client.getContractRules(position.symbol);
    if (!finitePositive(contract?.qtyStep)) throw new Error("LIVE_CONTRACT_STEP_UNAVAILABLE");
    const rawQty = currentQty * fraction;
    const quantity = Math.floor(rawQty / Number(contract.qtyStep) + 1e-10) * Number(contract.qtyStep);
    if (!finitePositive(quantity) || quantity >= currentQty || quantity < Number(contract.minQty))
      throw new Error("LIVE_PARTIAL_CLOSE_QUANTITY_INVALID");
    const result = await this.client.reducePosition({
      symbol: position.symbol, side: position.side, quantity, clientOrderId
    });
    let order = await this.client.getOrder(position.symbol, { clientOrderId });
    let status = String(order?.status ?? "").toUpperCase().replaceAll("_", "");
    if (["NEW", "PENDING", "PARTIALLYFILLED"].includes(status)) {
      if (typeof this.client.cancelOrder !== "function") throw new Error("LIVE_PARTIAL_CLOSE_CANCEL_REQUIRED");
      await this.client.cancelOrder(position.symbol, { clientOrderId });
      order = await this.client.getOrder(position.symbol, { clientOrderId });
      status = String(order?.status ?? "").toUpperCase().replaceAll("_", "");
    }
    const executed = Math.abs(Number(order?.executedQty ?? 0));
    const remaining = await this.client.getPosition(position.symbol, position.side);
    if (!remaining || !finitePositive(Math.abs(Number(remaining.positionAmt))) ||
        Math.abs(Number(remaining.positionAmt)) >= currentQty || !finitePositive(executed) ||
        !["FILLED", "PARTIALLYFILLED", "CANCELLED", "CANCELED"].includes(status))
      throw new Error("LIVE_PARTIAL_CLOSE_NOT_CONFIRMED:" + (status || "UNKNOWN"));
    return { ok: true, result, remainingQuantity: Math.abs(Number(remaining.positionAmt)), executedQuantity: executed, orderStatus: status };
  }

  async close(position) {
    if (!this.managementReadiness().ready)
      throw new Error("LIVE_CLOSE_PATH_LOCKED");
    if (!position || position.mode !== "BINGX_LIVE" || position.state !== "OPEN")
      throw new Error("INVALID_LIVE_POSITION");
    const result = await this.client.closePosition(position);
    const verified = await this.client.getPosition(position.symbol, position.side);
    if (verified && Number(verified.positionAmt) !== 0) throw new Error("LIVE_CLOSE_NOT_CONFIRMED");
    await this.store.markLivePositionClosed(position.id, { closedAt: this.clock(), exchangeResult: result });
    return { ok: true, result };
  }
}
