import { getLiveReadiness } from "./live-execution.js";

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function scannerSetupIdentity(setup) {
  return [setup?.model, setup?.symbol, setup?.side, setup?.tradeStyle, setup?.setupCandleTime ?? setup?.candleTime]
    .map(value => String(value ?? "")).join("|");
}

export async function runLiveSetupQueue({ env, setups = [], client, store, adapter, clock = () => Date.now(), automationStopped = false } = {}) {
  if (env?.LIVE_TRADING_ENABLED !== "true") return { ok: true, skipped: true, reason: "LIVE_NEW_ENTRIES_DISABLED" };
  if (automationStopped) return { ok: true, skipped: true, reason: "AUTOMATION_EMERGENCY_STOP_ACTIVE" };
  const readiness = getLiveReadiness(env);
  if (!readiness.ready) return { ok: false, skipped: true, reason: "LIVE_READINESS_BLOCKED", blockers: readiness.blockers };
  if (!client || !store || !adapter || typeof store.getActivation !== "function")
    return { ok: false, skipped: true, reason: "LIVE_RUNNER_DEPENDENCIES_MISSING" };
  const activation = await store.getActivation();
  if (activation?.active !== true || activation.confirmedByUser !== true || !activation.id)
    return { ok: true, skipped: true, reason: "LIVE_USER_ACTIVATION_REQUIRED" };

  const results = [];
  for (const setup of setups) {
    try {
      const engine = String(setup?.tradeStyle ?? setup?.engine ?? "").toLowerCase();
      const side = String(setup?.side ?? "").toUpperCase();
      const status = String(setup?.status ?? "").toUpperCase();
      const confirmed = setup?.entryConfirmed === true ||
        (Array.isArray(setup?.confirmations) && setup.confirmations.includes("CLOSED_CANDLE_CONFIRMATION"));
      if (!["scalp", "swing"].includes(engine) || !["LONG", "SHORT"].includes(side) ||
          status !== "READY" || !confirmed) continue;

      const symbol = String(setup.symbol ?? "");
      const candleTime = Number(setup.setupCandleTime ?? setup.candleTime);
      const intervalMs = engine === "scalp" ? 5 * 60 * 1000 : 60 * 60 * 1000;
      if (!positive(candleTime) || candleTime > clock() + 60000 || clock() - candleTime > intervalMs * 2) {
        results.push({ setupId: scannerSetupIdentity(setup), action: "WAIT_STALE_SETUP" });
        continue;
      }

      const zone = setup.audit?.zone ?? setup.zone ?? null;
      const zoneLow = Number(zone?.bottom ?? zone?.low);
      const zoneHigh = Number(zone?.top ?? zone?.high);
      if (!positive(zoneLow) || !positive(zoneHigh) || zoneLow >= zoneHigh) {
        results.push({ setupId: scannerSetupIdentity(setup), action: "WAIT_ENTRY_ZONE_UNAVAILABLE" });
        continue;
      }
      const markPrice = await client.getMarkPrice(symbol);
      if (markPrice < zoneLow || markPrice > zoneHigh) {
        results.push({ setupId: scannerSetupIdentity(setup), action: "WAIT_ENTRY_OUTSIDE_ZONE", markPrice, zoneLow, zoneHigh });
        continue;
      }

      const riskMultiple = Number(setup.riskMultiplier) === 0.5 || setup.audit?.countertrend === true ||
        setup.audit?.htfAligned === false || Number(setup.score) < 80 ? 0.5 : 1;
      const stopLoss = Number(setup.stopLoss);
      const takeProfit = Number(setup.takeProfit ?? setup.tp3 ?? setup.tp2 ?? setup.tp1);
      const unitRiskFraction = (Math.abs(markPrice - stopLoss) + markPrice * 0.0007 + stopLoss * 0.0007) / markPrice;
      const minLeverage = riskMultiple === 0.5 ? 5 : 20;
      const maxLeverage = riskMultiple === 0.5 ? 10 : 50;
      if (!positive(unitRiskFraction) || unitRiskFraction > 1 / minLeverage * 0.8) {
        results.push({ setupId: scannerSetupIdentity(setup), action: "REJECT_LIQUIDATION_BUFFER" });
        continue;
      }
      const leverage = Math.max(minLeverage, Math.min(maxLeverage,
        Math.floor((riskMultiple === 0.5 ? 0.4 : 0.8) / unitRiskFraction)));
      const setupId = scannerSetupIdentity(setup);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(setupId));
      const idempotencyKey = "smc-" + Array.from(new Uint8Array(digest)).slice(0, 16)
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      const candidate = {
        id: setupId, engine, symbol, direction: side, status: "QUALIFIED", entryEligible: true,
        entryConfirmation: { status: "CONFIRMED" }, entry: Number(setup.entry),
        stopLoss, takeProfit, tp1: Number(setup.tp1), tp2: Number(setup.tp2),
        score: Number(setup.score), leverage, marginMode: "ISOLATED", riskMultiplier: riskMultiple,
        setupTimeframe: setup.setupTimeframe, entryTimeframe: setup.entryTimeframe
      };
      const result = await adapter.submit(candidate, {
        riskMultiple, idempotencyKey,
        confirmation: { confirmedByUser: true, token: env.LIVE_CONTROL_TOKEN, activationId: activation.id }
      });
      results.push({ setupId, action: "LIVE_ENTRY_OPENED", result });
    } catch (error) {
      results.push({ setupId: scannerSetupIdentity(setup), action: "LIVE_ENTRY_REJECTED", error: String(error).slice(0, 200) });
    }
  }
  return { ok: true, activationId: activation.id, evaluated: setups.length, results };
}
