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
- The exact deployed bundles are now tracked in `cloudflare/worker/deployed/index.js` and `cloudflare/dashboard/deployed/index.js`. The Worker version deployed is `65b86fa0-f51a-449d-b9fe-b1d3c297b3af`; the dashboard version is `9457036e-3763-4c49-845b-da9e9d142caa`.
- The repository also contains the separately testable paper-ledger accounting module (`cloudflare/worker/src/paper-ledger-accounting.js`) and regression tests. The complete production bundle is preserved exactly, but the modular strategy sources are not yet the reproducible build input for that bundle. Do not overwrite the existing Worker from the skeletal source tree until full integration and state-schema compatibility are tested.
- The read-only 30/60/90-day VST backtest workflow requires GitHub secrets `BINGX_API_KEY` and `BINGX_SECRET_KEY` (the script also accepts `BINGX_API_SECRET`). No authenticated VST backtest has been run; no profitability, expectancy, or drawdown claims are available.

## Safety gates

1. Keep the current Worker, dashboard Worker, Durable Object namespaces, KV namespaces, positions, and history.
2. Configure verified BingX VST API key/secret as Cloudflare secrets before enabling demo mode.
3. Reconcile the internal-paper positions separately; never treat them as exchange positions or silently migrate them into VST.
4. Verify current VST equity, available margin, isolated margin, 20x–50x leverage, liquidation buffer, TP/SL protection, and exchange position/order reconciliation.
5. Integrate the tested repository modules into the existing Worker source/build and prove the same state/schema compatibility before deployment.
6. Run authenticated 30/60/90-day backtests and walk-forward tests. Do not enable live trading.


## Live-trading preparation — 2026-11-25 (updated)

- Added `src/bingx-live-client.js`: a dedicated signed BingX production REST client using only `https://open-api.bingx.com` and only `BINGX_LIVE_API_KEY` / `BINGX_LIVE_API_SECRET`. Demo/VST request helpers and credentials are not reused.
- Added `src/live-execution.js`: fail-closed execution adapter for independent Scalp and Swing setup IDs; checks current USDT equity, position and pending-order snapshots, 10-position cap, hedge mode, isolated margin, per-side exchange leverage limits, contract precision/minimums, 1R/0.5R sizing, and current mark price before entry.
- Live entry attaches mark-price stop-loss and take-profit protection in the same order request. The adapter reconciles exchange position and both protective orders before recording the position. Unknown order outcomes retain the idempotency claim; emergency-close requests are verified rather than assumed successful.
- Added `src/live-state-store.js` and deployed Durable Object endpoints for serialized idempotency claims and persisted live-position records. These use the existing `ENGINE_STATE_V2` namespace; no new namespace or KV was created.
- Integrated authenticated `/api/live/execute`, `/api/live/positions`, `/api/live/close`, `/api/live/protection`, and `/api/live/partial-close` routes into the existing Worker. Entry requires a currently stored READY Scalp/Swing scanner setup, a fresh explicit user confirmation, the control-token authorization, and `LIVE_TRADING_ENABLED=true`.
- `/api/live/status` now performs read-only account, hedge-mode, position, and open-order checks when distinct Live credentials are configured. Diagnostics displays its blockers.
- Live activation remains off. Current Worker configuration is `LIVE_TRADING_ENABLED=false`; no Live API key or secret has been created or configured. The current deployment therefore cannot submit a live order.
- Remaining account-dependent verification: after Live credentials are created at the user's go-live decision, verify the account's USDT balance, hedge mode, isolated margin support, contract filters, order acknowledgement, attached TP/SL, position reconciliation, partial close, stop update, and emergency close against that real account. Until those checks pass, the readiness endpoint must continue to report blockers and live activation must remain disabled.
- The scheduled Worker runs the live position manager whenever distinct Live credentials are present, independently of the new-entry flag. It reconciles exchange positions and protection, performs a 50% TP1 scale-out, moves the remaining stop to breakeven, and then trails only to confirmed 15M Scalp / 4H Swing pivot structure (never to an unconfirmed pivot). Closing and protection updates remain available after new entries are disabled. The global emergency stop blocks new live entries but does not stop management of existing live positions.


## Explicit live activation and automated scanner routing

- Live entries remain off while `LIVE_TRADING_ENABLED=false`. No activation record is active by default.
- Once Live credentials are provisioned (and, if Demo private credentials are configured, they are a separate complete key pair) and the live account readiness checks pass, a user must call `POST /api/live/activate` with the control-token authorization and a fresh `confirmedByUser=true` confirmation. The activation record is persisted in EngineStateV2. `POST /api/live/deactivate` requires a fresh user confirmation and disables new entries.
- The scheduled live runner consumes the same current READY Scalp/Swing scanner setups persisted by the existing strategy engine. It requires a fresh setup candle, closed-candle confirmation, a valid SMC zone, and a current mark price inside that zone before submitting a market entry. Out-of-zone candidates remain waiting; no chase entry is sent.
- Every automated entry is bound to the durable activation ID and a deterministic client order ID. The 10-position cap, duplicate checks, hedge mode, isolated margin, side-specific leverage limits, risk sizing, contract filters, and exchange-confirmed protection remain mandatory.
- Existing live positions continue to be managed even after new entries are disabled or the global new-entry emergency stop is active. Management includes TP1 50% scale-out, breakeven stop, and confirmed 15M Scalp / 4H Swing structural trailing. The manager reconciles missing protection and requests/validates emergency closure.
- These routes and runner are deployed, but no live credentials or activation were configured. Real-account order, TP/SL, partial-close, close, and emergency-close validation remains a required pre-live checklist after the user creates Live keys. Never set the live flag to true before those account-specific checks pass.

- Dashboard Diagnostics displays live readiness blockers and the separate activation state. The open-position views merge paper and authorized live positions; live close/partial-close buttons call the dedicated live management routes rather than paper endpoints.
- Turning `LIVE_TRADING_ENABLED` off automatically invalidates the stored activation on the next scheduled run, preventing a later re-enable from silently resuming new live entries. Existing live position management and close operations remain available with the Live credentials.


### Final live-order safety additions — 2026-11-25

- Before a live order is sent, the system persists a PENDING position record and atomically reserves a global entry slot in the EngineStateV2 Durable Object. The reservation counts exchange positions, persisted pending/open positions, and other concurrent reservations against the hard 10-position cap; same-symbol/same-side pending entries are rejected.
- Live market-order responses are not treated as fills. The adapter queries the order by exchange order ID or client order ID, cancels an unfilled/stale order, and reconciles the order state against the actual position and exchange-side stop/target orders before marking the position OPEN.
- Unknown order outcomes remain durably PENDING and retain their reservation/idempotency claim. The scheduled position manager reconciles them, cancels stale unfilled orders, and only releases capacity after a verified zero-fill cancellation or a verified open position with both protective orders.
- Stop-loss and take-profit values are rounded to the contract's price tick before risk validation and submission. Existing position average price (avgPrice) is normalized to the entry price used by post-fill risk checks.
- Close and protective-order management support both hedge and one-way position-side semantics, while new entries still require hedge mode so Scalp and Swing can hold opposite sides independently.
- CI currently reports 111 passing tests, including order status, pending-entry recovery, capacity reservation, credential separation, tick rounding, and protective-order serialization.
