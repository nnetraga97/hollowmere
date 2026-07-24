/**
 * Integer decay tables.
 *
 * Rumor heat and memory recency both decay geometrically with elapsed ticks.
 * The obvious implementation is `Math.exp(-lambda * dt)`, but `Math.exp` is not
 * guaranteed to be bit-identical across platforms or engine versions, which
 * would silently break replay and the cross-machine determinism test.
 *
 * Instead each table is built by repeated fixed-point multiplication — exact
 * integer arithmetic, identical everywhere. Geometric decay by a constant
 * per-tick factor is the same curve as exponential decay, just expressed in the
 * form we can compute exactly.
 */

import { SCALE, fpMul, type Fixed } from './fixedpoint.ts';

/**
 * Build a decay table where `table[n]` is the multiplier after `n` ticks.
 * `table[0]` is always SCALE (no decay yet).
 */
export function makeDecayTable(perTickFactor: Fixed, length: number): readonly Fixed[] {
  if (perTickFactor < 0 || perTickFactor > SCALE) {
    throw new RangeError(`makeDecayTable: factor must be in [0, ${SCALE}], got ${perTickFactor}`);
  }
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`makeDecayTable: length must be a positive integer, got ${length}`);
  }
  const table: Fixed[] = new Array(length);
  table[0] = SCALE;
  for (let i = 1; i < length; i++) {
    table[i] = fpMul(table[i - 1] as Fixed, perTickFactor);
  }
  return table;
}

/**
 * Look up the decay multiplier for an elapsed tick count.
 *
 * Beyond the end of the table the value is already fully decayed, so the final
 * entry is returned rather than throwing — a memory from 10,000 ticks ago is
 * simply worth nothing, not an error.
 */
export function decayAt(table: readonly Fixed[], elapsedTicks: number): Fixed {
  if (!Number.isInteger(elapsedTicks) || elapsedTicks < 0) {
    throw new RangeError(`decayAt: elapsedTicks must be a non-negative integer, got ${elapsedTicks}`);
  }
  if (elapsedTicks >= table.length) {
    return table[table.length - 1] as Fixed;
  }
  return table[elapsedTicks] as Fixed;
}

/**
 * Tables are sized well past the 360-tick world cap so lookups never saturate
 * during a real run; both curves reach zero long before the end.
 */
const TABLE_LENGTH = 512;

/**
 * Rumor heat: ×0.9 per tick. A rumor stays meaningfully hot for roughly 20
 * ticks (5 minutes of play), which is long enough to cross the town and short
 * enough that stale gossip stops driving behaviour.
 */
export const RUMOR_HEAT_FACTOR: Fixed = 9_000;
export const RUMOR_HEAT_DECAY = makeDecayTable(RUMOR_HEAT_FACTOR, TABLE_LENGTH);

/**
 * Memory recency: ×0.99 per tick, a half-life of about 69 ticks. Slower than
 * rumor heat on purpose — an agent should still be able to recall something
 * from earlier in the day even after the town has stopped talking about it.
 */
export const MEMORY_RECENCY_FACTOR: Fixed = 9_900;
export const MEMORY_RECENCY_DECAY = makeDecayTable(MEMORY_RECENCY_FACTOR, TABLE_LENGTH);

/**
 * Tension bleed-off: ×0.999 per tick. Deliberately very slow. Tension must fall
 * slower than accusations raise it, otherwise the town relaxes on its own and
 * the unattended run never reaches war.
 */
export const TENSION_DECAY_FACTOR: Fixed = 9_990;
export const TENSION_DECAY = makeDecayTable(TENSION_DECAY_FACTOR, TABLE_LENGTH);
