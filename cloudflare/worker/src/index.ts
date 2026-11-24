import { reconcileDailyPnlFromLedger, scanCloseRealizedDelta, summarizeClosedTradeAnalytics, topUpPaperCapitalOnce, updatePositions, resolveContractLeverage, recordModelExecutionDecision, updateConfirmedStructuralBiasState, summarizeAltcoinBreadthBias, type Candle, type PaperLedger, type Setup } from "./paper-engine";
import { ACTIVE_SWING_MODEL_SET, filterActiveSwingDiagnostics, filterActiveSwingModelTelemetry, filterActiveSwingSetups } from "./strategy-allowlist";
import { evaluateEngine } from "./scalp-swing-engine";
import { getBingXDemoSnapshot, getBingXDemoPositions, getBingXDemoOpenOrders, getBingXDemoClosedFills, getBingXDemoOrderHistory, isBingXDemoConfigured, placeBingXDemoEntry, reconcileBingXDemoLimitEntry, manageBingXDemoProtection, closeBingXDemoPosition, cancelBingXDemoOrder, shouldRetryBingXDemoPendingCancel, isBingXDemoPendingEntryAbsentFromSnapshot, cleanupOrphanBingXDemoEntryOrders, type BingXDemoPendingLimitEntry, type BingXDemoPositionMeta, type BingXDemoPosition, type BingXDemoSnapshot } from "./bingx-demo";
import { aggregateClosedCandles } from "./market-data-utils";
import { buildBingXOrderHistoryClosedTrades, mergeBingXOrderHistorySnapshots } from "./bingx-trade-history";


import { summarizeCloudflareBillableUsage } from "./cloudflare-usage";
import { buildActivitySnapshot, buildActivityPriorityBatch, rankActivitySnapshots } from "./activity-ranking";
import { isRetryableMarketDataFailure, marketDataRetryDelayMs, MARKET_DATA_REQUEST_TIMEOUT_MS, MARKET_DATA_MAX_ATTEMPTS, MARKET_DATA_REQUEST_SPACING_MS, resolveClosedCandleCacheTtlMs, isEligibleUsdtPerpetualSymbol, isEligibleUsdtPerpetualContract, buildEligibleCryptoUsdtPerpetualUniverse, resetScanRotationProgress, updateScanRotationProgress, reconcileScanRotationProgress, isTrustedManualCloseOrigin, MINIMUM_SWING_CANDLES } from "./scanner-policy";

function markBingXPendingSetupOpened(ledger:PaperLedger,pending:BingXDemoPendingLimitEntry,at=new Date().toISOString()):void {
  const source=pending.setup;
  const candidate=ledger.setups.find(item=>item.symbol===source.symbol&&item.side===source.side&& --- TRUNCATED --- 272,277 chars