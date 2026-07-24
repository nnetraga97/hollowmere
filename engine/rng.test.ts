import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCALE } from './fixedpoint.ts';
import { createRng, deriveSeed, tickRng } from './rng.ts';

const WORLD = '00000000-0000-0000-0000-000000000001';

describe('deriveSeed', () => {
  test('is stable for the same parts', () => {
    assert.equal(deriveSeed(WORLD, 5, 'gossip'), deriveSeed(WORLD, 5, 'gossip'));
  });

  test('differs across worlds, ticks, and streams', () => {
    const base = deriveSeed(WORLD, 5, 'gossip');
    assert.notEqual(base, deriveSeed('00000000-0000-0000-0000-000000000002', 5, 'gossip'));
    assert.notEqual(base, deriveSeed(WORLD, 6, 'gossip'));
    assert.notEqual(base, deriveSeed(WORLD, 5, 'movement'));
  });

  test('cannot collide by shifting a boundary between parts', () => {
    assert.notEqual(deriveSeed('ab', 'c'), deriveSeed('a', 'bc'));
  });

  test('produces a 32-bit unsigned value', () => {
    const seed = deriveSeed(WORLD, 1, 'gossip');
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff);
  });
});

describe('createRng', () => {
  test('is reproducible from a seed', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const drawsA = Array.from({ length: 100 }, () => a.nextU32());
    const drawsB = Array.from({ length: 100 }, () => b.nextU32());
    assert.deepEqual(drawsA, drawsB);
  });

  test('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    assert.notDeepEqual(
      Array.from({ length: 20 }, () => a.nextU32()),
      Array.from({ length: 20 }, () => b.nextU32()),
    );
  });

  test('nextU32 stays in range', () => {
    const rng = createRng(99);
    for (let i = 0; i < 5_000; i++) {
      const v = rng.nextU32();
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff);
    }
  });

  test('nextBelow stays in range and covers it', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const v = rng.nextBelow(6);
      assert.ok(v >= 0 && v < 6);
      seen.add(v);
    }
    assert.equal(seen.size, 6, 'every value in the range should occur');
  });

  test('nextBelow rejects invalid bounds', () => {
    const rng = createRng(1);
    assert.throws(() => rng.nextBelow(0), RangeError);
    assert.throws(() => rng.nextBelow(-3), RangeError);
    assert.throws(() => rng.nextBelow(2.5), RangeError);
  });

  test('nextBelow is close to uniform', () => {
    const rng = createRng(2024);
    const buckets = new Array(10).fill(0) as number[];
    const draws = 100_000;
    for (let i = 0; i < draws; i++) buckets[rng.nextBelow(10)]!++;
    for (const count of buckets) {
      // Expect 10,000 per bucket; allow a generous 5% band.
      assert.ok(Math.abs(count - draws / 10) < draws / 10 * 0.05, `bucket skew: ${count}`);
    }
  });

  test('chance handles the certain and impossible cases without drawing', () => {
    const rng = createRng(5);
    assert.equal(rng.chance(0), false);
    assert.equal(rng.chance(-1), false);
    assert.equal(rng.chance(SCALE), true);
    assert.equal(rng.chance(SCALE + 1), true);
  });

  test('chance approximates its probability', () => {
    const rng = createRng(31337);
    let hits = 0;
    const trials = 100_000;
    for (let i = 0; i < trials; i++) if (rng.chance(2_500)) hits++;
    assert.ok(Math.abs(hits / trials - 0.25) < 0.01, `observed rate ${hits / trials}`);
  });

  test('pick throws on an empty array', () => {
    assert.throws(() => createRng(1).pick([]), RangeError);
  });

  test('shuffle is a permutation and does not mutate the input', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = createRng(42).shuffle(input);
    assert.deepEqual([...out].sort((a, b) => a - b), [...input]);
    assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('shuffle is reproducible', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    assert.deepEqual(createRng(42).shuffle(input), createRng(42).shuffle(input));
  });
});

describe('tickRng', () => {
  test('same coordinates give the same sequence', () => {
    const a = tickRng(WORLD, 10, 'gossip');
    const b = tickRng(WORLD, 10, 'gossip');
    assert.equal(a.nextU32(), b.nextU32());
  });

  test('streams are independent, so adding draws to one cannot shift another', () => {
    // Draw heavily from gossip, then confirm movement is unaffected.
    const gossip = tickRng(WORLD, 10, 'gossip');
    for (let i = 0; i < 50; i++) gossip.nextU32();

    const movementAfter = tickRng(WORLD, 10, 'movement').nextU32();
    const movementFresh = tickRng(WORLD, 10, 'movement').nextU32();
    assert.equal(movementAfter, movementFresh);
  });
});
