export const ACTIVE_SWING_MODEL_IDS = [
  "S01_SWEEP_MSS_FVG","S02_BREAKER_RETEST","S03_BOS_DISPLACEMENT","S04_RANGE_DEVIATION","S05_FAILED_BREAKOUT","S06_OB_REACTION",
  "W01_HTF_OB_REVERSAL","W02_SUPPLY_DEMAND_REVERSAL","W03_SWEEP_CHOCH","W04_BREAKER_RETEST","W05_RANGE_DEVIATION","W06_CRT","W07_OTE","W08_BOS_CONTINUATION"
] as const;
export const ACTIVE_SWING_MODEL_SET = new Set<string>(ACTIVE_SWING_MODEL_IDS);
export function isActiveSwingModelId(value:unknown):boolean {const key=String(value??"").split(/[:|]/,1)[0].trim();return ACTIVE_SWING_MODEL_SET.has(key);}
export function filterActiveSwingSetups<T extends {model?:unknown}>(setups:T[]|null|undefined):T[]{return Array.isArray(setups)?setups.filter(x=>isActiveSwingModelId(x?.model)):[];}
export function filterActiveSwingDiagnostics<T extends object>(diagnostics:T[]|null|undefined):T[]{
 if(!Array.isArray(diagnostics))return [];
 return diagnostics.map(raw=>{const d=raw as Record<string,any>,td=d.timeframeDiagnostics;const timeframeDiagnostics=td&&typeof td==="object"?Object.fromEntries(Object.entries(td).filter(([key])=>isActiveSwingModelId(key))):td;const setupDetails=Array.isArray(d.setupDetails)?d.setupDetails.filter((x:any)=>isActiveSwingModelId(x?.model)):d.setupDetails;return {...d,timeframeDiagnostics,setupDetails} as T;});
}
export function filterActiveSwingModelTelemetry<T extends object>(telemetry:T|null|undefined):T|undefined{
 if(!telemetry||typeof telemetry!=="object")return undefined;
 const s=telemetry as Record<string,any>,filterMap=(v:unknown)=>v&&typeof v==="object"?Object.fromEntries(Object.entries(v as Record<string,unknown>).filter(([key])=>isActiveSwingModelId(key))):v;
 const recentDecisions=Array.isArray(s.recentDecisions)?s.recentDecisions.filter((x:any)=>isActiveSwingModelId(x?.model)):s.recentDecisions;
 const volumeShadow=s.volumeShadow&&typeof s.volumeShadow==="object"?{...s.volumeShadow,byModel:filterMap(s.volumeShadow.byModel),byModelTimeframe:filterMap(s.volumeShadow.byModelTimeframe)}:s.volumeShadow;
 return {...s,byModel:filterMap(s.byModel),byModelTimeframe:filt --- TRUNCATED --- 2,200 chars