# Existing Cloudflare production Worker audit (2026-11-24)

## Scope
This is a read-only audit of the existing `smcprov2` Worker. No Worker, KV, Durable Object, secret, or Cron mutation was performed during the audit.

## Active deployment
- Worker: `smcprov2`
- Active version: `1889`
- Version ID: `9995b354-06ae-4c60-810a-8da63ad9e753`
- Deployment ID: `8fb82cc0-066e-48fb-9862-c37d6aaea66b`
- Traffic allocation: 100% on version 1889
- Cron: `*/5 * * * *`
- Subdomain: `smcprov2-stack`

## Bindings observed (names and non-secret values only)
- `ENGINE_STATE`: Durable Object namespace, class `EngineState`, namespace ID `cfae2eb0e84c4c6abec591dc7cc61ee8`
- `PAPER_STATE`: KV namespace `smcprov2-paper-state`, namespace ID `d82f0fa3f3794fc7b317aa6329337786`
- `BINGX_TRADING_MODE=paper`
- `PAPER_TRADING_ONLY=true`
- `LIVE_TRADING_ENABLED=false`
- `DEMO_TRADING_ENABLED=false`
- `ORDERFLOW_DEMO_EXECUTION_ENABLED=false`
- `EXCHANGE_DATA_SOURCE=BINGX_PUBLIC`
- `PAPER_TRADE_ALLOCATION_PERCENT=2`
- `PAPER_START_BALANCE_USDT=1000` (existing configuration; do not assume this is the current BingX VST balance)
- Secret bindings exist for Cloudflare billing and live-control credentials; secret values are intentionally not retrieved or recorded.

## Persistent state observed
- KV namespace contains 847 keys.
- A Durable Object namespace listing returned one object with stored data.
- Existing KV records include BingX demo order history, pending limit entries, executed setup keys, position metadata, VST closed trades, and VST entry queue.
- Some of these records are large and contain actual trading history / order metadata. They must not be reset or migrated by blind overwrite.

## Code snapshot
- `smcprov2-worker-v1889.js` is the active bundled Worker script captured from Cloudflare.
- It is a bundled artifact, not original maintainable TypeScript source.
- It includes the older execution/strategy implementation and an allowlist of Scalp/Swing-labelled model IDs. The repository's new scanner scaffold is not a drop-in replacement for this Worker.

## Migration guardrails
1. Preserve current Worker, Cron, bindings, KV, and Durable Object namespace.
2. Keep live trading disabled.
3. Do not rotate or expose secrets.
4. Do not change the paper ledger key / baseline or initialize a new ledger until its current value and account semantics are understood.
5. Do not deploy the new repository's current `worker/index.js` to `smcprov2`: it uses a different KV binding and has no equivalent Durable Object / existing order lifecycle.
6. Implement and test maintainable Scalp/Swing modules separately, then integrate them into the old Worker through an explicit compatibility adapter and staged version deployment.

## Additional reconciliation findings (read-only)
- `bingx-demo-pending-limit-entries`: 10 persisted pending-entry records.
- `bingx-vst-entry-queue-v1`: 324 persisted queued entries.
- `bingx-vst-closed-trades-v1`: 80 persisted closed-trade records.
- `bingx-demo-order-history-v1`: 713 order-history rows in the stored snapshot (138 FILLED, 535 CANCELLED, 40 FAILED). The stored snapshot timestamp is not a live exchange query; these counts do not prove current exchange order status.
- The current code's allowlist contains S01-S06 and W01-W08, but persisted queue examples still contain older model identifiers such as `DISPLACEMENT_OB_RETEST_AND` and `DOW_DISPLACEMENT_OR`. The queue needs a controlled reconciliation before any new paper execution is enabled.
- `ensureInternalPaperAccount` derives its reset ID from `PAPER_START_BALANCE_USDT` and invokes the Durable Object capital-adjustment endpoint when the ID differs. Changing the existing value can archive/reset the internal paper ledger. Keep the current value unchanged until the Durable Object ledger and BingX VST balance source are reconciled.
- Worker code contains `NEW_PAPER_ENTRIES_ENABLED=true` and `STRATEGY_GENERATION_ENABLED=true`; however, BingX Demo API configuration requires both `BINGX_API_KEY` and `BINGX_API_SECRET`, and the observed Worker bindings did not expose either binding. No private credentials were retrieved. The current persisted queues are therefore not evidence of currently executable exchange orders.

These findings are state snapshots only. Do not automatically cancel, execute, clear, or requeue these records based on KV contents alone.

## Paper mode clarification
- Worker variables are `BINGX_TRADING_MODE=paper`, `PAPER_TRADING_ONLY=true`, `DEMO_TRADING_ENABLED=false`, and `LIVE_TRADING_ENABLED=false`.
- The code's BingX VST Demo configuration predicate requires `BINGX_TRADING_MODE=demo`, `DEMO_TRADING_ENABLED=true`, and both `BINGX_API_KEY` / `BINGX_API_SECRET`. The observed settings do not satisfy this predicate.
- Therefore the current runtime configuration is the Worker's internal paper mode, not a verified BingX VST Demo connection. Internal paper new-entry flags are compiled as enabled, while exchange Demo and live order routes are disabled by the observed environment configuration.
- The KV `engine-state` snapshot showed an internal paper balance/equity of 1000 USDT, runnerEnabled=true, zero open positions, zero setups and no lastScanAt value at the time read. This is a persisted KV snapshot, not a live Durable Object or exchange account read.
- The internal paper account initializer derives its reset ID from that 1000 USDT value. Do not replace it with a guessed VST balance or alter it before reading the canonical Durable Object state.

This distinction is a production blocker for the requested BingX VST-only mode. A verified read-only VST connection and canonical equity read are required before switching the runtime mode or enabling exchange Demo execution.
