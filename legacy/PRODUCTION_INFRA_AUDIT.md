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
