import type { Candle } from "./paper-engine";

/**
 * Aggregate fully closed source candles into a larger UTC timeframe.
 * A target bar is emitted only when every source candle is present and contiguous.
 * Optional volume fields remain absent if any source candle lacks them.
 */
export function aggregateClosedCandles(source:Candle[],targetMs:number,sourceMs:number):Candle[] {
  if(!Number.isFinite(targetMs)||!Number.isFinite(sourceMs)||targetMs<=sourceMs||targetMs%sourceMs!==0)return [];
  const expected=targetMs/sourceMs;
  const groups=new Map<number,Candle[]>();
  for(const candle of source.slice().sort((a,b)=>a.time-b.time)){
    if(!Number.isFinite(candle.time)||candle.time%sourceMs!==0)continue;
    const start=Math.floor(candle.time/targetMs)*targetMs;
    const rows=groups.get(start)??[];
    rows.push(candle);
    groups.set(start,rows);
  }
  const result:Candle[]=[];
  for(const [start,rows] of [...groups.entries()].sort((a,b)=>a[0]-b[0])){
    rows.sort((a,b)=>a.time-b.time);
    if(rows.length!==expected||rows[0].time!==start||rows[rows.length-1].time+sourceMs!==start+targetMs)continue;
    if(rows.some((row,i)=>row.time!==start+i*sourceMs))continue;
    const sumOptional=(key:"volume"|"quoteVolume"|"takerBuyVolume"|"takerBuyQuoteVolume")=>{
      const values=rows.map(row=>row[key]);
      return values.every(value=>value!==undefined&&Number.isFinite(Number(value)))
        ?values.reduce<number>((sum,value)=>sum+Number(value),0):undefined;
    };
    result.push({
      time:start,open:rows[0].open,high:Math.max(...rows.map(row=>row.high)),
      low:Math.min(...rows.map(row=>row.low)),close:rows[rows.length-1].close,
      volume:sumOptional("volume"),quoteVolume:sumOptional("quoteVolume"),
      takerBuyVolume:sumOptional("takerBuyVolume"),takerBuyQuoteVolume:sumOptional("takerBuyQuoteVolume")
    });
  }
  return result;
}
