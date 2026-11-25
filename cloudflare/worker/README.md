# Existing Cloudflare Worker audit

The production resources are the existing Cloudflare Workers `smcprov2` and `smcprov2-dashboard`. This repository is **not yet the reproducible build/deployment source of truth** for either deployed bundle. Do not create a replacement Worker, repository, Durable Object namespace, or KV namespace.

## Current production state — 2026-11-25

### `smcprov2`

- Existing Worker and existing Durable Object/SQLite + KV state are retained.
- Runner remains enabled. The scanner uses the existing 534-symbol USDT-M universe and 25-symbol scan batches.
- Independent Scalp and Swing evaluators are present. Scalp uses 1H/15M/5M; Swing uses 1D/4H/1H/15M. 1M and 3M are not in the allowed timeframe set.
- Existing Worker environment is `BINGX_TRADING_MODE=paper`, `PAPER_TRADING_ONLY=true`, `PAPER_START_BALANCE_USDT=1000`, `DEMO_TRADING_ENABLED=false`, and `LIVE_TRADING_ENABLED=false`.
- The 1,000 USDT value is the existing **internal paper-account** starting setting, not verified BingX VST equity. The persisted paper ledger was preserved; it held two open positions, one closed trade, and approximately 988.81 USDT balance at the audit snapshot.
- `NEW_PAPER_ENTRIES_ENABLED=false` is now deployed. Scanning/strategy generation and existing-position management remain enabled; no new internal-paper positions may be opened while the requested BingX VST account is unconfigured.
- BingX VST execution is fail-closed until `BINGX_API_KEY` and `BINGX_API_SECRET` exist as Cloudflare secrets and the demo mode flags are explicitly configured. Those secrets were not present in the audited Worker settings.
- Live execution remains hard-disabled.
- New VST entries, once credentials are configured, calculate 1R from **2% of current verified VST equity** at order time. Reduced-risk setups use 0.5R. The originally captured VST equity snapshot remains available for audit, not as the new-trade sizing base.
- Score bands now match the requested boundaries: 0–59 RED, 60–64 WAIT, 65–69 WATCH, 70–83 QUALIFIED, 84–100 HIGH_QUALITY. Setup readiness follows those gates; minimum R:R is 1:1 and the standard target remains 3.5R.
- Isolated margin and a leverage range of 20x–50x are enforced by the existing sizing/liquidation checks. Leverage below 20x is no longer selected for reduced-risk setups.
- Cron is `* * * * *`; Durable Object alarms coordinate the scanner. Dashboard refresh does not invoke a scan.

### `smcprov2-dashboard`

- Existing dashboard Worker was updated in place; it exposes exactly ten tabs: Market Overview, Açık İşlemler, Scalp Scanner, Swing Scanner, Positions, Statistics, Candidates (İşlem Adayları), Trade History, Diagnostics, Grafik.
- Chart navigation opens Grafik. Candidate views retain READY, WATCH, and WAIT states.
- Diagnostics distinguishes internal-paper entries from BingX VST connectivity; BingX VST and live execution remain disabled.
- Dashboard source uploads completed without observed Worker error logs immediately after deployment. Full browser rendering and live API response verification remain unproven because external HTTP requests from the deployment inspection environment are blocked by its network policy.

## Repository integration boundary

- The repository holds independently testable strategy, market-data, risk, and backtest modules.
- The production Worker still runs its existing embedded bundle. The repository now includes a separately tested paper-ledger accounting module (`cloudflare/worker/src/paper-ledger-accounting.js`) and regression tests, but the complete embedded production bundle is not yet reproducibly built from the repository modules. The deployed bundle was updated in place; do not overwrite it from the skeletal source tree until full integration and state-schema compatibility are tested.
- The read-only 30/60/90-day VST backtest workflow requires GitHub secrets `BINGX_API_KEY` and `BINGX_SECRET_KEY` (the script also accepts `BINGX_API_SECRET`). No authenticated VST backtest has been run; no profitability, expectancy, or drawdown claims are available.

## Safety gates

1. Keep the current Worker, dashboard Worker, Durable Object namespaces, KV namespaces, positions, and history.
2. Configure verified BingX VST API key/secret as Cloudflare secrets before enabling demo mode.
3. Reconcile the internal-paper positions separately; never treat them as exchange positions or silently migrate them into VST.
4. Verify current VST equity, available margin, isolated margin, 20x–50x leverage, liquidation buffer, TP/SL protection, and exchange position/order reconciliation.
5. Integrate the tested repository modules into the existing Worker source/build and prove the same state/schema compatibility before deployment.
6. Run authenticated 30/60/90-day backtests and walk-forward tests. Do not enable live trading.
