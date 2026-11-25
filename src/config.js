export const ENGINE_CONFIG = Object.freeze({scalp:{bias:"1h",liquidity:"15m",entry:"5m",allowed:["1h","15m","5m"]},swing:{bias:"1d",zone:"4h",confirmation:"1h",entry:"15m",allowed:["1d","4h","1h","15m"]}});
export const RISK_CONFIG = Object.freeze({riskUnitFraction:0.02,reducedRiskFractionOfR:0.5,maxOpenPositions:10,minRewardRisk:1,normalTargetR:3.5,highTargetRequiresExtraConfirmation:true,minLeverage:20,maxLeverage:50});
export const DASHBOARD_TABS = Object.freeze(["Market Overview","Açık İşlemler","Scalp Scanner","Swing Scanner","Statistics","Candidates (İşlem Adayları)","Trade History","Diagnostics","Grafik"]);
export const SETUP_SCORE_MINIMUM = 60;
export function assertSupportedTimeframe(tf){if(tf==="1m"||tf==="3m")throw new Error("Forbidden timeframe: "+tf);if(!["5m","15m","1h","4h","1d","1w"].includes(tf))throw new Error("Unsupported timeframe: "+tf);return true;}
export function calculateRiskUnitUsd(initialVstEquity){if(!Number.isFinite(initialVstEquity)||initialVstEquity<=0)throw new RangeError("A valid BingX VST equity is required to initialize 1R");return initialVstEquity*RISK_CONFIG.riskUnitFraction;}
