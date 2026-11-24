# SMC PRO V2

Independent price-action Scalp and Swing futures research engines.

## Safety status
- PAPER / RESEARCH ONLY. No exchange order adapter is enabled.
- Existing Cloudflare resources are not changed by this repository scaffold.
- No API keys or secrets belong in Git.

## Current repository scope
- Provider-neutral closed-candle contract and shared in-process candle cache.
- Causal pivot detection, market-structure labels/events, FVG, liquidity sweeps, OB/Breaker/Supply-Demand, Range/Deviation, CRT and OTE primitives.
- Separate Scalp/Swing multi-timeframe analysis orchestration and setup catalogs.
- BingX VST public OHLCV history and read-only VST equity adapters.
- Separate backtest engine, 30/60/90-day report helper, fees/funding/slippage, MAE/MFE and confidence calibration.
- SQLite Durable Object repository adapter and local paper-only execution abstraction.
- Score framework, risk sizing guardrails and setup lifecycle primitives.
- Node.js tests run in GitHub Actions.

## Timeframes
- Scalp: 1H bias, 15M liquidity/zones, 5M entry.
- Swing: 1D bias, 4H zones, 1H confirmation, 15M entry.
- 1M and 3M are explicitly forbidden.

## Development
Requires Node.js 20+. Run `npm test`.

See [research implementation status](docs/research-implementation.md) for implemented modules, remaining integration gates and deployment restrictions. This is not yet a production-ready or exchange-executing trading bot.
