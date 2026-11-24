# SMCPROV2 — Technical specification v1.1

## Operating mode and safety
- Initial balance: 1,000 USDT virtual paper equity.
- No BingX Demo VST orders and no live orders in this phase. Exchange execution adapter stays disabled.
- BingX public market data is the intended primary market source after a provider adapter is implemented and validated. Do not assume private API credentials exist.
- 1m and 3m are prohibited at configuration, subscription, strategy and test boundaries.
- Missing optional metrics are explicitly UNAVAILABLE; never synthesize stale or estimated volume delta, aggressor flow, OI, funding or dominance.

## Independent engines and timeframes
Scalp and Swing have independent setup state, score, confidence, positions, trade records and statistics. They may emit opposing directions on the same symbol. Only portfolio exposure, correlation and total-risk controls are shared.

- Scalp: 1H structure/bias, 15M liquidity and zones, 5M setup and entry.
- Swing: 1D/weekly context, 4H zones, 1H confirmation, 15M entry.
- Neither engine can mutate or veto the other engine's signal. Global portfolio controls may reject a new exposure for risk reasons, with a recorded reason.

## Market universe and data
Include eligible crypto USDT-margined perpetual contracts only. Exclude metals, FX, indices, commodities, halted/ineligible contracts, insufficient history, poor candle quality, illiquid markets and excessive spread. Eligibility uses volume, spread, depth, volatility, data quality and simulated fill capacity, not 24h volume alone. Each engine maintains its own eligible subset.

Fetch shared candles once and fan out from a shared cache. Adaptive quota control slows scan cadence/batch size instead of silently stopping all scanning. BingX public market data is primary when integrated. BTC context uses weekly/1D/4H structure, liquidity and volume; BTC/USDT/altcoin dominance and OI/funding/volume delta use separate trustworthy sources where available.

## Price action
Core structure: HH, HL, LH, LL, swing highs/lows, BOS, CHoCH, MSB/MSS, EQH/EQL, buy-side/sell-side liquidity, sweeps and displacement. Zones: OB, FVG, breaker, mitigation, supply/demand, range high/low/equilibrium, deviation/re-entry, OTE and CRT. Zone records must carry formed-at, confirmed-at, touched/mitigated and invalidated-at information. No future candles may influence historical decisions.

BOS alone is not an entry. Each setup model defines its own prerequisites; reversal setups normally require a liquidity event, displacement/structural shift and closed-candle confirmation. Retest models wait for a valid retest; confirmation models wait for a closed candle. Expired/invalidated setups cannot be recycled and price must not be chased after an entry zone is missed.

### Scalp catalogue
- S01 Sweep + MSS + FVG
- S02 Breaker Retest
- S03 BOS + Displacement (continuation only with independent quality/confirmation checks)
- S04 Range Deviation
- S05 Failed Breakout
- S06 OB Reaction

### Swing catalogue
- W01 HTF OB Reversal
- W02 Supply/Demand Reversal
- W03 Sweep + CHoCH
- W04 Breaker Retest
- W05 Range Deviation / Turtle Soup
- W06 CRT
- W07 ICT OTE
- W08 BOS + Retest Continuation

## BTC directional context
BTC BULLISH: altcoin longs preferred; shorts require stronger countertrend confirmation. BTC BEARISH: shorts preferred; longs require stronger confirmation. BTC NEUTRAL/RANGE: assess each altcoin's own structure/liquidity; do not automatically disable trading. BTC state is based on weekly, daily and 4H structure, liquidity and volume, never a single candle. It is a contextual risk/score filter, not a prediction guarantee.

## Indicators: context only
Volume, Relative Volume, VWAP, ATR and RSI divergence are auxiliary context. OI, funding, volume delta/aggressor flow, BTC dominance, USDT dominance and altcoin dominance are optional if reliable sources exist. VWAP/ATR/RSI alone cannot create a trade. Correlated volume metrics must not be double-counted. Missing optional fields are UNAVAILABLE and do not stop the whole system unless a particular setup declares the field mandatory.

## Score and confidence
Scalp weights: HTF 15, liquidity 20, structure 20, zone 15, entry 20, volume 10.
Swing weights: HTF 20, liquidity 15, structure 20, zone 20, entry 15, volume 10.
Bands: 0–59 RED; 60–69 WAIT; 70–79 WATCH; 80–89 QUALIFIED; 90–100 HIGH QUALITY. The scanner shows all eligible pairs; candidates move through score and setup lifecycle gates. Score is not win probability.

Confidence is calibrated separately using historical outcomes grouped by engine, setup, direction, regime, HTF alignment, symbol, realized R and sample size. Insufficient samples display INSUFFICIENT DATA. Scalp and Swing samples are never pooled.

Hard filters override score: invalid stop, RR below configured floor, insufficient liquidity, malformed/stale/incomplete candles, contradictory setup direction, excessive slippage, missed/invalidated entry zone, portfolio cap breach or unsafe liquidation distance. Thresholds remain versioned and are changed only after out-of-sample tests.

## Risk and paper execution
- Starting virtual equity: 1,000 USDT.
- Initial conservative paper risk budget: 0.5% equity per normal trade; 0.25% for reduced-risk setups. This honors the initial 0.25–0.5% proposal while the separate 1R=2% convention is treated as a later configurable risk-unit definition, not an instruction to risk 2% on every first-phase trade.
- Maximum 10 simultaneous positions globally, subject to portfolio/correlation and margin constraints.
- Isolated-margin model. Leverage is not a proxy for risk; later 20x–50x is permitted only if modeled liquidation distance and margin tier remain safe. No leverage is applied in a way that hides loss sizing.
- Technical invalidation stop. Absolute RR floor must be explicitly configured; default first-phase floor is 1:1, with 1:2 preferred for qualification and 3.5R as a normal target objective, not a guaranteed outcome. Targets above 3.5R require HIGH QUALITY, high-volume evidence and additional feasibility filters.
- TP1 closes 50%; then stop moves to entry including estimated costs; remainder trails structural levels.
- Quantity is based on allowed monetary loss divided by stop distance, adjusted for fees, slippage and funding. Margin, notional, leverage and loss budget are distinct.
- No arbitrary time-based close.

## Lifecycle and audit trail
DETECTED → WATCH → QUALIFIED → ENTRY_PENDING → OPEN → TP1/MANAGEMENT → CLOSED. Terminal alternatives: INVALIDATED, EXPIRED, REJECTED. A setup may not return from a terminal state.

Every trade stores engine/setup ID, symbol/direction, detection time, trigger structure, analysis and entry timeframes, zone/trigger evidence, human-readable opening rationale, entry/stop/targets, score, confidence/sample size, source-data timestamps, open/close time, realized R, net P&L, fees/funding/slippage and exit reason. Position cards show the structural trigger, timeframes and concise rationale.

## Backtest acceptance
Run each engine separately over 30/60/90-day periods with the same symbol sample where comparisons require it. Include fees, funding, slippage and realistic limit/market fill rules. Use only information available at each candle close; no future leak. If TP and SL are both touched in one candle without intrabar data, assume adverse SL-first outcome. Separate train/test periods and regime reports. Report win rate, PF, expectancy, max DD, average R, recovery factor, frequency, MAE/MFE and costs. Never approve on a single favorable period.

Acceptance: zero lookahead, zero duplicate positions, zero invalid stops, positive expectancy after costs, tolerable drawdown across periods, explainable backtest/paper differences, separate engine reports.

## Dashboard
Exactly these tabs:
1. Anasayfa
2. Açık İşlemler
3. Grafik
4. İstatistik
5. Scanner
6. Bekleyen Setup
7. İşlem Adayları
8. Diagnostik

Scanner displays all scanned/eligible pairs and both engines in one view. Setups scoring 60+ enter Bekleyen Setup. Only candidates meeting their setup-specific entry conditions and hard filters move to İşlem Adayları. Paper execution opens a position from a candidate; the dashboard refresh never triggers a new market scan. Positions, stats and histories remain separated by engine.

## Infrastructure constraints
Phase 1 is a read-only audit of existing Cloudflare Worker, Durable Object SQLite namespace, KV, Cron, bindings, data archive, scanner/quota and dashboard/API surfaces. Preserve the existing Worker and Cron. Reuse existing Durable Objects and KV; do not introduce D1. No Cloudflare deploy or mutation until compatibility is reviewed and separately authorized. No credentials in Git.
