# Strategy specification — initial implementation boundary

## Independent engines
- Scalp: 1H bias, 15M liquidity/zones, 5M entry.
- Swing: 1D bias, 4H zones, 1H confirmation, 15M entry.
- 1M and 3M are forbidden. Engines retain separate setup IDs, state, scores and statistics.

## Price action
Market structure (HH/HL/LH/LL, BOS, CHoCH), liquidity pools/sweeps and FVG are implemented as foundational modules. OB, Breaker, Supply/Demand, Range, CRT and OTE require subsequent validated modules. BOS alone is never an entry: production qualification must require displacement, closed-candle confirmation, retest/entry trigger, valid stop, liquidity and RR checks.

## Scoring
Scalp weights: HTF 15, liquidity 20, structure 20, zone 15, entry 20, volume 10. Swing weights: HTF 20, liquidity 15, structure 20, zone 20, entry 15, volume 10. Bands: 0–59 RED; 60–69 WAIT; 70–79 WATCH; 80–89 QUALIFIED; 90–100 HIGH QUALITY. Confidence is separate and currently INSUFFICIENT_DATA.

## Risk
Initial paper equity 1,000 USDT; default risk 2% of current equity; reduced risk 1%; minimum RR 1:2; max 10 concurrent positions. Position sizing includes fee/slippage inputs. No exchange orders in this phase.

## Data integrity
Only closed candles, strictly increasing timestamps, provider-neutral adapter and shared in-process cache. Optional OI/funding/delta/dominance remain UNAVAILABLE until sourced. No future candle access.
