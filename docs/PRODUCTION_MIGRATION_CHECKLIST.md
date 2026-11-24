# Production integration checklist

This checklist must be completed before changing the existing `smcprov2` Worker.

## Preserve first
- [x] Capture active Worker version 1889 source in `legacy/smcprov2-worker-v1889.js` on `infra/archive-smcprov2-v1889`.
- [x] Record current Worker bindings, Cron, KV namespace, Durable Object namespace and deployment identity.
- [x] Confirm existing KV contains 847 keys and Durable Object namespace contains one object with stored data.
- [ ] Create and verify a recoverable backup of all relevant KV values and Durable Object storage using a supported export path.
- [ ] Record active BingX VST positions, pending orders and account equity from an authenticated read-only exchange endpoint.

## Reconcile persisted trading state
- [ ] Reconcile 10 stored pending-limit records against current exchange open orders.
- [ ] Reconcile 324 stored entry-queue items against the new S01-S06 / W01-W08 setup catalog.
- [ ] Preserve the 80 closed-trade records and 713-row order-history snapshot.
- [ ] Resolve the old queued model identifiers before enabling any new entry path.
- [ ] Inspect the Durable Object internal paper ledger and its `resetId` before changing any balance configuration.
- [ ] Replace the hard-coded 1000 USDT internal paper baseline with a verified BingX VST equity source only after ledger migration is tested.

## Engine and deployment gates
- [x] Confirmed-pivot market structure and SMC zone primitives implemented in the development branch.
- [x] CI passed 22 tests for the current PR head.
- [ ] Add Scalp/Swing-specific setup evaluators and separate score/confidence pipelines.
- [ ] Add shared OHLCV cache and quota-aware scan coordinator integrated with the existing Durable Object.
- [ ] Add cost-aware 30/60/90-day backtests with no-lookahead and conservative intrabar fill assumptions.
- [ ] Add paper lifecycle tests for duplicate prevention, invalid stops, partial TP1, breakeven and structural trailing.
- [ ] Add a compatibility adapter for the existing `PAPER_STATE` and `ENGINE_STATE` bindings.
- [ ] Deploy a canary Worker version with 0% traffic first; inspect logs and read-only endpoints.
- [ ] Promote only after explicit acceptance checks; keep live trading disabled.

## Prohibited until gates pass
- Do not reset KV or Durable Object storage.
- Do not change `PAPER_START_BALANCE_USDT` or initialize a new internal paper ledger.
- Do not clear/cancel persisted queues solely from KV snapshots.
- Do not deploy the current research scanner scaffold to `smcprov2`.
- Do not enable live or BingX Demo order execution.
