/**
 * Sequence allocation within a tick.
 *
 * Append-only history carries `UNIQUE (world_id, tick, seq)`, and that tuple is
 * the total order replay depends on. Allocating from a counter threaded through
 * the tick — rather than reading MAX(seq) per insert — keeps the order a
 * deterministic function of the code path taken, not of how the database
 * happened to interleave writes.
 */

export interface Seq {
  /** Next sequence number. Monotonic within the tick. */
  next(): number;
  /** How many have been issued. Useful for assertions and logging. */
  issued(): number;
}

export function createSeq(start = 0): Seq {
  let current = start;
  return {
    next: () => current++,
    issued: () => current - start,
  };
}
