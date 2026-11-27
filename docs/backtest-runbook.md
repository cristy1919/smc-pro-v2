# BingX VST backtest runbook

The manual GitHub Actions workflow `BingX VST read-only backtest` runs the selected engine for 30, 60 and 90 calendar days.

## Required repository secrets

Add these under GitHub repository Settings → Secrets and variables → Actions:

- `BINGX_API_KEY`
- `BINGX_SECRET_KEY`

Use a dedicated BingX Demo/VST API key with read-only account permission. Do not paste credentials into chat, commits, workflow inputs or logs. The workflow fails before data retrieval if either secret is missing.

## Run

1. Open Actions → BingX VST read-only backtest.
2. Select `scalp` or `swing`.
3. Enter a USDT-M perpetual symbol such as `BTC-USDT`.
4. Run workflow.
5. Download the `backtest-report.json` artifact.

The script runs the independent Scalp (S01–S06) and Swing (W01–W08) evaluators, reads VST USDT equity from the VST host, then fetches public BingX USDT-M candles and historical funding settlements. It does not submit, amend or cancel orders.

## Data and assumptions

- Scalp timeframes: 1H directional bias / 15M liquidity and zones / 5M setup and entry.
- Swing timeframes: 1D directional bias / 4H structure and zones / 1H confirmation / 15M or 1H entry.
- 1M and 3M are rejected.
- Forming candles are excluded.
- 1H history uses the same 30-day warmup window across engines; lower Scalp frames use 2-day warmup; Swing 1D/4H also use 30-day warmup.
- Fees default to 0.05% per side and slippage to 0.02% per side; both are assumptions unless replaced with verified account-specific rates.
- Historical funding settlements are applied by timestamp and position direction.
- If a stop and target are both touched in the same candle, the stop is assumed first.
- Position risk compounds at 2% of current equity per 1R.
- Confidence remains INSUFFICIENT_DATA until the sample is large enough.

A completed run is a research result, not approval to enable paper order execution. Review candle coverage, missing data, sample size, fees, funding, drawdown and trade ledger before any further integration.
