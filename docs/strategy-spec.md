# SMCPROV2 — Technical specification v1.2

## Operating mode and safety
- Execution venue: BingX USDT-M Futures VST Demo only. No live account endpoints or live order permissions may be used.
- The initial VST equity must be read from the authenticated BingX VST account endpoint. Do not hardcode or guess account equity. If balance retrieval fails, risk baseline is unavailable and order placement is blocked.
- No separate simulated paper balance. VST Demo is the execution and account-balance source of truth.
- BingX API credentials remain in Cloudflare Worker secrets only; never commit credentials to GitHub or expose them in logs.
- 1m and 3m are prohibited at configuration, subscription, strategy and test boundaries.
- Missing optional metrics are explicitly UNAVAILABLE; never synthesize stale or estimated volume delta, aggressor flow, OI, funding or dominance.

## Independent engines and timeframes
Scalp and Swing have independent setup state, score, confidence, positions, trade records and statistics. They may emit opposing directions on the same symbol. Only portfolio exposure, correlation and total-risk controls are shared.
- Scalp: 1H structure/bias, 15M liquidity and zones, 5M setup and entry.
- Swing: 1D/weekly context, 4H zones, 1H confirmation, 15M entry.

## Market universe and data
Include eligible crypto USDT-margined perpetual contracts only. Exclude metals, FX, indices, commodities, halted/ineligible contracts, insufficient history, poor candle quality, illiquid markets and excessive spread. Eligibility uses volume, spread, depth, volatility, data quality and simulated fill capacity, not 24h volume alone. Each engine maintains its own eligible subset. Fetch shared candles once and fan out from a shared cache. Adaptive quota control slows scan cadence/batch size instead of silently stopping all scanning. BTC context uses weekly/1D/4H structure, liquidity and volume.

## Price action and setups
Core structure: HH, HL, LH, LL, BOS, CHoCH, MSB/MSS, EQH/EQL, buy-side/sell-side liquidity, sweeps and displacement. Zones: OB, FVG, breaker, mitigation, supply/demand, range high/low/equilibrium, deviation/re-entry, OTE and CRT. Zone records carry formed-at, confirmed-at, touched/mitigated and invalidated-at information. No future candles may influence historical decisions. BOS alone is never an entry. Reversal setups normally require liquidity event, displacement/structural shift and closed-candle confirmation. Retest models wait for a valid retest. Expired/invalidated setups cannot be recycled and price must not be chased after a missed entry zone.

### Scalp catalogue
S01 Sweep + MSS + FVG; S02 Breaker Retest; S03 BOS + Displacement (with independent confirmation); S04 Range Deviation; S05 Failed Breakout; S06 OB Reaction.

### Swing catalogue
W01 HTF OB Reversal; W02 Supply/Demand Reversal; W03 Sweep + CHoCH; W04 Breaker Retest; W05 Range Deviation/Turtle Soup; W06 CRT; W07 ICT OTE; W08 BOS + Retest Continuation.

## BTC context and auxiliary indicators
BTC bullish: prefer altcoin longs; shorts need stronger countertrend confirmation. BTC bearish: prefer shorts; longs need stronger confirmation. Neutral/range: assess each altcoin independently. Volume, Relative Volume, VWAP, ATR and RSI divergence are context only. OI, funding, volume delta/aggressor flow and dominance are optional; unavailable data is marked UNAVAILABLE. No indicator-only entries.

## Score and confidence
Scalp weights: HTF 15, liquidity 20, structure 20, zone 15, entry 20, volume 10. Swing weights: HTF 20, liquidity 15, structure 20, zone 20, entry 15, volume 10. Bands: 0–59 RED; 60–64 WAIT; 65–69 WATCH; 70–83 QUALIFIED; 84–100 HIGH QUALITY. Hard filters override score. Confidence is independently calibrated only when sufficient closed-trade samples exist; otherwise INSUFFICIENT DATA. Confidence is independently calibrated from historical outcomes; low samples show INSUFFICIENT DATA. Hard filters override score: invalid stop, RR below 1:1, poor liquidity, bad/stale candles, contradictory direction, excessive slippage, missed/invalidated zone, portfolio cap or unsafe liquidation distance.

## Risk and BingX VST execution
- Read the actual available VST equity from BingX once when the new execution system is initialized. Persist an immutable risk baseline in Durable Object storage.
- 1R = exactly 2% of that initial VST equity. It is a fixed USDT amount for the lifetime of that baseline: it does not rise after profits or fall after losses. Do not compound/recalculate it from current equity.
- Reduced-risk setups use 0.5R. There is no arbitrary 20 USDT or 10 USDT cap; actual loss budget is derived from the real VST balance snapshot.
- If the initial VST equity cannot be retrieved or the baseline cannot be persisted, fail closed: do not submit orders.
- Maximum 10 simultaneous positions globally, subject to portfolio/correlation and margin constraints. Use isolated margin. Leverage is not a proxy for risk; 20x–50x only if liquidation distance and margin tier are safe.
- Position quantity is derived from the fixed USDT risk budget and technical stop distance, including fees, slippage and funding. Margin, notional, leverage and loss budget remain distinct.
- Hard minimum R:R is 1:1. Normal target objective is approximately 3.5R only when actual structure supports a realistic target; do not force 3.5R if the structure offers less. Targets above 3.5R require at least two additional setup-specific confirmations, high-volume evidence and a feasible structural target.
- TP1 closes 50%; then stop moves to entry including estimated costs; remainder trails structural levels. No arbitrary time-based close.
- Only BingX VST Demo endpoints and credentials are permitted. Live trading must be technically blocked, not merely hidden in the dashboard.

## Lifecycle and audit trail
DETECTED → WATCH → QUALIFIED → ENTRY_PENDING → OPEN → TP1/MANAGEMENT → CLOSED. Terminal alternatives: INVALIDATED, EXPIRED, REJECTED. Store engine/setup, symbol/direction, detection and entry times, trigger evidence, rationale, entry/stop/targets, score, confidence/sample size, source timestamps, open/close times, realized R, net P&L, fees/funding/slippage and exit reason.

## Backtest acceptance
Run engines separately over 30/60/90 days, include fees/funding/slippage and realistic fills, use closed candles only, assume adverse SL-first if TP and SL touch same candle without intrabar data. Report win rate, PF, expectancy, max DD, average R, recovery factor, frequency, MAE/MFE and costs. Acceptance: zero lookahead, duplicate positions or invalid stops; positive expectancy after costs; tolerable drawdown; separate engine reports.

## Dashboard
Exactly ten tabs: Market Overview, Açık İşlemler, Scalp Scanner, Swing Scanner, Positions, Statistics, İşlem Adayları, Trade History, Diagnostics, Grafik. Dashboard refresh never triggers scans. Scalp/Swing positions, statistics and histories remain independently filterable; shared exposure controls do not merge engine results.

## Infrastructure constraints
Audit and reuse existing Cloudflare Worker, Durable Object SQLite, KV and Cron; no D1. Preserve existing Cron and scanner. BingX credentials stay in Cloudflare secrets. Do not deploy or change production execution flags until the legacy-vs-new execution routing is audited and explicitly approved.
