import test from "node:test";
import assert from "node:assert/strict";
import { isCryptoPerpetualContract, selectCryptoPerpetualUniverse } from "../src/backtest-universe.js";

const contract = (symbol, asset = symbol.replace(/-USDT$/, "")) => ({
  symbol, asset, currency: "USDT", status: 1, apiStateOpen: "true"
});
const ticker = (symbol, quoteVolume) => ({
  symbol, quoteVolume: String(quoteVolume), bidPrice: "99.9", askPrice: "100.1", lastPrice: "100"
});

test("accepts genuine crypto perpetual contracts and excludes TradFi and gold references", () => {
  assert.equal(isCryptoPerpetualContract(contract("BTC-USDT")), true);
  assert.equal(isCryptoPerpetualContract(contract("ETH-USDT")), true);
  assert.equal(isCryptoPerpetualContract(contract("NCCOGOLD2USD-USDT")), false);
  assert.equal(isCryptoPerpetualContract(contract("NCSINASDAQ1002USD-USDT")), false);
  assert.equal(isCryptoPerpetualContract(contract("XAUT-USDT")), false);
  assert.equal(isCryptoPerpetualContract({...contract("SOL-USDT"), status: 0}), false);
});

test("selects exactly BTC plus the highest-volume 19 crypto alts and rejects an incomplete universe", () => {
  const contracts = [contract("BTC-USDT"), ...Array.from({length:55},(_,i)=>contract("ALT"+i+"-USDT")), contract("NCCOGOLD2USD-USDT")];
  const tickers = contracts.map((c,i)=>ticker(c.symbol, i+1));
  const selected = selectCryptoPerpetualUniverse(contracts,tickers,20);
  assert.equal(selected.length,20);
  assert.equal(selected[0].symbol,"BTC-USDT");
  assert.equal(selected.some(x=>x.symbol==="NCCOGOLD2USD-USDT"),false);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,20);
  assert.throws(()=>selectCryptoPerpetualUniverse(contracts.slice(0,10),tickers.slice(0,10),20),/INSUFFICIENT_CRYPTO_PERPETUALS/);
});
