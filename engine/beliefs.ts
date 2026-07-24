/**
 * Belief: what each agent holds true, and how confidently.
 *
 * Memories record what an agent was told, in the wording they were told it.
 * Belief is the separate, structured question of whether they accept it. Two
 * agents can hold the same memory and believe opposite things about it, which
 * is the entire point of a town that splits into camps.
 *
 * `belief_updates` is append-only and is the source of truth; `agent_beliefs`
 * is a projection that exists so the common "what does X believe now" query is
 * a single row read. The projection is rebuildable, and a test asserts that a
 * rebuild reproduces it exactly — if that ever fails, the projection has been
 * updated somewhere without a corresponding history row.
 *
 * "What did X believe at tick T" is answered from this history, by tick. That
 * is deliberately not `AS OF SYSTEM TIME`: product history must survive garbage
 * collection and must be expressed in simulation time, not wall clock.
 */

import type { Client } from './db.ts';
import { BELIEF } from './config.ts';
import { SCALE, clampSigned, fpMul, type Fixed } from './fixedpoint.ts';

export type FactionAlignment = 'same' | 'rival' | 'unaligned';

/**
 * How willing this listener is to accept a claim about this subject.
 *
 * People defend their own and believe the worst of rivals. Without this
 * asymmetry an accusation would converge the whole town on one answer; with it,
 * the same accusation drives the two houses further apart.
 */
export function alignmentFactor(alignment: FactionAlignment): Fixed {
  switch (alignment) {
    case 'same': return BELIEF.alignmentSameFaction;
    case 'rival': return BELIEF.alignmentRivalFaction;
    case 'unaligned': return BELIEF.alignmentUnaligned;
  }
}

export interface ConfidenceShiftInput {
  /** Listener's current confidence in the claim, signed. */
  current: Fixed;
  /** Listener's general disposition to believe what they are told. */
  credulity: Fixed;
  /** Listener's trust in whoever told them. */
  trust: Fixed;
  /** How hot the rumor still is. */
  heat: Fixed;
  /** Listener's factional relationship to the claim's subject. */
  alignment: FactionAlignment;
}

/**
 * New confidence after hearing a claim once more.
 *
 * Shifts are proportional to remaining headroom, so confidence approaches
 * certainty asymptotically instead of saturating on the third retelling. That
 * matters for the demo: belief should visibly harden over many exchanges rather
 * than snapping to maximum immediately.
 */
export function shiftConfidence(input: ConfidenceShiftInput): Fixed {
  const receptiveness = fpMul(
    fpMul(input.credulity, input.trust),
    alignmentFactor(input.alignment),
  );
  const weighted = fpMul(receptiveness, input.heat);
  const capped = Math.min(weighted, BELIEF.maxShiftPerTransmission);

  // Remaining distance to certainty. A listener already at 0.9 moves less than
  // one at 0.1 from the same retelling.
  const headroom = SCALE - input.current;
  const delta = fpMul(capped, headroom);

  return clampSigned(input.current + delta);
}

export interface RecordBeliefInput {
  worldId: string;
  agentId: string;
  claimId: string;
  tick: number;
  seq: number;
  confidence: Fixed;
  causeEventId?: string | null;
}

/** Append a belief update and refresh the projection in the same statement pair. */
export async function recordBelief(
  client: Client,
  input: RecordBeliefInput,
): Promise<void> {
  await client.query(
    `INSERT INTO belief_updates
       (world_id, agent_id, claim_id, tick, seq, confidence, cause_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.worldId, input.agentId, input.claimId,
      input.tick, input.seq, input.confidence, input.causeEventId ?? null,
    ],
  );

  await client.query(
    `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (world_id, agent_id, claim_id)
     DO UPDATE SET confidence = excluded.confidence, updated_tick = excluded.updated_tick`,
    [input.worldId, input.agentId, input.claimId, input.confidence, input.tick],
  );
}

/** Current confidence, or 0 if the agent has never encountered the claim. */
export async function getBelief(
  client: Client,
  worldId: string,
  agentId: string,
  claimId: string,
): Promise<Fixed> {
  const result = await client.query<{ confidence: number }>(
    `SELECT confidence FROM agent_beliefs
      WHERE world_id = $1 AND agent_id = $2 AND claim_id = $3`,
    [worldId, agentId, claimId],
  );
  return result.rows[0]?.confidence ?? 0;
}

/**
 * What the agent believed as of a past tick.
 *
 * This is the product's time-travel: reconstructed from append-only history in
 * simulation time, so it stays answerable for the life of the world rather than
 * for the length of the database's garbage-collection window.
 */
export async function getBeliefAtTick(
  client: Client,
  worldId: string,
  agentId: string,
  claimId: string,
  tick: number,
): Promise<Fixed> {
  const result = await client.query<{ confidence: number }>(
    `SELECT confidence FROM belief_updates
      WHERE world_id = $1 AND agent_id = $2 AND claim_id = $3 AND tick <= $4
      ORDER BY tick DESC, seq DESC
      LIMIT 1`,
    [worldId, agentId, claimId, tick],
  );
  return result.rows[0]?.confidence ?? 0;
}

export interface BeliefHolder {
  agentId: string;
  agentKey: string;
  confidence: Fixed;
}

/** Everyone whose confidence in a claim is at least `minConfidence`. */
export async function getBelievers(
  client: Client,
  worldId: string,
  claimId: string,
  minConfidence: Fixed = BELIEF.actionableConfidence,
): Promise<BeliefHolder[]> {
  const result = await client.query<{
    agent_id: string; agent_key: string; confidence: number;
  }>(
    `SELECT b.agent_id, a.agent_key, b.confidence
       FROM agent_beliefs b
       JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
      WHERE b.world_id = $1 AND b.claim_id = $2 AND b.confidence >= $3
      ORDER BY b.confidence DESC, a.agent_key`,
    [worldId, claimId, minConfidence],
  );
  return result.rows.map((row) => ({
    agentId: row.agent_id,
    agentKey: row.agent_key,
    confidence: row.confidence,
  }));
}

/**
 * Rebuild `agent_beliefs` from `belief_updates`.
 *
 * Used by the acceptance test that asserts the projection matches its history.
 * A mismatch means something wrote the projection directly, which would make
 * replay and the belief inspector disagree with what actually happened.
 */
export async function rebuildBeliefProjection(
  client: Client,
  worldId: string,
): Promise<number> {
  await client.query(`DELETE FROM agent_beliefs WHERE world_id = $1`, [worldId]);

  const result = await client.query(
    `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
     SELECT DISTINCT ON (agent_id, claim_id)
            world_id, agent_id, claim_id, confidence, tick
       FROM belief_updates
      WHERE world_id = $1
      ORDER BY agent_id, claim_id, tick DESC, seq DESC`,
    [worldId],
  );
  return result.rowCount ?? 0;
}

/**
 * How far the town has been misled: average confidence in claims the engine
 * knows to be false. This is the headline number for the misinformation story,
 * and it is only meaningful because ground truth is recorded separately from
 * what anyone believes.
 */
export async function getMisinformationIndex(
  client: Client,
  worldId: string,
): Promise<{ falseClaimBelief: Fixed; trueClaimBelief: Fixed; unknownClaimBelief: Fixed }> {
  const result = await client.query<{ truth: string; avg_confidence: number }>(
    `SELECT c.truth, COALESCE(avg(b.confidence), 0)::INT8 AS avg_confidence
       FROM world_claims c
       LEFT JOIN agent_beliefs b
         ON b.world_id = c.world_id AND b.claim_id = c.claim_id
      WHERE c.world_id = $1
      GROUP BY c.truth
      ORDER BY c.truth`,
    [worldId],
  );

  const byTruth = new Map(result.rows.map((row) => [row.truth, row.avg_confidence]));
  return {
    falseClaimBelief: byTruth.get('false') ?? 0,
    trueClaimBelief: byTruth.get('true') ?? 0,
    unknownClaimBelief: byTruth.get('unknown') ?? 0,
  };
}
