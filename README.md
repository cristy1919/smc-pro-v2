# SMC PRO V2

Independent price-action Scalp and Swing futures research engines.

## Safety status
- PAPER / RESEARCH ONLY. No exchange order adapter is enabled.
- Existing Cloudflare resources are not changed by this repository scaffold.
- No API keys or secrets belong in Git.

## Current repository scope
- Provider-neutral closed-candle contract and shared in-process candle cache.
- Causal pivot detection, basic market-structure labels/events, FVG and liquidity pool/sweep primitives.
- Separate Scalp/Swing timeframe plans and setup catalogs.
- Score framework, risk sizing guardrails and setup lifecycle primitives.
- Node.js tests run in GitHub Actions.

## Timeframes
- Scalp: 1H bias, 15M liquidity/zones, 5M entry.
- Swing: 1D bias, 4H zones, 1H confirmation, 15M entry.
- 1M and 3M are explicitly forbidden.

## Development
Requires Node.js 20+. Run `npm test`.

This is a staged foundation, not a production-ready trading bot. OB/Breaker/Supply-Demand/Range/CRT/OTE detection, validated signal composition, historical data adapter, backtest engine, durable state integration and dashboard remain subsequent milestones.
