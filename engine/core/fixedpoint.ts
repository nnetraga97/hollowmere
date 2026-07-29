/**
 * Fixed-point arithmetic for all simulation values.
 *
 * Every simulation quantity (tension, heat, trust, sentiment, valence,
 * reputation, confidence, importance) is a scaled integer, never a float.
 * Floats would make the simulation non-reproducible across machines, which
 * would break replay, the determinism tests, and the whole audit story.
 *
 * Representation: a value of 1.0 is stored as SCALE (10000).
 *
 * On JS numbers: these are IEEE doubles, but every value here is constrained to
 * a safe integer and every operation truncates back to an integer. Doubles
 * represent integers exactly up to 2^53, and our operands stay far below that
 * (see assertOperands), so the arithmetic is exact and platform-independent.
 */

export const SCALE = 10_000;

/** Range for magnitudes that cannot be negative: tension, heat, trust, importance. */
export const UNIT_MIN = 0;
export const UNIT_MAX = SCALE;

/** Range for values that carry a direction: sentiment, valence, reputation, confidence. */
export const SIGNED_MIN = -SCALE;
export const SIGNED_MAX = SCALE;

/**
 * A scaled integer. This is a documentation alias rather than a branded type —
 * branding every literal would add friction without catching much, since the
 * real invariant (integer, in range) is enforced at the database boundary by
 * CHECK constraints and here by assertFixed.
 */
export type Fixed = number;

/** Largest operand product we allow before precision could be at risk. */
const MAX_SAFE_PRODUCT = Number.MAX_SAFE_INTEGER;

function assertOperands(a: number, b: number, op: string): void {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new RangeError(`${op}: operands must be safe integers, got ${a}, ${b}`);
  }
  if (Math.abs(a) * Math.abs(b) > MAX_SAFE_PRODUCT) {
    throw new RangeError(`${op}: product of ${a} and ${b} exceeds safe integer range`);
  }
}

/** Assert a value is a valid fixed-point integer. Used at boundaries. */
export function assertFixed(v: number, label = 'value'): Fixed {
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`${label} must be a safe integer, got ${v}`);
  }
  return v;
}

/**
 * Multiply two fixed-point values. Truncates toward zero.
 *
 * Truncation (not rounding) is chosen because it is the same operation for
 * positive and negative values, which keeps signed quantities like sentiment
 * symmetric under negation.
 */
export function fpMul(a: Fixed, b: Fixed): Fixed {
  assertOperands(a, b, 'fpMul');
  return Math.trunc((a * b) / SCALE);
}

/** Divide two fixed-point values. Truncates toward zero. */
export function fpDiv(a: Fixed, b: Fixed): Fixed {
  assertOperands(a, SCALE, 'fpDiv');
  if (b === 0) {
    throw new RangeError('fpDiv: division by zero');
  }
  return Math.trunc((a * SCALE) / b);
}

/** Clamp to an explicit range. */
export function fpClamp(v: Fixed, min: Fixed, max: Fixed): Fixed {
  if (min > max) {
    throw new RangeError(`fpClamp: min ${min} exceeds max ${max}`);
  }
  return v < min ? min : v > max ? max : v;
}

/** Clamp to [0, SCALE] — for tension, heat, trust, importance. */
export function clampUnit(v: Fixed): Fixed {
  return fpClamp(v, UNIT_MIN, UNIT_MAX);
}

/** Clamp to [-SCALE, SCALE] — for sentiment, valence, reputation, confidence. */
export function clampSigned(v: Fixed): Fixed {
  return fpClamp(v, SIGNED_MIN, SIGNED_MAX);
}

/** Build a fixed-point value from a percentage. `fromPercent(25)` is 0.25. */
export function fromPercent(pct: number): Fixed {
  return Math.trunc((pct * SCALE) / 100);
}

/**
 * Build a fixed-point value from an exact ratio, avoiding a float literal at
 * the call site. `fromRatio(1, 3)` is 3333.
 */
export function fromRatio(numerator: number, denominator: number): Fixed {
  if (denominator === 0) {
    throw new RangeError('fromRatio: denominator is zero');
  }
  assertOperands(numerator, SCALE, 'fromRatio');
  return Math.trunc((numerator * SCALE) / denominator);
}

/**
 * Weighted average of fixed-point values. Weights need not sum to SCALE; they
 * are normalised by their own total, which keeps callers from having to
 * hand-balance weight sets.
 */
export function fpWeightedMean(
  terms: readonly (readonly [value: Fixed, weight: Fixed])[],
): Fixed {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const [value, weight] of terms) {
    weightedTotal += value * weight;
    weightTotal += weight;
  }
  if (weightTotal === 0) return 0;
  return Math.trunc(weightedTotal / weightTotal);
}

/** Render a fixed-point value for logs and UI. Never feed this back into rules. */
export function fpToDisplay(v: Fixed, decimals = 2): string {
  return (v / SCALE).toFixed(decimals);
}
