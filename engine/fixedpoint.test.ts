import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCALE,
  assertFixed,
  clampSigned,
  clampUnit,
  fpClamp,
  fpDiv,
  fpMul,
  fpToDisplay,
  fpWeightedMean,
  fromPercent,
  fromRatio,
} from './fixedpoint.ts';

describe('fpMul', () => {
  test('multiplies scaled values', () => {
    assert.equal(fpMul(SCALE, SCALE), SCALE); // 1.0 * 1.0
    assert.equal(fpMul(5_000, 5_000), 2_500); // 0.5 * 0.5
    assert.equal(fpMul(SCALE, 0), 0);
  });

  test('truncates toward zero, symmetrically under negation', () => {
    // 0.3333 * 0.5 = 0.16665 -> truncates to 0.1666
    assert.equal(fpMul(3_333, 5_000), 1_666);
    assert.equal(fpMul(-3_333, 5_000), -1_666);
  });

  test('always returns an integer', () => {
    for (let a = 0; a <= SCALE; a += 137) {
      for (let b = 0; b <= SCALE; b += 331) {
        assert.ok(Number.isInteger(fpMul(a, b)), `fpMul(${a}, ${b}) was not an integer`);
      }
    }
  });

  test('rejects unsafe operands rather than losing precision silently', () => {
    assert.throws(() => fpMul(1.5, SCALE), RangeError);
    assert.throws(() => fpMul(Number.MAX_SAFE_INTEGER, SCALE), RangeError);
  });
});

describe('fpDiv', () => {
  test('divides scaled values', () => {
    assert.equal(fpDiv(SCALE, SCALE), SCALE);
    assert.equal(fpDiv(5_000, SCALE), 5_000);
    assert.equal(fpDiv(SCALE, 5_000), 2 * SCALE); // 1.0 / 0.5 = 2.0
  });

  test('throws on division by zero', () => {
    assert.throws(() => fpDiv(SCALE, 0), RangeError);
  });
});

describe('clamping', () => {
  test('clampUnit bounds to [0, SCALE]', () => {
    assert.equal(clampUnit(-1), 0);
    assert.equal(clampUnit(SCALE + 1), SCALE);
    assert.equal(clampUnit(4_242), 4_242);
  });

  test('clampSigned bounds to [-SCALE, SCALE]', () => {
    assert.equal(clampSigned(-SCALE - 1), -SCALE);
    assert.equal(clampSigned(SCALE + 1), SCALE);
    assert.equal(clampSigned(-4_242), -4_242);
  });

  test('fpClamp rejects an inverted range', () => {
    assert.throws(() => fpClamp(0, 100, 50), RangeError);
  });
});

describe('constructors', () => {
  test('fromPercent', () => {
    assert.equal(fromPercent(100), SCALE);
    assert.equal(fromPercent(25), 2_500);
    assert.equal(fromPercent(0), 0);
  });

  test('fromRatio truncates', () => {
    assert.equal(fromRatio(1, 2), 5_000);
    assert.equal(fromRatio(1, 3), 3_333);
    assert.equal(fromRatio(2, 3), 6_666);
  });

  test('fromRatio throws on zero denominator', () => {
    assert.throws(() => fromRatio(1, 0), RangeError);
  });
});

describe('fpWeightedMean', () => {
  test('normalises by total weight', () => {
    // Equal weights over 0.2 and 0.8 -> 0.5
    assert.equal(fpWeightedMean([[2_000, SCALE], [8_000, SCALE]]), 5_000);
  });

  test('respects unequal weights', () => {
    // 0.0 at weight 3, 1.0 at weight 1 -> 0.25
    assert.equal(fpWeightedMean([[0, 3 * SCALE], [SCALE, SCALE]]), 2_500);
  });

  test('returns zero when all weights are zero', () => {
    assert.equal(fpWeightedMean([[SCALE, 0]]), 0);
  });

  test('handles the empty case', () => {
    assert.equal(fpWeightedMean([]), 0);
  });
});

describe('invariants', () => {
  test('assertFixed rejects non-integers', () => {
    assert.throws(() => assertFixed(1.5), RangeError);
    assert.equal(assertFixed(42), 42);
  });

  test('fpToDisplay is for humans only', () => {
    assert.equal(fpToDisplay(5_000), '0.50');
    assert.equal(fpToDisplay(-10_000), '-1.00');
  });
});
