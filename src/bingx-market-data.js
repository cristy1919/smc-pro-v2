import { assertSupportedTimeframe } from "./config.js";
import { validateCandles } from "./market-data.js";

const BASE_URL = "https://open-api.bingx.com";
const INTERVAL_MS = Object.freeze({ "5m":300000, "15m":900000, "1h":3600000, "4h":14400000, "1d":86400000 });
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BingXPublicKlineProvider {
  constructor({ fetchImpl = fetch, baseUrl = BASE_URL, now = () => Date.now(), sleep = sleepDefault, minRequestIntervalMs = 1050 } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.fetchImpl = fetchImpl; this.baseUrl = baseUrl.replace(/\/$/, ""); this.now = now; this.sleep = sleep;
    this.minRequestIntervalMs = minRequestIntervalMs; this.lastRequestAt = 0; this.cache = new Map();
  }
  async #request(params) {
    const wait = this.minRequestIntervalMs - (this.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
    const url = new URL("/openApi/swap/v3/quote/klines", this.baseUrl);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
    this.lastRequestAt = this.now();
    const response = await this.fetchImpl(url.toString());
    if (!response.ok) throw new Error("BINGX_HTTP_" + response.status);
    const payload = await response.json();
    if (payload.code !== 0) throw new Error("BINGX_API_" + payload.code + ":" + (payload.msg || "unknown"));
    if (!Array.isArray(payload.data)) throw new Error("BINGX_INVALID_KLINE_PAYLOAD");
    return payload.data;
  }
  async getCandles(args) {
    const key = [args.symbol,args.timeframe,args.startTime,args.endTime,args.limit ?? 1440,args.includeForming === true].join(":");
    if (this.cache.has(key)) return this.cache.get(key);
    const pending = this.#fetchCandles(args);
    this.cache.set(key,pending);
    try { const rows = await pending; this.cache.set(key,rows); return rows; }
    catch (error) { this.cache.delete(key); throw error; }
  }
  clearCache() { this.cache.clear(); }
  async #fetchCandles({ symbol, timeframe, startTime, endTime, limit = 1440, includeForming = false }) {
    if (!/^[A-Z0-9]+-USDT$/.test(symbol)) throw new Error("INVALID_USDT_PERPETUAL_SYMBOL");
    assertSupportedTimeframe(timeframe);
    const duration = INTERVAL_MS[timeframe];
    if (!duration) throw new Error("UNSUPPORTED_KLINE_INTERVAL");
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new RangeError("INVALID_TIME_RANGE");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1440) throw new RangeError("KLINE_LIMIT_MUST_BE_1_TO_1440");
    const rows = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const page = await this.#request({ symbol, interval: timeframe, startTime: cursor, endTime, limit });
      if (!page.length) break;
      const normalized = page.map(row => ({
        timestamp: Number(row.time), open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
        closed: Number(row.time) + duration <= this.now()
      })).filter(c => Number.isFinite(c.timestamp) && c.timestamp >= startTime && c.timestamp < endTime);
      rows.push(...normalized);
      const maxTime = Math.max(...normalized.map(c => c.timestamp));
      if (!Number.isFinite(maxTime) || maxTime < cursor || page.length < 2) break;
      cursor = maxTime + duration;
    }
    const deduped = [...new Map(rows.map(c => [c.timestamp,c])).values()].sort((a,b)=>a.timestamp-b.timestamp);
    const result = includeForming ? deduped : deduped.filter(c => c.closed);
    validateCandles(result);
    return result;
  }
}

export async function fetchEngineDataset({ provider, symbol, engine, startTime, endTime }) {
  if (!provider || typeof provider.getCandles !== "function") throw new TypeError("provider.getCandles is required");
  const timeframes = engine === "scalp" ? ["1h","15m","5m"] : engine === "swing" ? ["1d","4h","1h"] : null;
  if (!timeframes) throw new Error("INVALID_ENGINE");
  const warmupMs = engine === "swing" ? 30 * 86400000 : 2 * 86400000;
  const requestStart = Math.max(0, startTime - warmupMs);
  const result = {};
  for (const timeframe of timeframes) result[timeframe] = await provider.getCandles({symbol,timeframe,startTime:requestStart,endTime,limit:1440});
  return result;
}
export { INTERVAL_MS };
