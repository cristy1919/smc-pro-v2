# Research and deployment status

## Repository scope

This repository contains the research modules and automated tests for independent price-action Scalp and Swing engines. It is not the source bundle currently deployed to the production Cloudflare Worker.

Implemented and covered by the repository test suite:
- Causal pivot confirmation and close-confirmed BOS/CHoCH plus displacement-qualified structure annotations.
- FVG, EQH/EQL liquidity pools and liquidity sweeps.
- Order Block, Breaker, Supply/Demand, mitigation, rolling range, range deviation, OTE and CRT primitives.
- Separate Scalp (1H bias, 15M liquidity/zones, 5M entry) and Swing (1D bias, 4H zones, 1H confirmation, 15M entry) orchestration.
- Closed-candle validation and explicit rejection of 1M/3M.
- Read-only BingX VST market-history and account adapters; secrets are runtime-only.
- Separate backtest engine and 30/60/90-day report helpers, with fees, slippage, funding inputs, MAE/MFE, and stop-first same-candle handling.
- Separate score and confidence models, risk sizing guardrails, ten-position cap, duplicate-engine guard, and paper execution abstraction.
- GitHub Actions Node.js test workflow.

## Existing Cloudflare deployment audit (2026-11-25)

Existing resources were inspected in place. No new repository, Worker, Durable Object namespace, KV namespace, or deployment target was created.

### Existing Worker: `smcprov2`

- Runner is enabled and the persisted internal paper ledger reports a recent scan.
- Worker source contains independent Scalp and Swing evaluators and the requested setup families S01-S06 and W01-W08.
- It uses public BingX market data (`EXCHANGE_DATA_SOURCE=BINGX_PUBLIC`).
- `DEMO_TRADING_ENABLED=false`, `LIVE_TRADING_ENABLED=false`, and `PAPER_TRADING_ONLY=true`.
- The configured `PAPER_START_BALANCE_USDT=1000` is an existing internal paper-account setting. It is **not** verified BingX VST equity and must not be represented as the user's VST balance.
- The persisted internal ledger currently contains two open paper positions, one closed trade, and a balance of approximately 988.81 USDT. These records were not reset or rewritten.
- Current production Worker version `1986` (`ef4af70d-7c07-4508-a624-ad6fe15b7a30`) has `NEW_PAPER_ENTRIES_ENABLED=true`; it continues in internal-paper mode. This is not BingX VST execution. `DEMO_TRADING_ENABLED=false`, `ORDERFLOW_DEMO_EXECUTION_ENABLED=false`, `LIVE_TRADING_ENABLED=false`, and `PAPER_TRADING_ONLY=true` remain enforced.
- Funding snapshots can be available; open interest, aggressor flow, and BTC/USDT/altcoin dominance are explicitly marked unavailable in the current signal audit where no verified feed is present.
- The Worker has an embedded production bundle and existing API routes. The repository's research modules are not yet built into or deployed by that Worker. Do not assume changes in this repository automatically change the running Worker.

### Existing dashboard Worker: `smcprov2-dashboard`

- The existing dashboard Worker was updated in place to expose exactly ten tabs: Market Overview, Açık İşlemler, Scalp Scanner, Swing Scanner, Positions, Statistics, Candidates (İşlem Adayları), Trade History, Diagnostics, Grafik.
- Chart navigation now targets the Grafik tab; the Candidates tab keeps READY, WATCH, and WAIT candidates visible.
- The dashboard source upload completed and no dashboard Worker error logs were observed immediately after deployment.
- Public HTTP endpoint checks from the Cloudflare execution environment were blocked by its network policy, so successful end-to-end browser/API rendering has not been independently proven.

## Not verified / blocked

- BingX VST API credentials are not configured in the existing Worker. The current Worker is not reading actual VST equity and is not enabled to send demo orders.
- The existing 1,000 USDT internal paper baseline is not a substitute for the user's actual VST starting balance. Do not rebase the existing ledger or open new VST-sized positions from a guessed value.
- The repository's read-only VST backtest workflow requires GitHub secrets `BINGX_API_KEY` and `BINGX_SECRET_KEY`. No historical backtest has been run with authenticated VST data, so there are no verified profitability, expectancy, or drawdown results.
- The production Worker and repository research modules are not yet a single reproducible build/deploy pipeline. API endpoint contracts, browser rendering, full position reconciliation, and end-to-end scan-to-paper execution still require verification.
- Cloudflare live and BingX demo order placement remain disabled. Do not enable either without verified VST credentials, account equity, and order/position reconciliation.

## Required completion gates

1. Keep the existing Worker, dashboard Worker, Durable Objects, KV namespaces, current positions, and trade history intact.
2. Integrate the tested research modules into the existing Worker source/build without replacing or resetting its persisted state.
3. Verify all required candle coverage and shared-cache behavior for each engine and timeframe.
4. Run walk-forward/out-of-sample tests and the 30/60/90-day authenticated VST backtest.
5. Prove zero future leakage, invalid stops, duplicate same-engine entries, and unsupported metric fabrication.
6. Verify dashboard endpoints and all ten tabs against the live Worker API; dashboard refresh must not trigger scans.
7. Enable BingX demo execution only after VST equity, isolated margin, leverage, liquidation buffer, TP/SL, cancellation, and position reconciliation pass. Live trading remains disabled.


## Production paper analytics repair (2026-11-26)

- Deployed Worker version: `1986`; deployment `1135de92-e109-4a8c-ab0a-5da7d0c148a4`, 100% traffic. Existing `EngineState` / `EngineStateV2` Durable Object exports, namespace IDs, KV binding, and migration tag `v1` were preserved.
- Analytics now separates verified P/L, provisional numeric P/L where funding accounting is unverified, and truly missing P/L. Provisional values are reported separately and are not included in verified win rate or profit factor.
- Closed-trade analytics now recover historical `primaryTrend` and `marketPhase` from the entry-time `audit.htfTrend` and `audit.marketRegime` fields when the top-level fields are absent. New positions persist those fields at entry, along with BTC bias.
- Analytics now separates manual exits from automated exits and exposes setup-timeframe and model/side/entry-timeframe/exit-type groupings.
- New internal-paper entries for `W05_RANGE_DEVIATION + SHORT` are temporarily held at `WATCH` with reason `MODEL_SIDE_QUARANTINED`. The last report showed 17 trades, 35.29% win rate, PF 0.28, and -44.69 USDT. This is a targeted paper quarantine, not deletion of W05 or a claim that the model is permanently invalid. W05 LONG remains observable pending sufficient verified sample size.
- The 26 Nov report contained 97 closed trades: 66 Scalp (5m entry) and 31 Swing (15m entry). It also showed 45 manual closes. Timeframe comparisons remain confounded with engine type; Swing 15m must be compared against controlled 1h-entry variants before declaring the timeframe itself defective.
- Deployment changed code only. No paper ledger, open position, balance, or trade-history record was reset or rewritten. Public HTTP runtime verification was blocked by the Cloudflare execution environment's network policy; the active deployment and bindings were verified through the Cloudflare API.


## Operational readiness update — 2026-11-27

- Active main Worker: `smcprov2`, version 2056, 100% deployment. Dashboard Worker: `smcprov2-dashboard`, version 65, 100% deployment.
- Execution remains Stage 1 Internal Paper. VST Demo and Live flags remain disabled; no exchange API credentials were added.
- BTC context now fetches closed BTC-USDT 4H and 1D candles directly (up to 300 each), persists the history, and reconstructs BTC structural direction at each historical trade's opening time for the trade analytics endpoint.
- Altcoin breadth uses fresh per-symbol 4H/1D structural states. It is `UNAVAILABLE` until at least 60% of the eligible universe is covered; new setup audit records the breadth snapshot and coverage.
- The Statistics panel displays current BTC structure, BTC candle counts, altcoin breadth coverage and historical BTC alignment.
- VST Demo order validation checks the inclusive 1R–4R range before market/limit orders and again after actual fills. Live validation supports Scalp 5m and Swing 1h setup timeframes, with independent engine routing and the same 1R–4R limits.
- GitHub Actions last verified 126 tests passing, 0 failing.
- The 2056 upload also fixes a setup-audit initialization-order error found in the scan route. Durable Object code adoption is deferred until approximately 2026-11-27 12:40:39 UTC; live BTC candle counts remain unverified until a successful post-adoption scan reports nonzero 4H/1D counts.
- See [execution-mode runbook](execution-mode-runbook.md) for the staged Internal Paper → VST Demo → Live transition and credential names.
