import { writeFile } from "node:fs/promises";
import { BingXPublicKlineProvider, fetchEngineDataset } from "../src/bingx-market-data.js";
import { evaluateScalp, evaluateSwing } from "../src/setup-evaluator.js";
import { runHistoricalBacktest } from "../src/multi-timeframe-backtest.js";

const symbol=String(process.env.SYMBOL??"BTC-USDT").toUpperCase();
if(!/^[A-Z0-9]+-USDT$/.test(symbol))throw new Error("SYMBOL must be a USDT-M perpetual such as BTC-USDT");
const now=Date.now(),startTime=now-30*86400000;
const provider=new BingXPublicKlineProvider();
const scalpData=await fetchEngineDataset({provider,symbol,engine:"scalp",startTime,endTime:now});
const swingData=await fetchEngineDataset({provider,symbol,engine:"swing",startTime,endTime:now});
const fundingRates=await provider.getFundingRates({symbol,startTime,endTime:now,limit:100});
if(!fundingRates.length)throw new Error("PUBLIC_HISTORICAL_FUNDING_DATA_MISSING; refusing to substitute a guessed funding rate");
const feeRate=Number(process.env.FEE_RATE??0.0005);
const slippageRate=Number(process.env.SLIPPAGE_RATE??0.0002);
if(!Number.isFinite(feeRate)||feeRate<0||!Number.isFinite(slippageRate)||slippageRate<0)throw new Error("INVALID_COST_ASSUMPTIONS");
const common={symbol,periodDays:[30],fundingRates,feeRate,slippageRate};
const scalp=runHistoricalBacktest({...common,engine:"scalp",timeframes:scalpData,evaluate:evaluateScalp});
const swing15m=runHistoricalBacktest({...common,engine:"swing",timeframes:swingData,evaluate:evaluateSwing,entryTimeframe:"15m"});
const swing1h=runHistoricalBacktest({...common,engine:"swing",timeframes:swingData,evaluate:evaluateSwing,entryTimeframe:"1h"});
const w05Short15m=runHistoricalBacktest({...common,engine:"swing",timeframes:swingData,evaluate:evaluateSwing,entryTimeframe:"15m",setupIdFilter:"W05_RANGE_DEVIATION",directionFilter:"BEARISH"});
const w05Short1h=runHistoricalBacktest({...common,engine:"swing",timeframes:swingData,evaluate:evaluateSwing,entryTimeframe:"1h",setupIdFilter:"W05_RANGE_DEVIATION",directionFilter:"BEARISH"});
const output={
  metadata:{symbol,generatedAt:new Date().toISOString(),dataWindowDays:30,source:"BingX public market-data endpoints",apiCredentialsRequired:false,privateAccountAccess:false,ordersPlaced:false,startingUsdtBalance:null,periodDays:[30],timeframes:{scalp:["1h","15m","5m"],swing:["1d","4h","1h","15m"]},fundingRecords:fundingRates.length,fundingCoverage:{from:fundingRates[0].fundingTime,to:fundingRates.at(-1).fundingTime},costAssumptions:{feeRatePerSide:feeRate,slippageRatePerSide:slippageRate},limitations:["Normalized equity index only; no fabricated USDT starting balance","No partial TP1/50% close or break-even stop management in this historical engine","No leverage, liquidation, spread/depth or market-impact simulation","Trades below score 80 or failing hard filters are excluded","30-day maximum observation horizon is a backtest data cap, not a live exit instruction","Funding is charged only when actual historical settlement records overlap the simulated holding period"]},
  scalp,
  swing:{entry15m:swing15m,entry1h:swing1h},
  w05SwingShort:{entry15m:w05Short15m,entry1h:w05Short1h}
};
const serialized=JSON.stringify(output,null,2);
await writeFile("backtest-report.json",serialized+"\n",{encoding:"utf8"});
process.stdout.write(serialized+"\n");
