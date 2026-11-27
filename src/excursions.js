export function calculateExcursionsR({ adverseMove, favorableMove, risk }) {
  for (const [name, value] of Object.entries({ adverseMove, favorableMove, risk })) {
    if (!Number.isFinite(value)) throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  if (risk <= 0) throw new RangeError("RISK_MUST_BE_POSITIVE");
  if (adverseMove < 0 || favorableMove < 0) throw new RangeError("EXCURSION_MOVES_MUST_BE_NON_NEGATIVE");
  return {
    maeR: Number((adverseMove / risk).toFixed(4)),
    mfeR: Number((favorableMove / risk).toFixed(4)),
  };
}
