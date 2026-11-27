# BingX Scalp + Swing research backtest runbook

This research run is fixed to **20 BingX USDT-M crypto perpetual pairs and the latest 30 completed days**. It evaluates the independent Scalp and Swing engines. Do not widen the pair count or date range for this run.

## Scope

- Universe: 20 currently eligible crypto USDT-M perpetuals ranked by current 24-hour quote volume, with BTC-USDT included.
- History: rolling 30 days ending at the run timestamp, plus timeframe-specific warmup candles.
- Scalp: 1H directional bias / 15M liquidity and zones / 5M setup and entry.
- Swing: 1D directional bias / 4H structure and zones / 1H confirmation / 15M or 1H entry.
- Both engines share the same fetched 1D, 4H, 1H, 15M and 5M candles for each pair; shared timeframes are downloaded once.
- 1M and 3M are forbidden. Only completed candles are used.
- Setups S01–S06 and W01–W08 are reported separately by direction and entry timeframe.

## Credentials and execution safety

The matrix uses public BingX market-data and historical funding endpoints. It does not require API credentials, read VST account data, or submit, amend, or cancel orders. It does not change the Paper runner or live/demo trading settings.

## Data and assumptions

- Relative volume is calculated causally from each closed entry-timeframe candle versus the preceding 20 closed candles.
- Historical quote-volume and bid/ask spread snapshots are unavailable from the OHLCV source. They remain UNAVAILABLE and are not estimated. Current quote-volume/spread are used only to select the present-day 20-pair research universe; this creates survivorship/universe-selection bias.
- Fees default to 0.05% per side and slippage to 0.02% per side. These are explicit assumptions, not verified account-specific rates.
- Historical funding settlements are applied by timestamp and position direction. A pair fails the data collection stage if funding history is missing; no funding estimate is substituted.
- If a stop and target are touched in the same candle, stop-first is assumed.
- TP1 closes 50%; the stop moves to breakeven for the remaining 50%; the remaining half targets 3.5R.
- Position risk compounds at 2% of normalized equity per 1R. The normalized equity index is not an actual VST account return.
- Each setup/direction/timeframe stream is simulated independently. Overlapping streams are not netted into a combined portfolio.
- The 30-day interval is one reporting segment; no 60/90-day runs or multi-segment walk-forward claims are made.
- Historical order-book depth, time-varying spread, market impact, leverage tiers and liquidation are not available from this dataset. These are not inferred.
- Sparse setup/regime groups remain descriptive; low trade counts are marked INSUFFICIENT_SAMPLE.

## Validation and interpretation

A completed run is a research result, not approval to enable paper order execution. Review candle coverage, pair completeness, funding coverage, sample sizes, fees, drawdown, MAE/MFE and the full trade ledger. No strategy is deleted or enabled in the Paper runner based only on this report.
