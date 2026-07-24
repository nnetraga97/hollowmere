import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCALE } from './fixedpoint.ts';
import {
  MEMORY_RECENCY_DECAY,
  RUMOR_HEAT_DECAY,
  RUMOR_HEAT_FACTOR,
  TENSION_DECAY,
  decayAt,
  makeDecayTable,
} from './decay.ts';

describe('makeDecayTable', () => {
  test('starts undecayed', () => {
    assert.equal(makeDecayTable(9_000, 10)[0], SCALE);
  });

  test('applies the factor once per tick', () => {
    const table = makeDecayTable(5_000, 5);
    assert.deepEqual([...table], [10_000, 5_000, 2_500, 1_250, 625]);
  });

  test('is monotonically non-increasing', () => {
    for (const table of [RUMOR_HEAT_DECAY, MEMORY_RECENCY_DECAY, TENSION_DECAY]) {
      for (let i = 1; i < table.length; i++) {
        assert.ok(table[i]! <= table[i - 1]!, `table increased at index ${i}`);
      }
    }
  });

  test('contains only integers', () => {
    for (const v of RUMOR_HEAT_DECAY) assert.ok(Number.isInteger(v));
  });

  test('rejects invalid input', () => {
    assert.throws(() => makeDecayTable(-1, 10), RangeError);
    assert.throws(() => makeDecayTable(SCALE + 1, 10), RangeError);
    assert.throws(() => makeDecayTable(9_000, 0), RangeError);
  });

  test('is built without Math.exp, so it is identical on every platform', () => {
    // Rebuilding from the same factor must reproduce the shipped table exactly.
    const rebuilt = makeDecayTable(RUMOR_HEAT_FACTOR, RUMOR_HEAT_DECAY.length);
    assert.deepEqual([...rebuilt], [...RUMOR_HEAT_DECAY]);
  });
});

describe('decayAt', () => {
  test('returns the table entry', () => {
    assert.equal(decayAt(RUMOR_HEAT_DECAY, 0), SCALE);
    assert.equal(decayAt(RUMOR_HEAT_DECAY, 1), 9_000);
  });

  test('saturates past the end of the table rather than throwing', () => {
    assert.equal(decayAt(RUMOR_HEAT_DECAY, 1_000_000), RUMOR_HEAT_DECAY.at(-1));
  });

  test('rejects negative or fractional elapsed ticks', () => {
    assert.throws(() => decayAt(RUMOR_HEAT_DECAY, -1), RangeError);
    assert.throws(() => decayAt(RUMOR_HEAT_DECAY, 1.5), RangeError);
  });
});

describe('tuned curves', () => {
  test('rumor heat is spent within a few minutes of play', () => {
    // ~20 ticks is 100s at the 5s rules tick.
    assert.ok(decayAt(RUMOR_HEAT_DECAY, 20) < 1_500, 'rumor should be cold by 20 ticks');
    assert.ok(decayAt(RUMOR_HEAT_DECAY, 5) > 5_000, 'rumor should still be hot at 5 ticks');
  });

  test('memory recency outlives rumor heat', () => {
    assert.ok(
      decayAt(MEMORY_RECENCY_DECAY, 20) > decayAt(RUMOR_HEAT_DECAY, 20),
      'an agent should still recall what the town has stopped discussing',
    );
  });

  test('tension bleeds off slower than memory fades', () => {
    // If tension relaxed quickly the unattended run would never reach war.
    assert.ok(decayAt(TENSION_DECAY, 100) > decayAt(MEMORY_RECENCY_DECAY, 100));
    assert.ok(decayAt(TENSION_DECAY, 360) > 6_000, 'tension must persist across a full world');
  });
});
