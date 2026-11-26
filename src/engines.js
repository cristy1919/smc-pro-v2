import { ENGINE_CONFIG, assertSupportedTimeframe } from "./config.js";
export const SETUPS = Object.freeze({ swing: ["W01_HTF_OB_REVERSAL", "W02_SUPPLY_DEMAND_REVERSAL", "W03_SWEEP_CHOCH", "W04_BREAKER_RETEST", "W05_RANGE_DEVIATION", "W06_CRT", "W07_OTE", "W08_BOS_CONTINUATION"] });
export function enginePlan(name) {
  if (name === "scalp") throw new Error("SCALP_ENGINE_REMOVED");
  const c = ENGINE_CONFIG[name];
  if (!c) throw new Error("Unknown engine");
  for (const tf of c.allowed) assertSupportedTimeframe(tf);
  return { ...c, setups: [...SETUPS[name]] };
}
const TRANSITIONS = { DETECTED: ["WATCH", "QUALIFIED", "INVALIDATED", "EXPIRED", "REJECTED"], WATCH: ["QUALIFIED", "INVALIDATED", "EXPIRED", "REJECTED"], QUALIFIED: ["ENTRY_PENDING", "INVALIDATED", "EXPIRED", "REJECTED"], ENTRY_PENDING: ["OPEN", "INVALIDATED", "EXPIRED", "REJECTED"], OPEN: ["TP1", "CLOSED"], TP1: ["CLOSED"], CLOSED: [], INVALIDATED: [], EXPIRED: [], REJECTED: [] };
export function transitionSetup(setup, next) { if (!TRANSITIONS[setup.state]?.includes(next)) throw new Error("Invalid setup transition"); return { ...setup, state: next, updatedAt: Date.now() }; }
