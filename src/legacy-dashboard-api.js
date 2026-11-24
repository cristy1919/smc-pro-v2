const DEFAULT_HEADERS={"accept":"application/json"};
export class LegacySmcDashboardApi {
  constructor({baseUrl,fetchImpl=fetch,headers=()=>({})}={}){
    if(!baseUrl)throw new TypeError("baseUrl is required");
    if(typeof fetchImpl!=="function")throw new TypeError("fetchImpl is required");
    this.baseUrl=baseUrl.replace(/\/$/,"");this.fetchImpl=fetchImpl;this.headers=headers;
  }
  async #request(path,{method="GET",body}={}){
    const headers=new Headers({...DEFAULT_HEADERS,...this.headers()});
    if(body!==undefined)headers.set("content-type","application/json");
    const response=await this.fetchImpl(new URL(path,this.baseUrl),{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
    const payload=await response.json();
    if(!response.ok||payload?.ok===false)throw new Error(payload?.error??"LEGACY_DASHBOARD_API_"+response.status);
    return payload;
  }
  getDashboardData(){return this.#request("/api/data");}
  getPaperStatus(){return this.#request("/api/paper/status");}
  getAnalytics(){return this.#request("/api/paper/analytics");}
  getKlines({symbol,interval="15m",limit=500,startTime,endTime}={}){
    if(!/^[A-Z0-9]+-USDT$/.test(String(symbol??"")))throw new Error("INVALID_USDT_PERPETUAL_SYMBOL");
    if(!["5m","15m","1h","4h","1d"].includes(interval))throw new Error("FORBIDDEN_OR_UNSUPPORTED_TIMEFRAME");
    if(!Number.isInteger(limit)||limit<1||limit>1440)throw new RangeError("limit must be between 1 and 1440");
    const q=new URLSearchParams({symbol,interval,limit:String(limit)});
    if(startTime!==undefined)q.set("startTime",String(startTime));
    if(endTime!==undefined)q.set("endTime",String(endTime));
    return this.#request("/api/market/klines?"+q.toString());
  }
  closePosition({positionId,closePercent=100}={}){
    if(typeof positionId!=="string"||!positionId)throw new TypeError("positionId is required");
    if(!Number.isFinite(closePercent)||closePercent<=0||closePercent>100)throw new RangeError("closePercent must be between 0 and 100");
    return this.#request("/api/close",{method:"POST",body:{positionId,fraction:closePercent/100,confirmedByUser:true}});
  }
}
