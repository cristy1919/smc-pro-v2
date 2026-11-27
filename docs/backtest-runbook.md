# BingX VST backtest runbook

The manual GitHub Actions workflow `BingX all-strategy matrix 50-pair 90-day backtest` runs both independent engines (Scalp and Swing) over 30/60/90-day segments. Do not run it for every code edit; run once after local validation to conserve Actions quota.

## Credentials

The matrix uses public BingX market-data and historical funding endpoints. It does not require BingX API credentials or read VST account data.

## Run

1. Open Actions → BingX all-strategy matrix 50-pair 90-day backtest.
2. Run the workflow manually; it evaluates both Scalp and Swing across the selected 50-pair universe.
3. Download the `bingx-strategy-matrix-50-pairs-90d-report.json` artifact.

The script runs the independent Scalp (S01–S06) and Swing (W01–W08) evaluators using public BingX USDT-M candles and historical funding settlements. It does not read VST account equity and does not submit, amend or cancel orders.

## Data and assumptions

- Scalp timeframes: 1H directional bias / 15M liquidity and zones / 5M setup and entry.
- Swing timeframes: 1D directional bias / 4H structure and zones / 1H confirmation / 15M or 1H entry.
- 1M and 3M are rejected.
- Forming candles are excluded.
- Warmup is fetched per timeframe: 1D/4H/1H use 45 days; 15M uses 14 days for Scalp and 7 days for Swing; 5M uses 3 days. Shared 1H/15M candles are fetched once per symbol.
- Relative volume is calculated causally from each closed entry-timeframe candle versus the preceding 20 closed candles.
- Historical quote-volume and bid/ask spread snapshots are not available in this dataset; they remain `UNAVAILABLE`, are not estimated, and are not applied as historical entry filters. Current quote-volume/spread are used only to select the present-day 50-pair research universe. This introduces universe-selection bias and must be disclosed in the report.
- Fees default to 0.05% per side and slippage to 0.02% per side; both are assumptions unless replaced with verified account-specific rates.
- Historical funding settlements are applied by timestamp and position direction.
- If a stop and target are both touched in the same candle, the stop is assumed first.
- Position risk compounds at 2% of current equity per 1R.
- Confidence remains INSUFFICIENT_DATA until the sample is large enough.

A completed run is a research result, not approval to enable paper order execution. Review candle coverage, missing data, sample size, fees, funding, drawdown and trade ledger before any further integration.
