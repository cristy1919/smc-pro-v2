# Research implementation status

This branch adds a testable research layer. It is not a deployed trading bot.

## Implemented in this branch
- Causal swing-pivot confirmation and BOS/CHoCH event primitives.
- FVG, EQH/EQL liquidity pools and sweep detection.
- Order block, breaker, supply/demand, mitigation, rolling range, range deviation, OTE and CRT primitives.
- Separate Scalp (1H/15M/5M) and Swing (1D/4H/1H confirmation/15M entry) multi-timeframe analysis orchestration.
- BingX VST public OHLCV history adapter; 1M and 3M are rejected; incomplete candles are discarded.
- Read-only BingX VST USDT equity adapter. API credentials must be supplied as runtime secrets; no key material is committed.
- Backtest engine with explicit starting equity, separate engine runs, 10-position cap, duplicate-symbol guard, fee/slippage/funding inputs, stop-first same-candle assumption, MAE/MFE in R, and 30/60/90-day report helper.
- Score bands and independent confidence calibration.
- SQLite Durable Object repository adapter and local paper-execution abstraction.

## Not implemented / not approved for deployment
- Strategy-specific retest and closed-candle confirmation state machine is implemented for research candidates. Swing now requires a recent direction-aligned 1H structure event and uses 15M as its entry/retest timeframe; candidates remain non-executable until separate risk and VST execution gates pass.
- A read-only VST-backed 30/60/90-day workflow is now available, including historical candles and funding settlements. It has not yet been run because repository VST credentials are not configured. No profitability or drawdown claims are available.
- The Durable Object adapter has not been mapped to the existing production EngineState SQL schema or deployed namespace. Do not add a new namespace or migration without the source/schema audit.
- Existing production Worker source and its API routes have not been fully audited. Dashboard endpoint contracts remain unverified.
- No BingX VST order placement, cancel/replace, TP/SL reconciliation, or account-position synchronization is enabled in this branch. The paper adapter does not call an exchange.
- No Cloudflare Worker, Durable Object, KV, Cron, binding, secret or production deployment was changed.

## Required gates before paper trading
1. Obtain and verify historical candle coverage for every required pair/timeframe.
2. Add walk-forward and out-of-sample tests, including realistic fills and funding settlement.
3. Confirm zero future leakage, duplicate entries, invalid stops and unsupported metrics.
4. Audit existing Worker/DO/KV source and schemas; implement compatibility without disrupting current state.
5. Verify BingX VST-only account/order endpoints and reconcile all orders/positions before enabling demo execution.
6. Connect dashboard to verified API contracts and prove refresh does not trigger scanning.
7. Deploy only after all gates pass. Live trading remains disabled.
