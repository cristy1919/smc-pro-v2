import { RISK_CONFIG } from "./config.js";

const LIVE_BASE = "https://open-api.bingx.com";
const SYMBOL_RE = /^[A-Z0-9]{2,20}-USDT$/;
const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function getLiveReadiness(env = {}) {
  const checks = [
    ["LIVE_API_KEY", !!env.BINGX_LIVE_API_KEY],
    ["LIVE_API_SECRET", !!env.BINGX_LIVE_API_SECRET],
    ["LIVE_CREDENTIALS_SEPARATE_FROM_DEMO", !!env.BINGX_LIVE_API_KEY && !!env.BINGX_LIVE_API_SECRET && !!env.BINGX_API_KEY && !!env.BINGX_API_SECRET &&
      env.BINGX_LIVE_API_KEY !== env.BINGX_API_KEY && env.BINGX_LIVE_API_SECRET !== env.BINGX_API_SECRET],
    ["LIVE_CONFIRMATION_SECRET", !!env.LIVE_CONTROL_TOKEN],
    ["LIVE_BASE_URL_LOCKED", LIVE_BASE === "https://open-api.bingx.com"]
  ];
  const blockers = checks.filter(([name, passed]) => !passed).map(([name]) => name);
  return {
    mode: "live-readiness",
    ready: blockers.length === 0,
    liveTradingEnabled: env.LIVE_TRADING_ENABLED === "true",
    apiCredentialsConfigured: !!env.BINGX_LIVE_API_KEY && !!env.BINGX_LIVE_API_SECRET,
    demoCredentialsIndependent: !!env.BINGX_LIVE_API_KEY && !!env.BINGX_LIVE_API_SECRET && !!env.BINGX_API_KEY && !!env.BINGX_API_SECRET &&
      env.BINGX_LIVE_API_KEY !== env.BINGX_API_KEY && env.BINGX_LIVE_API_SECRET !== env.BINGX_API_SECRET,
    checks: checks.map(([name, passed]) => ({ name, passed })),
    blockers
  };
}

export function validateLiveCandidate(candidate, {
  equity, availableMargin, openPositions = [], contract, markPrice, riskMultiple = 1,
  explicitConfirmation = false, idempotencyKey
} = {}) {
  const reasons = [];
  if (!candidate || !["scalp", "swing"].includes(candidate.engine)) reasons.push("INVALID_ENGINE");
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
  const risky = riskMultiple === 0.5;
  const minLeverage = risky ? 5 : RISK_CONFIG.minLeverage;
  const maxLeverage = risky ? 10 : RISK_CONFIG.maxLeverage;
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
        typeof this.store.releaseIdempotencyKey !== "function")
      throw new Error("LIVE_IDEMPOTENCY_STORE_REQUIRED");
    if (!await this.store.claimIdempotencyKey(idempotencyKey, { ttlMs: 86400000 }))
      throw new Error("DUPLICATE_LIVE_REQUEST");

    let accepted = false;
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
      const decision = validateLiveCandidate(candidate, {
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
      const quantity = this.client.roundQuantity(decision.riskBudget, markPrice, candidate.stopLoss, contract, decision.leverage, account.availableMargin);
      if (!finitePositive(quantity) || quantity < Number(contract.minQty) || (Number(contract.minNotional) > 0 && quantity * Number(markPrice) < Number(contract.minNotional)) ||
          Math.abs(quantity / Number(contract.qtyStep) - Math.round(quantity / Number(contract.qtyStep))) > 1e-8)
        throw new Error("LIVE_ORDER_QUANTITY_INVALID");
      const bracket = {
        stopLoss: Number(candidate.stopLoss), takeProfit: Number(candidate.takeProfit),
        workingType: "MARK_PRICE", quantity
      };
      accepted = true; // From this point, a network timeout may still mean BingX accepted the order; never release the idempotency claim.
      const order = await this.client.placeEntryWithProtection({
        symbol, side: decision.side, quantity, marginMode: "ISOLATED",
        leverage: decision.leverage, bracket, clientOrderId: idempotencyKey
      });
      const synced = await this.client.reconcilePosition(symbol, decision.side);
      const actualEntry = Number(synced?.position?.entryPrice ?? markPrice);
      const actualQuantity = Math.abs(Number(synced?.position?.positionAmt ?? quantity));
      const actualStopValid = decision.side === "LONG"
        ? Number(candidate.stopLoss) < actualEntry && Number(candidate.takeProfit) > actualEntry
        : Number(candidate.takeProfit) < actualEntry && Number(candidate.stopLoss) > actualEntry;
      const actualRisk = actualQuantity * (Math.abs(actualEntry - Number(candidate.stopLoss)) +
        actualEntry * 0.0007 + Number(candidate.stopLoss) * 0.0007);
      const actualRewardRisk = Math.abs(Number(candidate.takeProfit) - actualEntry) /
        Math.max(1e-12, Math.abs(actualEntry - Number(candidate.stopLoss)));
      if (!synced?.position || synced.protection?.stopLoss !== true || synced.protection?.takeProfit !== true ||
          !finitePositive(actualEntry) || !finitePositive(actualQuantity) || !actualStopValid ||
          actualRewardRisk < RISK_CONFIG.minRewardRisk || actualRisk > decision.riskBudget * 1.1) {
        await this.client.emergencyClose({ symbol, side: decision.side, position: synced?.position ?? null });
        const afterClose = await this.client.getPosition(symbol, decision.side);
        if (afterClose && Math.abs(Number(afterClose.positionAmt)) > 0)
          throw new Error("LIVE_POST_FILL_GUARD_EMERGENCY_CLOSE_NOT_CONFIRMED");
        throw new Error("LIVE_POST_FILL_GUARD_REJECTED_POSITION_CLOSED");
      }
      const position = {
        id: String(synced.position.positionId ?? order?.orderID ?? order?.orderId ?? idempotencyKey),
        candidateId: candidate.id, engine: candidate.engine, symbol, side: decision.side,
        quantity: actualQuantity, entry: actualEntry, initialRiskUsdt: actualRisk,
        stopLoss: bracket.stopLoss, takeProfit: bracket.takeProfit, tp1: Number(candidate.tp1 ?? candidate.takeProfit), tp2: Number(candidate.tp2 ?? candidate.takeProfit), stage: 0, leverage: decision.leverage,
        marginMode: "ISOLATED", riskMultiple, riskBudget: decision.riskBudget,
        mode: "BINGX_LIVE", state: "OPEN", openedAt: this.clock(),
        entryOrderId: String(order?.orderID ?? order?.orderId ?? idempotencyKey)
      };
      try {
        await this.store.saveLivePosition(position);
      } catch (storageError) {
        await this.client.emergencyClose({ symbol, side: decision.side, position: synced.position });
        const afterClose = await this.client.getPosition(symbol, decision.side);
        if (afterClose && Math.abs(Number(afterClose.positionAmt)) > 0)
          throw new Error("LIVE_POSITION_PERSISTENCE_FAILED_EMERGENCY_CLOSE_UNCONFIRMED");
        throw new Error("LIVE_POSITION_PERSISTENCE_FAILED_POSITION_CLOSED:" + String(storageError).slice(0, 100));
      }
      return { ok: true, position };
    } catch (error) {
      if (!accepted) await this.store.releaseIdempotencyKey(idempotencyKey);
      throw error;
    }
  }

  async updateProtection(position, { stopLoss, takeProfit } = {}) {
    if (!this.readiness().ready)
      throw new Error("LIVE_PROTECTION_PATH_LOCKED");
    if (!position || position.mode !== "BINGX_LIVE" || position.state !== "OPEN")
      throw new Error("INVALID_LIVE_POSITION");
    if (!finitePositive(stopLoss) || !finitePositive(takeProfit) || !finitePositive(position.entry))
      throw new Error("INVALID_LIVE_PROTECTION_LEVELS");
    const markPrice = await this.client.getMarkPrice(position.symbol);
    if (position.side === "LONG" ? !(stopLoss < markPrice && takeProfit > markPrice && stopLoss < takeProfit) :
      !(takeProfit < markPrice && stopLoss > markPrice && stopLoss > takeProfit))
      throw new Error("LIVE_PROTECTION_DIRECTION_INVALID");
    await this.client.setPositionProtection(position, {
      stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), workingType: "MARK_PRICE"
    });
    const check = await this.client.reconcilePosition(position.symbol, position.side);
    if (!check?.position || check.protection?.stopLoss !== true || check.protection?.takeProfit !== true)
      throw new Error("LIVE_PROTECTION_UPDATE_NOT_CONFIRMED");
    const updated = { ...position, stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), protectionVerifiedAt: this.clock() };
    await this.store.saveLivePosition(updated);
    return { ok: true, position: updated };
  }

  async partialClose(position, fraction) {
    if (!this.readiness().ready)
      throw new Error("LIVE_PARTIAL_CLOSE_PATH_LOCKED");
    if (!position || position.mode !== "BINGX_LIVE" || position.state !== "OPEN")
      throw new Error("INVALID_LIVE_POSITION");
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
      throw new Error("INVALID_PARTIAL_CLOSE_FRACTION");
    const current = await this.client.getPosition(position.symbol, position.side);
    const currentQty = Math.abs(Number(current?.positionAmt));
    if (!finitePositive(currentQty)) throw new Error("LIVE_POSITION_QUANTITY_UNAVAILABLE");
    const contract = await this.client.getContractRules(position.symbol);
    if (!finitePositive(contract?.qtyStep)) throw new Error("LIVE_CONTRACT_STEP_UNAVAILABLE");
    const rawQty = currentQty * fraction;
    const quantity = Math.floor(rawQty / Number(contract.qtyStep) + 1e-10) * Number(contract.qtyStep);
    if (!finitePositive(quantity) || quantity >= currentQty || quantity < Number(contract.minQty))
      throw new Error("LIVE_PARTIAL_CLOSE_QUANTITY_INVALID");
    const result = await this.client.reducePosition({ symbol: position.symbol, side: position.side, quantity });
    const remaining = await this.client.getPosition(position.symbol, position.side);
    if (!remaining || !Number.isFinite(Number(remaining.positionAmt)) || Math.abs(Number(remaining.positionAmt)) >= currentQty)
      throw new Error("LIVE_PARTIAL_CLOSE_NOT_CONFIRMED");
    const remainingQuantity = Math.abs(Number(remaining.positionAmt));
    await this.store.saveLivePosition({ ...position, quantity: remainingQuantity, updatedAt: this.clock() });
    return { ok: true, result, remainingQuantity };
  }

  async close(position) {
    if (!this.readiness().ready)
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
