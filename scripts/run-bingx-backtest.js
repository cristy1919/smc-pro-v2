import { writeFile } from "node:fs/promises";
import { BingXPublicKlineProvider, fetchEngineDataset } from "../src/bingx-market-data.js";
import { BingXVSTDemoAccount } from "../src/bingx-vst-account.js";
import { evaluateScalp, evaluateSwing } from "../src/setup-evaluator.js";
import { runHistoricalBacktest } from "../src/multi-timeframe-backtest.js";

const engine=String(process.env.ENGINE??"scalp").toLowerCase();
const symbol=String(process.env.SYMBOL??"BTC-USDT").toUpperCase();
const apiKey=process.env.BINGX_API_KEY;
const secretKey=process.env.BINGX_SECRET_KEY??process.env.BINGX_API_SECRET;
if(!apiKey||!secretKey)throw new Error("BINGX_VST_READ_ONLY_SECRETS_REQUIRED: set BINGX_API_KEY and BINGX_SECRET_KEY as runtime secrets");
if(!["scalp","swing"].includes(engine))throw new Error("ENGINE must be scalp or swing");
const now=Date.now(),startTime=now-90*86400000;
const account=new BingXVSTDemoAccount({apiKey,secretKey});
const balance=await account.getBalance();
if(balance.source!=="BINGX_VST"||balance.readOnly!==true||balance.asset!=="USDT")throw new Error("UNVERIFIED_BINGX_VST_ACCOUNT");
const provider=new BingXPublicKlineProvider();
const timeframes=await fetchEngineDataset({provider,symbol,engine,startTime,endTime:now});
const evaluate=engine==="scalp"?evaluateScalp:evaluateSwing;
const fundingRates=await provider.getFundingRates({symbol,startTime,endTime:now,limit:100});
if(!fundingRates.length)throw new Error("BINGX_HISTORICAL_FUNDING_DATA_MISSING");
const common={engine,symbol,timeframes,evaluate,fundingRates,periodDays:[30,60,90],initialEquity:balance.equity,feeRate:Number(process.env.FEE_RATE??0.0005),slippageRate:Number(process.env.SLIPPAGE_RATE??0.0002),fundingRate:Number(process.env.FUNDING_RATE??0)};
let report;
if(engine==="swing"){
  const run=(entryTimeframe,filters={})=>runHistoricalBacktest({...common,entryTimeframe,...filters});
  report={
    comparison:{entry15m:run("15m"),entry1h:run("1h")},
    w05Short:{entry15m:run("15m",{setupIdFilter:"W05_RANGE_DEVIATION",directionFilter:"BEARISH"}),entry1h:run("1h",{setupIdFilter:"W05_RANGE_DEVIATION",directionFilter:"BEARISH"})},
    methodology:{sameSymbol:symbol,same90dDataset:true,periodDays:[30,60,90],setupScoreMinimum:80,stopFirstOnSameCandle:true,manualClosesIncluded:false,entryTimeframeComparison:"15m retains 1h confirmation; 1h variant uses 1h entry after 1d bias and 4h zone context",w05ShortOnly:true}
  };
}else report=runHistoricalBacktest(common);
const output={account:{source:balance.source,asset:balance.asset,equity:balance.equity,availableMargin:balance.availableMargin,fetchedAt:balance.fetchedAt},report};
const serialized=JSON.stringify(output,null,2);
await writeFile("backtest-report.json",serialized+"\n",{encoding:"utf8"});
process.stdout.write(serialized+"\n");
