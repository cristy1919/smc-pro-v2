import test from "node:test";
import assert from "node:assert/strict";
import { calculateExcursionsR } from "../src/excursions.js";

test("MAE and MFE are normalized by initial price risk", () => {
  assert.deepEqual(
    calculateExcursionsR({ adverseMove: 2.5, favorableMove: 7.5, risk: 5 }),
    { maeR: 0.5, mfeR: 1.5 },
  );
});

test("MAE and MFE round to four decimal places", () => {
  assert.deepEqual(
    calculateExcursionsR({ adverseMove: 1, favorableMove: 2, risk: 3 }),
    { maeR: 0.3333, mfeR: 0.6667 },
  );
});

test("excursion calculation rejects zero or negative risk", () => {
  assert.throws(() => calculateExcursionsR({ adverseMove: 1, favorableMove: 2, risk: 0 }), /RISK_MUST_BE_POSITIVE/);
  assert.throws(() => calculateExcursionsR({ adverseMove: 1, favorableMove: 2, risk: -1 }), /RISK_MUST_BE_POSITIVE/);
});

test("excursion calculation rejects invalid or negative movement", () => {
  assert.throws(() => calculateExcursionsR({ adverseMove: NaN, favorableMove: 2, risk: 1 }), /INVALID_ADVERSEMOVE/);
  assert.throws(() => calculateExcursionsR({ adverseMove: -1, favorableMove: 2, risk: 1 }), /EXCURSION_MOVES_MUST_BE_NON_NEGATIVE/);
});
