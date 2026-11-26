const REQUIRED_READ=["readEngineSnapshot"];
export function createLegacyWorkerCompatibilityAdapter({readEngineSnapshot,writeCandidateSnapshot,closePosition}={}){
  if(typeof readEngineSnapshot!=="function")throw new TypeError("readEngineSnapshot adapter is required");
  if(typeof writeCandidateSnapshot!=="function")throw new TypeError("writeCandidateSnapshot adapter is required");
  return Object.freeze({
    async read(){const snapshot=await readEngineSnapshot();if(!snapshot||typeof snapshot!=="object")throw new Error("LEGACY_ENGINE_SNAPSHOT_UNAVAILABLE");return snapshot;},
    async publishCandidates({swing=[],generatedAt=Date.now()}={}){
      if(!Array.isArray(swing))throw new TypeError("candidate list must be an array");
      const safe={schemaVersion:2,generatedAt,scalp:[],swing:swing.filter(c=>["4h","1d"].includes(String(c.setupTimeframe??c.timeframe??"").toLowerCase())).map(sanitizeCandidate)};
      await writeCandidateSnapshot(safe);
      return {published:true,scalpCount:0,swingCount:safe.swing.length};
    },
    async close({positionId,closePercent}){
      if(typeof closePosition!=="function")throw new Error("LEGACY_POSITION_CLOSE_ADAPTER_NOT_CONFIGURED");
      if(typeof positionId!=="string"||!positionId.trim())throw new TypeError("positionId is required");
      if(!Number.isFinite(closePercent)||closePercent<=0||closePercent>100)throw new RangeError("closePercent must be in (0,100]");
      return closePosition({positionId,closePercent});
    }
  });
}
function sanitizeCandidate(c){
  if(!c||typeof c!=="object"||c.engine!=="swing"||!["4h","1d"].includes(String(c.setupTimeframe??c.timeframe??"").toLowerCase()))throw new TypeError("invalid research candidate");
  return {id:String(c.id),engine:"swing",symbol:String(c.symbol),direction:c.direction,setupId:c.setupId,state:c.state,score:c.score,confidence:c.confidence,entry:c.entry,stop:c.stop,target:c.target,setupTimeframe:c.setupTimeframe??c.timeframe,entryTimeframe:c.setupTimeframe??c.timeframe,createdAt:c.createdAt,evidence:Array.isArray(c.evidence)?c.evidence:[],entryConfirmation:c.entryConfirmation??{status:"PENDING"}};
}
