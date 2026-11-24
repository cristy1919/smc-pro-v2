# Existing smcprov2 Worker compatibility

This is a compatibility contract for the already deployed `smcprov2` Worker (archived source: `legacy/smcprov2-worker-v1889.js`). It is not permission to deploy or mutate production.

## Existing dashboard routes verified in the archived Worker

| Route | Existing behavior | New research integration |
|---|---|---|
| `GET /` and `GET /index.html` | Serves embedded Turkish dashboard HTML | The ten required tabs already exist in this archived UI |
| `GET /api/data` | Aggregates paper status, health, analytics, history, ticker, universe and global context | Existing dashboard API adapter reads this route |
| `GET /api/paper/status` | Reads the existing paper/demo status snapshot | Positions and paper account remain source-of-truth here |
| `GET /api/paper/analytics` | Returns closed-trade analytics | Keep Scalp and Swing reports separate |
| `GET /api/market/klines` | Public BingX OHLCV; limit 1–1440 | Chart data only; no dashboard-refresh-triggered scan |
| `POST /api/close` | Requires same-origin request, position ID, fraction in (0,1], and `confirmedByUser=true` | Dashboard close action delegates here; portion is expressed as a percentage in the new client adapter |
| `POST /api/paper/scan` and `POST /api/runner` | Administrative state-changing operations | Never called by dashboard refresh |

## Durable Object bridge constraints

The archived Worker exposes a narrow paper-state key allowlist. The list includes existing engine state, VST position metadata, pending entries, closed trades and recovery flags. It does **not** include a Scalp/Swing research-candidate key. Writing candidates into `engine-state` or replacing the whole state object is unsafe.

The bundled Worker also contains a storage-degraded fallback for the legacy paper ledger and historical SQL endpoints. A degraded response must be treated as unavailable data, not as an empty account. The separate `cloudflare/worker/src/durable-state.js` research repository is not a schema-compatible replacement for the existing `EngineState` implementation.

## Integration now present in this branch

- `LegacySmcDashboardApi` reads the existing routes and delegates explicit manual closes through `/api/close`.
- `buildLegacyDashboardPayload` maps research candidates to the existing dashboard field names.
- Research candidates remain `WAIT` and `entryEligible=false` until a separate risk and execution gate confirms them.
- The existing dashboard tab labels are preserved and normalized to the requested `Candidates (İşlem Adayları)` label.
- No new DO/KV namespace, key, migration, route or production binding is created by these modules.

## Production gates still required

1. Inspect the live Worker version and current Durable Object health immediately before any migration.
2. Map the research candidate store to a dedicated, versioned key/table without overwriting existing ledger state.
3. Reconcile the existing pending queue, positions, open orders and closed fills against BingX VST before enabling new entries.
4. Verify VST account equity with read-only credentials and then test demo-only order placement/cancel/TP-SL reconciliation.
5. Deploy a canary to the existing `smcprov2` Worker only after the above checks pass.

No production Worker, Durable Object, KV, Cron, API secret or exchange order was modified by this branch.

## Read-only production inspection (2026-11-24)

The currently deployed Worker was inspected through Cloudflare's read-only script/settings endpoints. The observed bindings are:

- `BINGX_TRADING_MODE=paper`, `PAPER_TRADING_ONLY=true`, `PAPER_START_BALANCE_USDT=1000`.
- `DEMO_TRADING_ENABLED=false`, `LIVE_TRADING_ENABLED=false`, `ORDERFLOW_DEMO_EXECUTION_ENABLED=false`.
- `EXCHANGE_DATA_SOURCE=BINGX_PUBLIC`.
- `ENGINE_STATE` is the existing `EngineState` namespace; `PAPER_STATE` is the existing KV namespace.
- The current Worker binding list contains no `BINGX_API_KEY` or `BINGX_API_SECRET` binding.
- Cron remains `*/5 * * * *`.

Consequently, the deployed Worker is currently in its internal paper-ledger mode, not verified BingX VST demo mode. Its `GET /api/paper/status` route reads the canonical Durable Object ledger and invokes the internal-paper account initialization guard; it does not establish a BingX VST balance. The dashboard `GET /api/data` aggregates this status route and related read endpoints; it does not invoke the scanner. Do not treat the displayed internal-paper equity as VST equity.

The source confirms the existing dashboard endpoints and the Durable Object paper-state key allowlist. A read-only SQLite schema query of the existing `main-engine` object showed `candles`, `archive_tasks`, `history_tasks`, and `engine_meta` application tables; there is no dedicated Scalp/Swing candidate or research-trade table. The internal `_cf_KV` table is protected and was not queried. The bridge allowlist also has no dedicated research-candidate key. Therefore the research adapter can map/read existing dashboard data, but candidate publication cannot safely be enabled against the current DO bridge until a separate versioned key/table and its persistence semantics are reviewed.

The deployed public hostname returned a network-level `Forbidden` response from this execution environment, so live HTTP response payloads were not independently exercised here. No Cloudflare resource was changed.
