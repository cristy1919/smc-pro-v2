import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCanonicalPaperBalance,
  isPaperLedgerMutation,
} from "../cloudflare/worker/src/paper-ledger-accounting.js";

test("canonical balance counts one automated close per position", () => {
  const canonical = {
    id: "p1",
    positionId: "p1",
    closeSource: "AUTOMATED_SL_TP",
    closedAt: 100,
    pnlUsdt: -20,
  };
  const duplicate = { ...canonical, closedAt: 101 };
  const balance = computeCanonicalPaperBalance({
    capitalAdjustments: [{ balanceAfter: 1000 }],
    closedTrades: [canonical, duplicate],
    positions: [
      {
        status: "OPEN",
        realizedPnlUsdt: -0.3,
        entryFeeUsdt: 0.2,
      },
    ],
  });
  assert.equal(balance, 979.5);
});

test("canonical balance keeps separate manual partial closes and later deposits", () => {
  const ledger = {
    capitalAdjustments: [
      { balanceAfter: 1000 },
      { amountUsdt: 50 },
    ],
    closedTrades: [
      {
        id: "p2",
        positionId: "p2",
        closeSource: "MANUAL_API_REQUEST",
        closedAt: 200,
        closeReason: "MANUAL_PARTIAL_CLOSE",
        pnlUsdt: 4,
      },
      {
        id: "p2",
        positionId: "p2",
        closeSource: "MANUAL_API_REQUEST",
        closedAt: 300,
        closeReason: "MANUAL_PARTIAL_CLOSE",
        pnlUsdt: -1,
      },
    ],
    positions: [
      {
        id: "p2",
        status: "OPEN",
        realizedPnlUsdt: 2,
        entryFeeUsdt: 0.5,
      },
    ],
  };
  assert.equal(computeCanonicalPaperBalance(ledger), 1054.5);
});

test("paper scans and closes share the same mutation lock", () => {
  assert.equal(isPaperLedgerMutation("POST", "/paper/scan"), true);
  assert.equal(isPaperLedgerMutation("POST", "/paper/close"), true);
  assert.equal(isPaperLedgerMutation("PUT", "/state"), true);
  assert.equal(isPaperLedgerMutation("GET", "/paper/status"), false);
});
