import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { BingXVSTDemoAccount } from "../src/bingx-vst-account.js";

test("VST account reads equity only from the isolated simulated-trading host", async () => {
  let captured;
  const account = new BingXVSTDemoAccount({
    apiKey: "vst-key",
    secretKey: "vst-secret",
    cryptoProvider: webcrypto,
    now: () => 1700000000000,
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        code: 0,
        data: [{ asset: "USDT", equity: "74250.5", balance: "74000", availableMargin: "70000", unrealizedProfit: "250.5", realisedProfit: "100" }]
      }), { status: 200 });
    }
  });
  const result = await account.getBalance();
  assert.equal(result.source, "BINGX_VST");
  assert.equal(result.equity, 74250.5);
  assert.equal(result.availableMargin, 70000);
  assert.equal(result.readOnly, true);
  assert.ok(captured.url.startsWith("https://open-api-vst.bingx.com/"));
  assert.ok(captured.url.includes("signature="));
  assert.ok(captured.url.includes("timestamp=1700000000000"));
  assert.equal(captured.init.headers["X-BX-APIKEY"], "vst-key");
  assert.equal(captured.init.headers["X-SOURCE-KEY"], "BX-AI-SKILL");
  assert.equal(captured.init.redirect, "error");
  assert.ok(!captured.url.includes("open-api.bingx.com/"));
});

test("VST account refuses missing credentials before network access", () => {
  assert.throws(() => new BingXVSTDemoAccount({ apiKey: "vst-key" }), /key and secret/);
});
