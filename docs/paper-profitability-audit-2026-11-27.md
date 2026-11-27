# Paper Profitability Audit — 2026-11-27

## Scope and safety

- Source of the execution snapshot: Cloudflare Worker `smcprov2`, Paper ledger key `engine-state`.
- Closed-trade window: 2026-11-25 09:12:22 UTC through 2026-11-27 13:54:32 UTC.
- 177 closed trades were present. Only 143 had `pnlAccountingStatus=VERIFIED`; 34 were `UNSPECIFIED` and are excluded from the primary performance table.
- Net PnL per verified trade is provisionally calculated as `pnlUsdt - fundingPaidUsdt`. The inspected ledger records did not consistently expose separate entry-fee, exit-fee, or slippage fields, so fee/slippage inclusion cannot be independently reconciled from every closed-trade record. Treat the PnL and PF comparisons as provisional until ledger accounting is reconciled against the canonical balance transaction events.
- This is a short, roughly 53-hour paper sample, not evidence of durable profitability. A fresh read of the live Cloudflare smcprov2 script confirms that its active bundle contains independent SCALP and SWING engines, the six S01–S06 Scalp models, 1H/15M/5M timeframes, and separate engine scoring weights. The earlier conclusion that the live Worker was Swing-only was incorrect. The checked-in GitHub cloudflare/worker/deployed/index.js and src/setup-evaluator.js are stale Swing-only artifacts and do not match the live Cloudflare bundle.
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

## Deployed Worker and repository source reconciliation

1. **Live Cloudflare Worker (smcprov2) is Scalp + Swing.** A direct read of the current Worker script bundle confirms:
   - evaluateEngine has separate SCALP and SWING paths.
   - Scalp uses 1H direction, 15M liquidity/zones, and 5M setup/entry; Swing uses 1D direction, 4H zones, 1H setup, and 15M entry.
   - The live bundle contains S01–S06 and W01–W08 pattern logic.
   - The live bundle has separate Scalp/Swing score weights and the configured 0–59 / 60–64 / 65–69 / 70–83 / 84–100 score bands.
   - Historical confidence is calculated separately by engine, setup, symbol, side, regime, and HTF alignment, with a 30-trade minimum sample.
2. **GitHub source is inconsistent with the live Worker.** The default-branch src/setup-evaluator.js, src/scoring.js, src/engines.js, src/index.js and cloudflare/worker/deployed/index.js are Swing-only artifacts. The default-branch tests explicitly expect Scalp removal. The GitHub deployed bundle rejects Scalp, whereas the live Cloudflare Worker accepts Scalp. This is a source-of-truth and reproducible-build defect; do not deploy the default-branch bundle over the live Worker.
3. The feature/smc-price-action-v1 and feature/price-action-ci-verified branches contain earlier reusable evaluateScalp / evaluateSwing implementations and the correct base weight split, but they are not byte-for-byte or behaviorally identical to the current live Worker implementation. They are recovery references, not an automatic safe replacement.
4. The live Worker scoring implementation uses the configured weight budgets:
   - Scalp: HTF 15, liquidity 20, market structure 20, zone 15, entry confirmation 20, volume 10.
   - Swing: HTF 20, liquidity 15, market structure 20, zone 20, entry confirmation 15, volume 10.
   - It computes a weighted points breakdown, keeps empirical confidence separate, and reduces risk for countertrend / non-aligned / lower-score setups.
5. A live scoring review still needs to test the quality of factor discrimination. In the inspected Worker, entry-confirmation points are awarded at the full configured weight once the boolean entry-confirmation gate passes; this may provide little ranking separation among already-confirmed candidates. Volume points are derived from recent candle volume; missing volume receives no points and is labeled unavailable in the audit.
6. The research branch src/setup-evaluator.js remains Swing-only, so its matrix runner cannot currently produce a valid Scalp backtest. The research branch's MAE/MFE calculation has been corrected to adverseMove / risk and favorableMove / risk, and its regression tests cover the calculation, but GitHub Actions has not been run.
7. The deployed Worker and the checked-in build source must be reconciled before any Worker deployment. The live Worker is currently the only confirmed active source for the complete Scalp + Swing runtime; preserve it while recovering its source modules and tests.

## Required validation before any production change

1. Recover the exact live Scalp + Swing engine source from the active Worker bundle into version-controlled source modules, preserving behavior and the current production deployment.
2. Reconcile the default-branch Swing-only source and tests with the live Worker; remove the contradictory SCALP_ENGINE_REMOVED assumptions only after the recovered Scalp module is covered by tests.
3. Repair the backtest harness so it imports the recovered Scalp evaluator and the current Swing evaluator; MAE/MFE is already corrected on this research branch, but both engines still need independent regression coverage.
3. Run causal 30/60/90-day tests using the same pair sample for each comparison, closed candles only, historical funding, verified fee/slippage assumptions, stop-first same-candle handling, and no future leakage.
4. Test directional model quarantines and regime filters as separate variants; report PF, expectancy, drawdown, MAE/MFE, sample count and out-of-sample stability.
5. Test risk sizing separately: insufficient empirical sample should not automatically receive full risk. Do not increase the 2% equity risk unit or the 10-position cap.
6. Preserve all Paper history and open positions. Do not enable Demo or Live order execution as part of research.

## Current decision

No production parameters or Cloudflare resources were changed by this audit. The research branch has corrected the MAE/MFE calculation path, but its Scalp evaluator remains unavailable. The live Worker already runs Scalp + Swing; the immediate engineering task is to recover its exact Scalp/Swing implementation into the GitHub source and restore parity without deploying or changing the Paper ledger. The first validation priorities are:
- Keep the existing W05 Range Deviation SHORT quarantine.
- Test a W07 OTE quarantine variant.
- Test a Swing bearish-regime filter.
- Preserve the positive Scalp S04 Range Deviation edge while validating it out of sample.
- Recalibrate score and risk only after the corrected 30/60/90-day matrix is trustworthy.

## Scalp + Swing source recovery work (research branch)

- Recovered the earlier Scalp evaluator implementation into `src/scalp-evaluator.js` and wired `evaluateScalp()` into the current evaluator facade. The live Cloudflare Worker was already confirmed to contain its own active Scalp runtime; this recovery repairs the GitHub research source path and does not deploy anything.
- Restored the six S01–S06 Scalp setup IDs and 1H / 15M / 5M evaluation contract. Swing evaluation now accepts 1D / 4H context with 1H or 15M entry candles, matching the documented engine contract.
- Restored independent Scalp and Swing score weights: Scalp 15/20/20/15/20/10 and Swing 20/15/20/20/15/10 (HTF / liquidity / structure / zone / entry / volume). Score bands are RED 0–59, WAIT 60–64, WATCH 65–69, QUALIFIED 70–83, HIGH_QUALITY 84–100.
- Both scoring paths now use a fixed 100-point denominator. Missing factor values count as zero points and reduce `factorCoveragePct`; available factors are no longer renormalized upward.
- Restored `enginePlan('scalp')` and the Scalp/Swing dashboard tab configuration on the isolated research branch. The strategy-matrix backtest fetches a shared 1D/4H/1H/15M/5M candle set once per symbol, avoiding duplicate 1H and 15M requests between engines.
- Updated the strategy matrix eligibility threshold to QUALIFIED / score >= 70, aligned with the approved score bands, and expanded Swing matrix evaluation to 1H / 15M entry frames.
- Added regression coverage for Scalp evaluator availability, Scalp timeframes, engine score weights, missing-factor penalties, Swing entry frames, and shared market-data fetches.
- These changes are committed to `research/scalp-engine-recovery-2026-11-27`. GitHub Actions was deliberately not run to conserve quota; therefore the code has not yet passed an executed CI run. No production Worker, Paper account, Durable Object ledger, open position, or trading setting was changed. The existing `runHistoricalBacktest` utility remains Swing-only; the combined Scalp + Swing matrix is the dedicated research runner.

### Historical data limitations

- The combined matrix uses one shared fetch of 1D/4H/1H/15M/5M candles per symbol, so the common 1H and 15M datasets are not downloaded twice.
- Relative volume is calculated at each entry timestamp from the current closed candle and the preceding 20 closed candles only. It does not use future bars.
- Historical quote-volume and bid/ask spread are not provided by the selected historical kline endpoint. Both fields are marked `UNAVAILABLE`; the backtest does not invent them. The 50-pair universe is selected using the current quote-volume/spread snapshot, so universe survivorship/selection bias remains.
- Historical mode uses the causal relative-volume filter; it does not pretend that a current spread measurement was historically available. Fixed slippage remains an explicit assumption. A later production promotion requires separate historical liquidity/spread validation.