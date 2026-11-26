import test from "node:test";
import assert from "node:assert/strict";
import { BingXPublicKlineProvider } from "../src/bingx-market-data.js";

test("BingX public provider retries transient 100410 responses with backoff", async () => {
  let calls = 0;
  const delays = [];
  const provider = new BingXPublicKlineProvider({
    now: () => 2000000,
    sleep: async ms => { delays.push(ms); },
    minRequestIntervalMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls < 3) return { ok: true, json: async () => ({ code: 100410, msg: "retry later" }) };
      return { ok: true, json: async () => ({ code: 0, data: [{ time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 12 }] }) };
    }
  });
  const result = await provider.getCandles({
    symbol: "BTC-USDT", timeframe: "15m", startTime: 0, endTime: 900000, limit: 1
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(result.length, 1);
});

test("BingX public provider does not retry non-transient API errors", async () => {
  let calls = 0;
  const provider = new BingXPublicKlineProvider({
    now: () => 100000,
    sleep: async () => { throw new Error("unexpected retry"); },
    minRequestIntervalMs: 0,
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ code: 100001, msg: "invalid symbol" }) };
    }
  });
  await assert.rejects(() => provider.getCandles({
    symbol: "BTC-USDT", timeframe: "15m", startTime: 0, endTime: 900000, limit: 1
  }), /BINGX_API_100001/);
  assert.equal(calls, 1);
});
