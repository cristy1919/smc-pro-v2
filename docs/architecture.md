# SMCPROV2 Architecture

## Operating policy
- PAPER ONLY: no live orders or exchange execution in the initial build.
- Preserve the existing Cloudflare Worker, Durable Object namespace, KV namespace, bindings, and Cron. Do not stop or redeploy the existing Worker during the initial scaffold.
- Reuse the existing Durable Object and KV infrastructure; do not introduce D1.

## Engines
Scalp and Swing are independent strategy engines with separate signals, setup lifecycles, positions, scoring, confidence, statistics, and backtest reports. They share normalized market data, candle cache, and portfolio-level exposure controls. Opposite-direction positions from the two engines may coexist on the same symbol, subject to global risk limits.

## Timeframes
- Scalp: 1H directional context, 15M liquidity/zones, 5M setup and entry.
- Swing: 1D bias, 4H structural zones, 1H confirmation, 15M entry.
- 1M and 3M are not supported.

## Data and execution boundaries
Use a provider-neutral market-data interface and a shared cache so each candle set is fetched once. Missing optional metrics must be marked UNAVAILABLE, never estimated or silently reused when stale. Paper execution is isolated behind an execution adapter so a future exchange adapter does not require strategy rewrites.

## Delivery sequence
1. Read-only infrastructure audit.
2. Causal market-structure engine.
3. Zone detection.
4. Scalp engine.
5. Swing engine.
6. Scoring, risk, and BTC context.
7. Backtest and paper execution validation.
8. Dashboard.

Each phase must pass its tests before the next phase begins. No strategy may use future candles or unclosed-candle information.
