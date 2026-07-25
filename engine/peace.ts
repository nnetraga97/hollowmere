/**
 * Peace, and how a world ends.
 *
 * Peace is decided by rules and never by a model. Claude can move the inputs —
 * a persuasive conversation shifts sentiment, cools a rumor, brings a leader to
 * the table — but it cannot declare the outcome, and it is never asked to. That
 * separation is what makes the ending auditable: for any world that reached
 * peace, the exact tick each condition became true is in the history.
 *
 * The conditions must hold *continuously*. A single quiet minute in a town that
 * has been shouting for an hour is not peace, and treating it as such would let
 * the ending land on noise.
 */

import type { Client } from './db.ts';
import { TENSION } from './config.ts';
import type { Fixed } from './fixedpoint.ts';
import { stageIndex, type EscalationStage } from './tension.ts';
import type { Seq } from './seq.ts';

/**
 * After first blood the peace path is closed. The scripted reconciliation that
 * works at `trials` deliberately does nothing at `first_blood` — the point of
 * no return has to actually be a point of no return.
 */
const PEACE_CLOSED_FROM: EscalationStage = 'first_blood';

export interface PeaceConditions {
  /** Every belligerent faction's leader would accept terms. */
  leadersWilling: boolean;
  /** Global tension is below the peace threshold. */
  tensionLow: boolean;
  /** No hostile rumor is still hot enough to reignite things. */
  rumorsCool: boolean;
  /** The stage has not passed the point of no return. */
  stageOpen: boolean;
}

export interface PeaceEvaluation {
  conditions: PeaceConditions;
  /** All four conditions hold this tick. */
  met: boolean;
  /** Consecutive ticks the conditions have held, including this one. */
  streak: number;
  /** The streak has reached the required length. */
  declared: boolean;
  hottestHostileRumor: Fixed;
}

export function allConditionsMet(conditions: PeaceConditions): boolean {
  return (
    conditions.leadersWilling &&
    conditions.tensionLow &&
    conditions.rumorsCool &&
    conditions.stageOpen
  );
}

export interface PeaceInput {
  worldId: string;
  tick: number;
  seq: Seq;
  globalTension: Fixed;
  stage: EscalationStage;
  /** Streak carried in from world_state. */
  previousStreak: number;
}

/**
 * Evaluate the peace conditions for this tick and update the streak.
 *
 * Returns without ending the world; the caller decides what to do with a
 * declared peace, because ending a world is also how a war ends and both should
 * go through one place.
 */
export async function evaluatePeace(
  client: Client,
  input: PeaceInput,
): Promise<PeaceEvaluation> {
  const willing = await client.query<{ total: number; willing: number }>(
    `SELECT count(*)::INT8 AS total,
            count(*) FILTER (WHERE s.willing_to_negotiate)::INT8 AS willing
       FROM world_faction_state s
       JOIN world_factions f ON f.world_id = s.world_id AND f.faction_id = s.faction_id
      WHERE s.world_id = $1 AND f.belligerent`,
    [input.worldId],
  );
  const counts = willing.rows[0] ?? { total: 0, willing: 0 };

  const hottest = await client.query<{ heat: number }>(
    `SELECT COALESCE(max(heat), 0)::INT8 AS heat
       FROM world_rumors
      WHERE world_id = $1 AND valence < 0`,
    [input.worldId],
  );
  const hottestHostileRumor = hottest.rows[0]?.heat ?? 0;

  const conditions: PeaceConditions = {
    // A world with no belligerent factions cannot make peace between them.
    leadersWilling: counts.total > 0 && counts.willing === counts.total,
    tensionLow: input.globalTension < TENSION.peaceMaxTension,
    rumorsCool: hottestHostileRumor < TENSION.peaceMaxRumorHeat,
    stageOpen: stageIndex(input.stage) < stageIndex(PEACE_CLOSED_FROM),
  };

  const met = allConditionsMet(conditions);
  const streak = met ? input.previousStreak + 1 : 0;

  await client.query(
    `UPDATE world_state SET peace_streak = $2 WHERE world_id = $1`,
    [input.worldId, streak],
  );

  return {
    conditions,
    met,
    streak,
    declared: streak >= TENSION.peaceStreakRequired,
    hottestHostileRumor,
  };
}

export type Ending = 'war' | 'peace' | 'exposed' | 'expired';

const ENDING_DESCRIPTION: Record<Ending, string> = {
  war: 'The Houses take the streets. Hollowmere burns.',
  peace: 'Terms are agreed in the plaza. The Houses will speak again in a season.',
  exposed: 'The instigator is exposed before both Houses and taken into custody.',
  expired: 'The season turns and the town is left as it was found.',
};

/**
 * End a world.
 *
 * Idempotent: a world that has already ended keeps its first ending. Two
 * different endings arriving in the same tick (a peace declared while a hard
 * trigger fires) must resolve to one, and the earlier write wins rather than
 * the later one overwriting history.
 */
export async function endWorld(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq; ending: Ending },
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE worlds SET status = 'ended', ending = $2
      WHERE world_id = $1 AND status != 'ended'`,
    [input.worldId, input.ending],
  );
  if ((updated.rowCount ?? 0) === 0) return false;

  await client.query(
    `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
     VALUES ($1, $2, $3, 'escalation', $4, $5)`,
    [
      input.worldId, input.tick, input.seq.next(),
      JSON.stringify({ ending: input.ending }),
      ENDING_DESCRIPTION[input.ending],
    ],
  );
  return true;
}

/** Set whether a faction's leader would accept terms. Rules and triggers only. */
export async function setNegotiationWillingness(
  client: Client,
  input: { worldId: string; tick: number; factionId: string; willing: boolean },
): Promise<void> {
  await client.query(
    `UPDATE world_faction_state SET willing_to_negotiate = $3, updated_tick = $4
      WHERE world_id = $1 AND faction_id = $2`,
    [input.worldId, input.factionId, input.willing, input.tick],
  );
}
