/**
 * Memory retrieval.
 *
 * An agent about to think recalls the memories that are recent, important, and
 * relevant to what is in front of them. The three are combined with integer
 * arithmetic so the ordering is reproducible: a float score would make the
 * top-k boundary machine-dependent, and which memories an agent recalls changes
 * what it does.
 *
 * Two constraints from docs/preflight-findings.md shape the SQL here:
 *   - The query vector must be a bound parameter. As a subquery the optimizer
 *     ignores the index and silently falls back to a full scan.
 *   - The index opclass is vector_cosine_ops, so the operator must be `<=>`.
 */

import { decayAt, MEMORY_RECENCY_DECAY } from './decay.ts';
import { SCALE, clampUnit, fpMul, type Fixed } from './fixedpoint.ts';
import type { Client } from './db.ts';

/** Relative influence of each component. Tunable without touching the maths. */
export interface RetrievalWeights {
  recency: Fixed;
  importance: Fixed;
  relevance: Fixed;
}

export const DEFAULT_WEIGHTS: RetrievalWeights = {
  recency: SCALE,
  importance: SCALE,
  relevance: SCALE,
};

export interface RetrievedMemory {
  memoryId: string;
  kind: string;
  content: string;
  importance: Fixed;
  createdTick: number;
  lastAccessedTick: number;
  subjectAgentId: string | null;
  claimId: string | null;
  /** Component scores, retained so retrieval decisions can be explained. */
  recency: Fixed;
  relevance: Fixed;
  score: Fixed;
}

export interface RetrieveOptions {
  worldId: string;
  agentId: string;
  /** Embedding of the situation the agent is reacting to. */
  queryVector: readonly number[];
  tick: number;
  /** How many memories to return. */
  limit?: number;
  /**
   * How many rows to pull from the ANN index before exact re-ranking. Larger
   * values trade latency for recall, since the index is approximate.
   */
  candidates?: number;
  weights?: RetrievalWeights;
}

/**
 * CockroachDB accepts a vector literal in pgvector's textual form. Building it
 * here keeps the value a bound parameter rather than interpolated SQL.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Cosine distance is in [0, 2]: identical vectors are 0, opposite are 2.
 * Convert to a fixed-point similarity in [0, SCALE] so the rules never see a
 * float. Quantisation happens exactly here, at the boundary — nothing
 * downstream does floating-point arithmetic.
 */
export function relevanceFromDistance(distance: number): Fixed {
  const similarity = 1 - distance / 2;
  return clampUnit(Math.trunc(similarity * SCALE));
}

interface CandidateRow {
  memory_id: string;
  kind: string;
  content: string;
  importance: number;
  created_tick: number;
  subject_agent_id: string | null;
  claim_id: string | null;
  last_accessed_tick: number | null;
  distance: number;
}

/**
 * Fetch candidates from the ANN index, then re-rank them exactly.
 *
 * The split matters: the index is approximate and may return a slightly
 * different candidate set as it is rebuilt, but the *ordering* of whatever it
 * returns is computed deterministically here, with `memory_id` as the final
 * tie-break. Approximate recall therefore cannot leak nondeterminism into rule
 * outcomes.
 */
export async function retrieveMemories(
  client: Client,
  options: RetrieveOptions,
): Promise<RetrievedMemory[]> {
  const limit = options.limit ?? 8;
  const candidates = options.candidates ?? Math.max(limit * 6, 48);
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  // Candidates are drawn three ways, one per scoring component.
  //
  // Drawing only from the ANN index would make relevance a gatekeeper rather
  // than one term of three: a memory that matters enormously but shares no
  // vocabulary with the current situation could never be recalled, no matter
  // how high its importance weight. Taking the union means each component can
  // put a memory forward, and the exact re-rank below decides between them.
  const sideDraw = Math.max(limit * 2, 16);

  const result = await client.query<CandidateRow>(
    `
    WITH nearest AS (
      SELECT memory_id FROM world_memories
       WHERE world_id = $1 AND agent_id = $2
       ORDER BY embedding <=> $3
       LIMIT $4
    ),
    most_important AS (
      SELECT memory_id FROM world_memories
       WHERE world_id = $1 AND agent_id = $2
       ORDER BY importance DESC, memory_id
       LIMIT $5
    ),
    most_recent AS (
      SELECT memory_id FROM world_memories
       WHERE world_id = $1 AND agent_id = $2
       ORDER BY tick DESC, seq DESC
       LIMIT $5
    ),
    candidate AS (
      SELECT memory_id FROM nearest
      UNION SELECT memory_id FROM most_important
      UNION SELECT memory_id FROM most_recent
    )
    -- world_memories is append-only history, so its creation tick is the same
    -- "tick" column that carries the (tick, seq) total order.
    SELECT m.memory_id, m.kind, m.content, m.importance, m.tick AS created_tick,
           m.subject_agent_id, m.claim_id,
           m.embedding <=> $3 AS distance,
           (SELECT max(a.accessed_tick)
              FROM memory_accesses a
             WHERE a.world_id = $1 AND a.memory_id = m.memory_id) AS last_accessed_tick
      FROM candidate c
      JOIN world_memories m
        ON m.world_id = $1 AND m.memory_id = c.memory_id
     ORDER BY m.memory_id
    `,
    [
      options.worldId,
      options.agentId,
      toVectorLiteral(options.queryVector),
      candidates,
      sideDraw,
    ],
  );

  const scored = result.rows.map((row) => {
    // A memory never accessed since creation decays from when it was formed.
    const lastAccessedTick = row.last_accessed_tick ?? row.created_tick;
    const elapsed = Math.max(0, options.tick - lastAccessedTick);

    const recency = decayAt(MEMORY_RECENCY_DECAY, elapsed);
    const relevance = relevanceFromDistance(row.distance);
    const importance = clampUnit(row.importance);

    const score =
      fpMul(recency, weights.recency) +
      fpMul(importance, weights.importance) +
      fpMul(relevance, weights.relevance);

    return {
      memoryId: row.memory_id,
      kind: row.kind,
      content: row.content,
      importance,
      createdTick: row.created_tick,
      lastAccessedTick,
      subjectAgentId: row.subject_agent_id,
      claimId: row.claim_id,
      recency,
      relevance,
      score,
    } satisfies RetrievedMemory;
  });

  // Descending score, with memory_id breaking ties so equal scores order
  // identically on every machine and every run.
  scored.sort((a, b) =>
    b.score - a.score || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
  );

  return scored.slice(0, limit);
}

/**
 * Record that these memories were recalled.
 *
 * This is an append, not an update: world_memories is genuinely append-only, so
 * recency lives in its own table. Recording it separately also means a memory's
 * retrieval history is itself auditable.
 */
export async function recordAccesses(
  client: Client,
  worldId: string,
  memoryIds: readonly string[],
  tick: number,
): Promise<void> {
  if (memoryIds.length === 0) return;

  const params: unknown[] = [worldId, tick];
  const requested = memoryIds.map((id) => {
    params.push(id);
    return `($${params.length}::UUID)`;
  });

  // Rewind deliberately preserves cognition recordings but removes memories
  // created by external player conversations, which ticks do not replay. A
  // recorded decision may therefore name a valid memory from the live run that
  // is absent in the rebuilt projection. Join against the current memory set so
  // replay restores every access it can without failing on that expected gap.
  await client.query(
    `INSERT INTO memory_accesses (world_id, memory_id, accessed_tick)
     SELECT $1, requested.memory_id, $2
       FROM (VALUES ${requested.join(', ')}) AS requested(memory_id)
       JOIN world_memories memory
         ON memory.world_id = $1 AND memory.memory_id = requested.memory_id`,
    params,
  );
}

/** Retrieve and mark accessed, the combination cognition actually wants. */
export async function recall(
  client: Client,
  options: RetrieveOptions,
): Promise<RetrievedMemory[]> {
  const memories = await retrieveMemories(client, options);
  await recordAccesses(client, options.worldId, memories.map((m) => m.memoryId), options.tick);
  return memories;
}
