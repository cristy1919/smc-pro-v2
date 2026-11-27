# Paper Profitability Audit — 2026-11-27

## Scope and safety

- Source of the execution snapshot: Cloudflare Worker `smcprov2`, Paper ledger key `engine-state`.
- Closed-trade window: 2026-11-25 09:12:22 UTC through 2026-11-27 13:54:32 UTC.
- 177 closed trades were present. Only 143 had `pnlAccountingStatus=VERIFIED`; 34 were `UNSPECIFIED` and are excluded from the primary performance table.
- Net PnL per verified trade is provisionally calculated as `pnlUsdt - fundingPaidUsdt`. The inspected ledger records did not consistently expose separate entry-fee, exit-fee, or slippage fields, so fee/slippage inclusion cannot be independently reconciled from every closed-trade record. Treat the PnL and PF comparisons as provisional until ledger accounting is reconciled against the canonical balance transaction events.
- This is a short, roughly 53-hour paper sample, not evidence of durable profitability. The ledger contains historical Scalp-labeled trades, but the inspected deployed Worker bundle currently defines only the Swing engine and rejects Scalp as removed/unsupported. Therefore the Scalp rows describe historical ledger records, not proof that the currently deployed Scalp engine is active.
- No Worker, Durable Object, KV, balance, open position, or trading setting was modified during this audit. No order was submitted.

## Verified engine performance

| Engine | Verified trades | Win rate | Net PnL (USDT) | Profit factor |
|---|---:|---:|---:|---:|
| Scalp | 73 | 61.6% | +115.62 | 1.73 |
| Swing | 70 | 52.9% | -1.93 | 0.99 |
| Total | 143 | — | +113.69 | — |

Profit factor is gross positive net-trade PnL divided by the absolute gross negative net-trade PnL, using the same verified trade cohort.

## Model and direction findings

| Engine / setup / side | Trades | Win rate | Net PnL (USDT) | PF | Interpretation |
|---|---:|---:|---:|---:|---|
| Scalp S04 Range Deviation LONG | 29 | 62.1% | +40.37 | 1.86 | Best adequately sampled Scalp cohort in this snapshot |
| Scalp S04 Range Deviation SHORT | 10 | 60.0% | +20.53 | Positive, but small sample |
| Scalp S06 OB Reaction LONG | 7 | 57.1% | +24.55 | Too small for a production conclusion |
| Scalp S02 Breaker Retest LONG | 18 | 66.7% | +19.68 | Positive, but modest PF |
| Scalp S02 Breaker Retest SHORT | 8 | 50.0% | -2.10 | Negative, small sample |
| Swing W01 HTF OB Reversal SHORT | 10 | 80.0% | +35.68 | Positive, small sample |
| Swing W04 Breaker Retest SHORT | 8 | 62.5% | +19.40 | Positive, small sample |
| Swing W05 Range Deviation LONG | 4 verified | 75.0% | +18.64 | Too small; do not infer a stable edge |
| Swing W05 Range Deviation SHORT | 19 | 42.1% | -32.89 | PF 0.47; directional quarantine remains justified |
| Swing W07 OTE SHORT | 16 | 50.0% | -27.90 | PF 0.63; candidate for a paper-entry quarantine test |
| Swing W04 Breaker Retest LONG | 2 | 50.0% | -0.41 | Insufficient sample |

The deployed Worker already contains a W05 SHORT execution quarantine. Its embedded rationale refers to an older 17-trade sample; the current verified ledger cohort has 19 trades and still shows a negative result. Refresh the quarantine rationale from verified rolling data rather than leaving stale fixed statistics.

W07 OTE SHORT has 16 verified trades and remains negative. The two W07 LONG trades are in the 34 records with unspecified accounting status, so they are not reliable evidence for a LONG-side decision. Keep any proposed OTE quarantine as a research candidate until 30/60/90-day tests are run; do not silently convert this short paper sample into a permanent rule.

## Score calibration findings

Verified performance by recorded score band:

| Engine / score | Trades | Win rate | Net PnL (USDT) | PF |
|---|---:|---:|---:|---:|
| Scalp 70–79 | 50 | 64.0% | +105.52 | 2.38 |
| Scalp 80–89 | 13 | 61.5% | +23.93 | 1.64 |
| Scalp 90+ | 10 | 50.0% | -13.83 | 0.69 |
| Swing 70–79 | 33 | 48.5% | -9.47 | 0.89 |
| Swing 80–89 | 32 | 59.4% | +11.76 | 1.10 |
| Swing 90+ | 5 | 40.0% | -4.22 | 0.78 |

The current score is not monotonically predictive of net profitability in this sample. In particular, the 90+ cohorts underperform. The score should not be treated as empirical confidence or used alone to justify full risk. These bands are exploratory because the sample is short and some cohorts are small.

## Market regime coverage

Among the 143 verified trades, 85 have `marketRegime=UNAVAILABLE`. Regime-specific conclusions therefore have limited coverage. The verified Swing BEARISH cohort has 31 trades, 41.9% win rate, -67.35 USDT net PnL and PF 0.54. This is a strong filter candidate for 30/60/90-day validation, not an instruction to disable all Swing shorts.

## Deployed Worker implementation findings

1. The deployed Worker bundle and repository both show Swing-only production execution:
   - The deployed `ENGINE_CONFIG` defines only `SWING`.
   - The deployed evaluator rejects any engine other than `SWING` and returns `SCALP_ENGINE_REMOVED_OR_FORBIDDEN_TIMEFRAME`.
   - The deployed active-strategy allowlist filters only Swing models.
   - `src/setup-evaluator.js` throws `SCALP_ENGINE_REMOVED`.
   - `src/scoring.js` only defines Swing weights.
   - `src/risk-controller.js` rejects non-Swing candidates.
2. The deployed Worker response path calls `filterActiveSwingSetups(ledger.setups)`, and its diagnostics/telemetry filters retain only active Swing model IDs. The Scalp dashboard tab is therefore not evidence of a running Scalp evaluator.
3. The deployed `makeSetup` calculation awards the full entry-confirmation weight once the boolean confirmation gate passes. That factor therefore adds little ranking information between already-confirmed candidates. The remaining score factors should be checked against verified net outcomes.
4. The deployed risk multiplier uses countertrend, HTF alignment and score threshold; it does not require the empirical confidence result to be sufficiently sampled before assigning normal risk. This differs from the desired evidence-led risk policy.
5. The repository matrix backtest imports `evaluateScalp`, but the repository implementation throws `SCALP_ENGINE_REMOVED`; its catch-and-skip path means the Scalp matrix cannot be considered a valid Scalp backtest.
6. The repository matrix script's MAE/MFE expression was malformed and did not calculate excursion in R. The research branch replaces it with a shared validated `calculateExcursionsR` helper and unit tests for normalization, rounding, and invalid risk/movement inputs. The tests have been added but not run in GitHub Actions to conserve quota.

## Required validation before any production change

1. Reconcile the GitHub source with the actual deployed Worker source and establish one authoritative build path.
2. Repair the backtest harness: restore the real Scalp evaluator, correct MAE/MFE, and test both engines independently.
3. Run causal 30/60/90-day tests using the same pair sample for each comparison, closed candles only, historical funding, verified fee/slippage assumptions, stop-first same-candle handling, and no future leakage.
4. Test directional model quarantines and regime filters as separate variants; report PF, expectancy, drawdown, MAE/MFE, sample count and out-of-sample stability.
5. Test risk sizing separately: insufficient empirical sample should not automatically receive full risk. Do not increase the 2% equity risk unit or the 10-position cap.
6. Preserve all Paper history and open positions. Do not enable Demo or Live order execution as part of research.

## Current decision

No production parameters are changed by this audit. The research branch has only corrected the MAE/MFE calculation path and made the combined matrix fail closed before network access while Scalp evaluation is unavailable. The first validation priorities are:
- Keep the existing W05 Range Deviation SHORT quarantine.
- Test a W07 OTE quarantine variant.
- Test a Swing bearish-regime filter.
- Preserve the positive Scalp S04 Range Deviation edge while validating it out of sample.
- Recalibrate score and risk only after the corrected 30/60/90-day matrix is trustworthy.
