# V1 infrastructure audit — read-only findings

Audit performed against the connected Cloudflare account on 2026-11-24. This is an inventory only; no Cloudflare resource was modified.

## Confirmed resources
- Worker script: `smcprov2`.
- Cron trigger: `*/5 * * * *`.
- Durable Object namespace: `smcprov2_EngineState`, class `EngineState`, SQLite enabled.
- KV namespace: `smcprov2-paper-state`.
- Worker bindings include the Durable Object namespace and KV namespace.
- Existing bindings also include BingX credential slots and mode flags. Secret values were not read or disclosed.
- Current worker settings include demo-related flags and a 1,000 USDT paper starting-balance setting. This does not mean the new repository paper engine is deployed or that BingX execution should be used.

## Preserve without changes
Do not stop, redeploy, rename or change the existing Worker, Cron, Durable Object namespace, KV namespace, bindings or secrets during repository implementation. Do not add D1. The old Worker may contain legacy strategy code; it must be inspected read-only before any migration or replacement decision.

## Not yet verified
- Existing Worker source and exact strategy/execution behavior.
- Durable Object schema, stored position/state records and migration compatibility.
- KV key schema and paper history completeness.
- OHLCV archive coverage, freshness, candle quality and BingX public/private API usage.
- Scanner universe completeness, batching, quota/backoff and cache hit rate.
- Existing dashboard routes, API contracts, open-position controls and statistics semantics.
- Whether current paper execution can be safely reused without invoking BingX demo endpoints.

## Required next audit tasks
1. Download/read the existing Worker source and map modules without changing deployment.
2. Inspect Durable Object class source and persisted SQL schema; do not export sensitive records unnecessarily.
3. Inventory KV keys/metadata only as needed; never dump secrets or user-sensitive values.
4. Map cron -> scanner -> shared market data -> engines -> risk -> paper execution -> dashboard.
5. Identify reusable components, defects and clean replacement boundaries.
6. Produce an integration matrix before any deployment.

No conclusion that the old system is reusable or broken should be made until those source and schema checks are complete.
