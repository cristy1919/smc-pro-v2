# Execution mode runbook

This project has three mutually exclusive execution stages. The same Scalp/Swing signal definitions, 1R–4R reward/risk filter, sizing policy, isolated-margin rule, position cap, TP/SL handling and reconciliation requirements must be used in each stage. Only the account adapter and exchange environment change.

## Stage 1 — Internal Paper (current)

Required Worker settings:

- `BINGX_TRADING_MODE=paper`
- `PAPER_TRADING_ONLY=true`
- `DEMO_TRADING_ENABLED=false`
- `LIVE_TRADING_ENABLED=false`
- `ORDERFLOW_DEMO_EXECUTION_ENABLED=false`
- `EXCHANGE_DATA_SOURCE=BINGX_PUBLIC`

The current `PAPER_START_BALANCE_USDT=1000` is an internal test ledger value, not the user's BingX VST balance. Do not describe it as VST equity. Do not reset or rebase the existing paper ledger during a stage transition.

## Stage 2 — BingX VST Demo (not enabled)

Runtime secret names used by the deployed Worker:

- `BINGX_API_KEY`
- `BINGX_API_SECRET`

Note: the repository's separate read-only research/backtest workflow documents `BINGX_SECRET_KEY`; that is not the production Worker binding name. For the deployed VST order adapter, use `BINGX_API_SECRET`.

After both secrets are installed, the controlled stage transition sets:

- `BINGX_TRADING_MODE=demo`
- `DEMO_TRADING_ENABLED=true`
- `PAPER_TRADING_ONLY=true`
- `LIVE_TRADING_ENABLED=false`

The demo adapter must use `https://open-api-vst.bingx.com`, read actual USDT VST equity and available margin, and reconcile positions, open orders, fills and protective TP/SL orders before accepting entries. Internal Paper balance is not used as a substitute for the VST account snapshot.

Do not install live credentials in the demo key slots. Keep withdrawals disabled on the exchange API key.

## Stage 3 — BingX Live (not enabled)

Use a separate live-only key pair:

- `BINGX_LIVE_API_KEY`
- `BINGX_LIVE_API_SECRET`
- `LIVE_CONTROL_TOKEN` (separate Worker secret for control authorization)

The live adapter is locked to `https://open-api.bingx.com`. The deployed code has live account/position/order checks, durable idempotency, entry-slot reservations, position reconciliation and explicit activation controls.

After the VST stage has passed, the controlled Live transition must:
- Add the separate `BINGX_LIVE_API_KEY` / `BINGX_LIVE_API_SECRET` pair and `LIVE_CONTROL_TOKEN` as Worker secrets.
- Keep the existing Internal Paper ledger and scanner data path available with `BINGX_TRADING_MODE=paper`, but set `PAPER_TRADING_ONLY=false` so no internal paper orders are created.
- Keep `DEMO_TRADING_ENABLED=false` and set `LIVE_TRADING_ENABLED=true` only after the readiness review.
- Run the separate Live activation flow with fresh explicit confirmation.

Adding live secrets alone must not submit orders. Live entry remains blocked unless all of these are true:

1. `LIVE_TRADING_ENABLED=true` is deliberately set after the VST stage is accepted.
2. Live credentials are independent of the VST credentials.
3. The live account, hedge mode, isolated margin, position and open-order snapshots pass readiness checks.
4. A fresh explicit user confirmation activates the live execution gate.
5. Every candidate passes the same engine-specific timeframe, 1R–4R, stop/target, leverage, liquidity, capacity and duplicate-entry checks.

The live gate must remain disabled during Internal Paper and VST Demo. Do not use one API key pair for both environments.

## Shared execution contract

- Both Scalp and Swing engines are eligible for each stage.
- Scalp candidate setup/entry timeframe: 5m (1H direction, 15M liquidity/zones). Swing candidate setup/confirmation timeframe: 1h (1D direction, 4H structural zones, 15M entry). Higher-timeframe context remains part of each engine's independent analysis.
- Reward/risk is inclusive: minimum 1R, maximum 4R.
- Normal risk unit: 1R = 2% of the current authoritative account equity; reduced-risk setup = 0.5R.
- Isolated margin only; leverage policy and exchange contract limits are checked before entry.
- Maximum simultaneous positions: 10, with duplicate engine/symbol/side protection.
- TP1 closes 50% of original quantity; TP2 closes 52% of the remaining quantity; TP3 closes the remainder.
- Altcoin breadth is reported only when at least 60% of the eligible universe has fresh structural state; below that threshold it is `UNAVAILABLE`, not `NEUTRAL`.
- If balance, price, contract rules, position state, protective orders or required market data cannot be verified, fail closed and do not place an order.

## Secret handling

Never commit API keys, secret keys, control tokens, signed requests or account snapshots to GitHub. Install them only as Cloudflare Worker secrets at the relevant stage. Use separate VST and Live keys, restrict them to the required futures permissions, configure an IP allowlist where supported, and do not grant withdrawal permission.

## Current state

As of 2026-11-27, the Worker remains in Stage 1 Internal Paper. VST and Live execution are disabled. The code paths are prepared but the stage transitions still require credential installation and the verification gates above.
