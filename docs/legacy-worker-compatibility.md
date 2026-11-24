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
