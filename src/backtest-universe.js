const NON_CRYPTO_BASE_PREFIXES = /^(?:NCCO|NCS)/i;
const NON_CRYPTO_SYMBOLS = new Set(["XAUT-USDT"]);

export function isCryptoPerpetualContract(contract) {
  if (!contract || contract.status !== 1 || String(contract.apiStateOpen).toLowerCase() !== "true") return false;
  const symbol = String(contract.symbol || "").toUpperCase();
  const base = symbol.endsWith("-USDT") ? symbol.slice(0, -5) : "";
  const asset = String(contract.asset || "").toUpperCase();
  const quote = String(contract.currency || "").toUpperCase();
  if (!base || !/^[A-Z0-9]+$/.test(base) || quote !== "USDT") return false;
  if (NON_CRYPTO_BASE_PREFIXES.test(base) || NON_CRYPTO_SYMBOLS.has(symbol)) return false;
  // Require the exchange's base-asset field to agree with the listed crypto symbol.
  if (!asset || asset !== base) return false;
  // Reject synthetic index/stock/commodity/forex symbols with embedded reference suffixes.
  if (/(?:2USD|NASDAQ|SP500|OIL|GOLD|SILVER|BRENT|WTI|ANTHROPIC)/i.test(base)) return false;
  return true;
}

export function selectCryptoPerpetualUniverse(contracts, tickers, target = 50) {
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new TypeError("INVALID_BINGX_UNIVERSE_RESPONSE");
  const eligible = new Map(contracts.filter(isCryptoPerpetualContract).map(c => [String(c.symbol).toUpperCase(), c]));
  const ranked = tickers.filter(t => eligible.has(String(t.symbol || "").toUpperCase()))
    .map(t => {
      const bid = Number(t.bidPrice), ask = Number(t.askPrice), quoteVolume = Number(t.quoteVolume);
      const mid = (bid + ask) / 2;
      return { symbol: String(t.symbol).toUpperCase(), quoteVolume, spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : Infinity, lastPrice: Number(t.lastPrice) };
    })
    .filter(t => Number.isFinite(t.quoteVolume) && t.quoteVolume > 0 && Number.isFinite(t.lastPrice) && t.lastPrice > 0 && Number.isFinite(t.spreadPct) && t.spreadPct >= 0 && t.spreadPct <= 0.5)
    .sort((a,b) => b.quoteVolume - a.quoteVolume);
  const btc = ranked.find(x => x.symbol === "BTC-USDT");
  if (!btc) throw new Error("BTC_USDT_MISSING_FROM_CRYPTO_PERPETUAL_UNIVERSE");
  const selected = [btc, ...ranked.filter(x => x.symbol !== "BTC-USDT").slice(0, target - 1)];
  if (selected.length !== target) throw new Error("INSUFFICIENT_CRYPTO_PERPETUALS: expected " + target + ", found " + selected.length);
  return selected;
}
