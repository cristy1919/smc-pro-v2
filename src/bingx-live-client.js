const LIVE_BASE_URL = "https://open-api.bingx.com";
const LIVE_SYMBOL = /^[A-Z0-9]{2,20}-USDT$/;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const unwrap = value => Array.isArray(value) ? value[0] ?? {} : value && typeof value === "object" ? value : {};

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(v => v.toString(16).padStart(2, "0")).join("");
}

function canonicalParams(params) {
  return Object.keys(params).sort().map(key => {
    const value = params[key];
    return [key, value && typeof value === "object" ? JSON.stringify(value) : String(value)];
  });
}

export class BingXLiveClient {
  constructor({ apiKey, apiSecret, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 10000 } = {}) {
    if (!apiKey || !apiSecret) throw new Error("LIVE_CREDENTIALS_REQUIRED");
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async privateRequest(method, path, params = {}) {
    const all = { ...params, recvWindow: 5000, timestamp: this.now() };
    const pairs = canonicalParams(all);
    const canonical = pairs.map(([key, value]) => key + "=" + value).join("&");
    const signature = await hmacHex(this.apiSecret, canonical);
    const encoded = new URLSearchParams(pairs);
    encoded.set("signature", signature);
    const hasBody = method === "POST" || method === "PUT";
    const response = await this.fetchImpl(LIVE_BASE_URL + path + (hasBody ? "" : "?" + encoded.toString()), {
      method,
      headers: {
        "X-BX-APIKEY": this.apiKey,
        "X-SOURCE-KEY": "BX-AI-SKILL",
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/x-www-form-urlencoded" } : {})
      },
      ...(hasBody ? { body: encoded.toString() } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: "no-store"
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); }
    catch { throw new Error("LIVE_NON_JSON_RESPONSE:" + response.status); }
    if (!response.ok || payload.code !== 0)
      throw new Error("BINGX_LIVE_API_ERROR:" + String(payload.code ?? response.status) + ":" + String(payload.msg ?? "").slice(0, 180));
    return payload.data;
  }

  async publicRequest(path, params = {}) {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    const response = await this.fetchImpl(LIVE_BASE_URL + path + (query.size ? "?" + query.toString() : ""), {
      headers: { accept: "application/json", "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(this.timeoutMs), cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0)
      throw new Error("BINGX_LIVE_PUBLIC_ERROR:" + String(payload.code ?? response.status));
    return payload.data;
  }

  async getAccountSnapshot() {
    const rows = await this.privateRequest("GET", "/openApi/swap/v3/user/balance");
    const list = Array.isArray(rows) ? rows : [rows];
    const usdt = list.find(row => String(row.asset).toUpperCase() === "USDT");
    if (!usdt) throw new Error("LIVE_USDT_ACCOUNT_NOT_FOUND");
    const equity = Number(usdt.equity ?? usdt.balance);
    const availableMargin = Number(usdt.availableMargin);
    if (!positive(equity) || !positive(availableMargin)) throw new Error("LIVE_USDT_BALANCE_INVALID");
    return { source: "BINGX_LIVE", asset: "USDT", equity, availableMargin, balance: Number(usdt.balance), fetchedAt: this.now() };
  }

  async getOpenPositions() {
    const rows = await this.privateRequest("GET", "/openApi/swap/v2/user/positions");
    return (Array.isArray(rows) ? rows : rows?.positions ?? []).filter(p => Math.abs(Number(p.positionAmt)) > 0)
      .map(p => ({ ...p, side: String(p.positionSide).toUpperCase(), state: "OPEN", engine: "exchange" }));
  }

  async getPositionMode() {
    const row = unwrap(await this.privateRequest("GET", "/openApi/swap/v1/positionSide/dual"));
    return row.dualSidePosition === true || row.dualSidePosition === "true";
  }

  async getMarkPrice(symbol) {
    if (!LIVE_SYMBOL.test(symbol ?? "")) throw new Error("LIVE_INVALID_SYMBOL");
    const row = unwrap(await this.publicRequest("/openApi/swap/v2/quote/premiumIndex", { symbol }));
    const mark = Number(row.markPrice ?? row.mark_price);
    if (!positive(mark)) throw new Error("LIVE_MARK_PRICE_MISSING");
    return mark;
  }

  async getContractRules(symbol) {
    if (!LIVE_SYMBOL.test(symbol ?? "")) throw new Error("LIVE_INVALID_SYMBOL");
    const row = unwrap(await this.publicRequest("/openApi/swap/v2/quote/contracts", { symbol }));
    const quantityPrecision = Number(row.quantityPrecision);
    const pricePrecision = Number(row.pricePrecision);
    const minQty = Number(row.tradeMinQuantity ?? row.minQty);
    const qtyStep = Number.isInteger(quantityPrecision) && quantityPrecision >= 0 ? 10 ** -quantityPrecision : NaN;
    const tickSize = Number.isInteger(pricePrecision) && pricePrecision >= 0 ? 10 ** -pricePrecision : NaN;
    const minNotional = Number(row.tradeMinUSDT ?? row.minNotional ?? row.minNotionalValue);
    const leverage = unwrap(await this.privateRequest("GET", "/openApi/swap/v2/trade/leverage", { symbol }));
    const maxLongLeverage = Number(leverage.maxLongLeverage);
    const maxShortLeverage = Number(leverage.maxShortLeverage);
    const maxLeverage = Math.min(maxLongLeverage, maxShortLeverage);
    if (![minQty, qtyStep, tickSize, minNotional, maxLongLeverage, maxShortLeverage].every(positive))
      throw new Error("LIVE_CONTRACT_FILTERS_INCOMPLETE");
    return { minQty, qtyStep, tickSize, minNotional, maxLeverage, maxLongLeverage, maxShortLeverage, quantityPrecision, pricePrecision };
  }

  async getMarginMode(symbol) {
    const row = unwrap(await this.privateRequest("GET", "/openApi/swap/v2/trade/marginType", { symbol }));
    return String(row.marginType ?? "").toUpperCase();
  }

  async setMarginMode(symbol, marginType) {
    if (marginType !== "ISOLATED") throw new Error("LIVE_ONLY_ISOLATED_MARGIN");
    await this.privateRequest("POST", "/openApi/swap/v2/trade/marginType", { symbol, marginType });
  }

  async getLeverage(symbol, side) {
    const row = unwrap(await this.privateRequest("GET", "/openApi/swap/v2/trade/leverage", { symbol }));
    return Number(side === "LONG" ? row.longLeverage : row.shortLeverage);
  }

  async setLeverage(symbol, side, leverage) {
    if (!["LONG", "SHORT"].includes(side) || !Number.isInteger(leverage))
      throw new Error("LIVE_INVALID_LEVERAGE_ARGUMENTS");
    await this.privateRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side, leverage });
  }

  roundQuantity(riskBudget, markPrice, stopLoss, contract, leverage, availableMargin) {
    const distance = Math.abs(Number(markPrice) - Number(stopLoss));
    if (![riskBudget, markPrice, distance, contract?.qtyStep, contract?.minQty].every(positive)) return 0;
    const unitRisk = distance + Number(markPrice) * 0.0014;
    const riskLimitedNotional = Number(riskBudget) * Number(markPrice) / unitRisk;
    const maxMarginNotional = Number(availableMargin) * Number(leverage) * 0.95;
    const notional = Math.min(riskLimitedNotional, maxMarginNotional);
    const raw = notional / Number(markPrice);
    const quantity = Math.floor(raw / Number(contract.qtyStep) + 1e-10) * Number(contract.qtyStep);
    return Number(quantity.toFixed(12));
  }

  async placeEntryWithProtection({ symbol, side, quantity, marginMode, bracket, clientOrderId }) {
    if (marginMode !== "ISOLATED" || !LIVE_SYMBOL.test(symbol) || !positive(quantity))
      throw new Error("LIVE_ENTRY_ARGUMENTS_INVALID");
    const params = {
      symbol, side: side === "LONG" ? "BUY" : "SELL", positionSide: side, type: "MARKET",
      quantity, workingType: "MARK_PRICE", clientOrderId,
      stopLoss: { type: "STOP_MARKET", stopPrice: Number(bracket.stopLoss), workingType: "MARK_PRICE" },
      takeProfit: { type: "TAKE_PROFIT_MARKET", stopPrice: Number(bracket.takeProfit), workingType: "MARK_PRICE" }
    };
    return unwrap(await this.privateRequest("POST", "/openApi/swap/v2/trade/order", params));
  }

  async getPosition(symbol, side) {
    const rows = await this.privateRequest("GET", "/openApi/swap/v2/user/positions", { symbol });
    return (Array.isArray(rows) ? rows : rows?.positions ?? []).find(p =>
      p.symbol === symbol && String(p.positionSide).toUpperCase() === side && Math.abs(Number(p.positionAmt)) > 0) ?? null;
  }

  async reconcilePosition(symbol, side) {
    const [position, orders] = await Promise.all([
      this.getPosition(symbol, side),
      this.privateRequest("GET", "/openApi/swap/v2/trade/openOrders", { symbol })
    ]);
    const list = Array.isArray(orders) ? orders : orders?.orders ?? [];
    const closingSide = side === "LONG" ? "SELL" : "BUY";
    const protective = list.filter(order => order.symbol === symbol && String(order.side).toUpperCase() === closingSide &&
      String(order.positionSide).toUpperCase() === side);
    return {
      position,
      protection: {
        stopLoss: protective.some(order => String(order.type).toUpperCase() === "STOP_MARKET"),
        takeProfit: protective.some(order => String(order.type).toUpperCase() === "TAKE_PROFIT_MARKET")
      },
      openOrders: protective
    };
  }

  async setPositionProtection(position, { stopLoss, takeProfit }) {
    const current = await this.reconcilePosition(position.symbol, position.side);
    if (!current.position) throw new Error("LIVE_POSITION_NOT_FOUND");
    const closeSide = position.side === "LONG" ? "SELL" : "BUY";
    const common = { symbol: position.symbol, side: closeSide, positionSide: position.side,
      quantity: Math.abs(Number(current.position.positionAmt)), workingType: "MARK_PRICE", closePosition: "true" };
    const old = current.openOrders ?? [];
    const newSl = await this.privateRequest("POST", "/openApi/swap/v2/trade/order", {
      ...common, type: "STOP_MARKET", stopPrice: Number(stopLoss)
    });
    const newTp = await this.privateRequest("POST", "/openApi/swap/v2/trade/order", {
      ...common, type: "TAKE_PROFIT_MARKET", stopPrice: Number(takeProfit)
    });
    for (const order of old) {
      const id = order.orderID ?? order.orderId;
      if (id != null) await this.privateRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol: position.symbol, orderId: String(id) });
    }
    return { stop: newSl, takeProfit: newTp };
  }

  async reducePosition({ symbol, side, quantity }) {
    const params = { symbol, side: side === "LONG" ? "SELL" : "BUY", positionSide: side, type: "MARKET", quantity };
    if (!(await this.getPositionMode())) params.reduceOnly = "true";
    return this.privateRequest("POST", "/openApi/swap/v2/trade/order", params);
  }

  async emergencyClose({ symbol, side, position }) {
    const current = position ?? await this.getPosition(symbol, side);
    if (!current) return { ok: true, alreadyFlat: true };
    const quantity = Math.abs(Number(current.positionAmt));
    if (!positive(quantity)) throw new Error("LIVE_EMERGENCY_CLOSE_QUANTITY_MISSING");
    return this.reducePosition({ symbol, side, quantity });
  }

  async closePosition(position) {
    const current = await this.getPosition(position.symbol, position.side);
    if (!current) return { ok: true, alreadyFlat: true };
    const quantity = Math.abs(Number(current.positionAmt));
    if (!positive(quantity)) throw new Error("LIVE_CLOSE_QUANTITY_MISSING");
    return this.reducePosition({ symbol: position.symbol, side: position.side, quantity });
  }
}
