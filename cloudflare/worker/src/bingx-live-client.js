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

  async getOpenOrders() {
    const rows = await this.privateRequest("GET", "/openApi/swap/v2/trade/openOrders");
    return Array.isArray(rows) ? rows : rows?.orders ?? [];
  }

  async getOrder(symbol, { orderId, clientOrderId } = {}) {
    if (!LIVE_SYMBOL.test(symbol ?? "") || (orderId == null && !clientOrderId))
      throw new Error("LIVE_ORDER_LOOKUP_ARGUMENTS_INVALID");
    const identifier = clientOrderId ? { clientOrderId: String(clientOrderId) } : { orderId: String(orderId) };
    const row = await this.privateRequest("GET", "/openApi/swap/v2/trade/order", { symbol, ...identifier });
    return unwrap(row);
  }

  async cancelOrder(symbol, { orderId, clientOrderId } = {}) {
    if (!LIVE_SYMBOL.test(symbol ?? "") || (orderId == null && !clientOrderId))
      throw new Error("LIVE_ORDER_CANCEL_ARGUMENTS_INVALID");
    const identifier = clientOrderId ? { clientOrderId: String(clientOrderId) } : { orderId: String(orderId) };
    const row = await this.privateRequest("DELETE", "/openApi/swap/v2/trade/order", { symbol, ...identifier });
    return unwrap(row);
  }


  normalizePosition(row, hedgeMode) {
    const amount = Number(row?.positionAmt);
    const rawSide = String(row?.positionSide ?? "").toUpperCase();
    const side = rawSide === "BOTH" || !["LONG", "SHORT"].includes(rawSide)
      ? (amount < 0 ? "SHORT" : "LONG") : rawSide;
    const isolated = row?.isolated === true || String(row?.isolated).toLowerCase() === "true" ||
      String(row?.marginType ?? "").toUpperCase() === "ISOLATED";
    return {
      ...row,
      positionSide: hedgeMode ? side : "BOTH",
      side,
      entryPrice: Number(row?.avgPrice ?? row?.entryPrice ?? row?.entry_price),
      isolated,
      marginType: isolated ? "ISOLATED" : String(row?.marginType ?? "").toUpperCase(),
      state: "OPEN",
      engine: "exchange"
    };
  }

  async getOpenPositions() {
    const [rows, hedgeMode] = await Promise.all([
      this.privateRequest("GET", "/openApi/swap/v2/user/positions"),
      this.getPositionMode()
    ]);
    return (Array.isArray(rows) ? rows : rows?.positions ?? [])
      .filter(p => Math.abs(Number(p.positionAmt)) > 0)
      .map(p => this.normalizePosition(p, hedgeMode));
  }

  async getPositionMode() {
    const row = unwrap(await this.privateRequest("GET", "/openApi/swap/v1/positionSide/dual"));
    return row.dualSidePosition === true || row.dualSidePosition === "true";
  }

  async getCandles(symbol, interval, limit = 120) {
    if (!LIVE_SYMBOL.test(symbol ?? "") || !["15m", "1h", "4h"].includes(interval))
      throw new Error("LIVE_TRAILING_CANDLE_REQUEST_INVALID");
    const data = await this.publicRequest("/openApi/swap/v3/quote/klines", { symbol, interval, limit });
    const rows = Array.isArray(data) ? data : data?.list ?? data?.klines ?? [];
    const candles = rows.map(row => {
      const values = Array.isArray(row) ? row : null;
      const time = Number(values ? values[0] : row.time ?? row.openTime ?? row.timestamp);
      const open = Number(values ? values[1] : row.open);
      const high = Number(values ? values[2] : row.high);
      const low = Number(values ? values[3] : row.low);
      const close = Number(values ? values[4] : row.close);
      if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 || high < low) return null;
      return { time, open, high, low, close };
    }).filter(Boolean).sort((a,b)=>a.time-b.time);
    const intervalMs = ({ "15m":900000, "1h":3600000, "4h":14400000 })[interval];
    return candles.filter(candle => candle.time + intervalMs <= this.now() - 1000).slice(-limit);
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
    const minNotional = Number(row.tradeMinUSDT ?? row.minNotional ?? row.minNotionalValue ?? 0);
    if (![minQty, qtyStep, tickSize].every(positive) || !Number.isFinite(minNotional) || minNotional < 0)
      throw new Error("LIVE_CONTRACT_FILTERS_INCOMPLETE");
    return { minQty, qtyStep, tickSize, minNotional, quantityPrecision, pricePrecision };
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

  roundPrice(price, contract) {
    const value = Number(price), tick = Number(contract?.tickSize);
    if (!positive(value) || !positive(tick)) throw new Error("LIVE_PRICE_TICK_INVALID");
    const rounded = Math.round(value / tick) * tick;
    const precision = Number.isInteger(Number(contract?.pricePrecision))
      ? Math.max(0, Math.min(12, Number(contract.pricePrecision))) : 12;
    return Number(rounded.toFixed(precision));
  }

  roundQuantity(allocationBudgetUsdt, markPrice, stopLoss, contract, leverage, availableMargin) {
    const distance = Math.abs(Number(markPrice) - Number(stopLoss));
    if (![allocationBudgetUsdt, markPrice, distance, contract?.qtyStep, contract?.minQty, leverage, availableMargin].every(positive) || Number(allocationBudgetUsdt) > Number(availableMargin)) return 0;
    const allocationNotional = Number(allocationBudgetUsdt) * Number(leverage);
    const availableNotional = Number(availableMargin) * Number(leverage);
    const notional = Math.min(allocationNotional, availableNotional);
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
    const [rows, hedgeMode] = await Promise.all([
      this.privateRequest("GET", "/openApi/swap/v2/user/positions", { symbol }),
      this.getPositionMode()
    ]);
    return (Array.isArray(rows) ? rows : rows?.positions ?? [])
      .filter(p => p.symbol === symbol && Math.abs(Number(p.positionAmt)) > 0)
      .map(p => this.normalizePosition(p, hedgeMode))
      .find(p => p.side === side) ?? null;
  }

  async reconcilePosition(symbol, side) {
    const [position, orders] = await Promise.all([
      this.getPosition(symbol, side),
      this.privateRequest("GET", "/openApi/swap/v2/trade/openOrders", { symbol })
    ]);
    const list = Array.isArray(orders) ? orders : orders?.orders ?? [];
    const closingSide = side === "LONG" ? "SELL" : "BUY";
    const orderPositionSide = await this.getPositionMode() ? side : "BOTH";
    const protective = list.filter(order => order.symbol === symbol && String(order.side).toUpperCase() === closingSide &&
      String(order.positionSide).toUpperCase() === orderPositionSide);
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
    const hedgeMode = await this.getPositionMode();
    const common = { symbol: position.symbol, side: closeSide, positionSide: hedgeMode ? position.side : "BOTH",
      quantity: Math.abs(Number(current.position.positionAmt)), workingType: "MARK_PRICE", closePosition: "true" };
    const old = (current.openOrders ?? []).filter(order => ["STOP_MARKET", "TAKE_PROFIT_MARKET"].includes(String(order.type).toUpperCase()));
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

  async reducePosition({ symbol, side, quantity, clientOrderId }) {
    const hedgeMode = await this.getPositionMode();
    const params = {
      symbol, side: side === "LONG" ? "SELL" : "BUY",
      positionSide: hedgeMode ? side : "BOTH", type: "MARKET", quantity,
      ...(clientOrderId ? { clientOrderId } : {})
    };
    if (!hedgeMode) params.reduceOnly = "true";
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
