/**
 * Tension and escalation.
 *
 * Tension is a single unsigned fixed-point number per world, plus one per
 * faction. It rises from what the town does to itself — cross-house
 * accusations, beliefs hardening, authored events — and bleeds off very slowly
 * on its own. The bleed is deliberately slower than the accrual: a town left
 * alone must get worse, or the whole premise ("left alone, it destroys itself")
 * is false.
 *
 * The stage is a pure function of tension in one direction only. Crossing a
 * threshold upward moves the stage; falling back below it does not move the
 * stage back. That asymmetry is the point: calming the town after accusations
 * have started does not un-say them, and it is what makes an intervention have
 * to be early rather than merely large.
 */

import type { Client } from './db.ts';
import { TENSION } from './config.ts';
import { TENSION_DECAY, decayAt } from './decay.ts';
import { clampUnit, fpMul, type Fixed } from './fixedpoint.ts';
import { ESCALATION_STAGES, type EscalationStage } from '../scenario/schema.ts';
import type { Seq } from './seq.ts';

export type { EscalationStage };

/** Position in the escalation order. Used for the monotonicity rule. */
export function stageIndex(stage: EscalationStage): number {
  const index = ESCALATION_STAGES.indexOf(stage);
  if (index < 0) throw new RangeError(`unknown escalation stage: ${stage}`);
  return index;
}

/** The stage this much tension would justify, ignoring history. */
export function stageForTension(tension: Fixed): EscalationStage {
  const t = TENSION.stageThresholds;
  if (tension >= t.war) return 'war';
  if (tension >= t.first_blood) return 'first_blood';
  if (tension >= t.trials) return 'trials';
  if (tension >= t.accusations) return 'accusations';
  if (tension >= t.suspicion) return 'suspicion';
  return 'calm';
}

/**
 * The later of two stages. Every stage write in the engine goes through this,
 * which is what makes "stages never reverse" a property of the code rather than
 * a convention every caller has to remember.
 */
export function maxStage(a: EscalationStage, b: EscalationStage): EscalationStage {
  return stageIndex(a) >= stageIndex(b) ? a : b;
}

/** One tick of natural cooling. */
export function decayTension(tension: Fixed): Fixed {
  return clampUnit(fpMul(tension, decayAt(TENSION_DECAY, 1)));
}

/**
 * Apply one tick's accrual on top of the decay.
 *
 * The per-tick rise is capped. Without a cap, a single very hot rumor reaching
 * thirty people in one tick moves the town from calm to war inside a minute,
 * which is both unreadable on screen and unfaithful — a town's mood does not
 * turn over in fifteen in-world minutes, however much is said.
 */
export function nextTension(current: Fixed, rise: Fixed): Fixed {
  const capped = Math.min(Math.max(0, rise), TENSION.maxRisePerTick);
  return clampUnit(decayTension(current) + capped);
}

export interface EscalationInput {
  worldId: string;
  tick: number;
  seq: Seq;
  /** Tension generated this tick, before capping. */
  globalRise: Fixed;
  /** Tension generated this tick against particular factions, by faction id. */
  factionRise?: ReadonlyMap<string, Fixed> | undefined;
  /**
   * A stage floor imposed from outside the tension curve — a hard trigger
   * (murder, armed attack) jumping straight to war. Never lowers the stage.
   */
  stageFloor?: EscalationStage | undefined;
}

export interface EscalationResult {
  globalTension: Fixed;
  previousTension: Fixed;
  stage: EscalationStage;
  previousStage: EscalationStage;
  stageChanged: boolean;
}

interface StateRow {
  global_tension: number;
  escalation_stage: EscalationStage;
}

/** What the town is told when it crosses a line. Displayed in the chronicle. */
const STAGE_ANNOUNCEMENTS: Record<EscalationStage, string> = {
  calm: 'The town goes about its business.',
  suspicion: 'People have begun to watch each other in the street.',
  accusations: 'Names are being said aloud now, and not kindly.',
  trials: 'The magistrate calls both Houses to answer before the town.',
  first_blood: 'Blood has been drawn. There is no unsaying it.',
  war: 'The Houses are at war. Hollowmere is lost.',
};

/**
 * Recompute tension, advance the stage if a threshold has been crossed, and
 * record both in history.
 *
 * Runs inside the tick transaction, after every rule step that generates
 * tension has reported what it produced.
 */
export async function applyEscalation(
  client: Client,
  input: EscalationInput,
): Promise<EscalationResult> {
  const state = await client.query<StateRow>(
    `SELECT global_tension, escalation_stage FROM world_state WHERE world_id = $1`,
    [input.worldId],
  );
  const current = state.rows[0];
  if (!current) throw new Error(`world ${input.worldId} has no world_state row`);

  const previousTension = current.global_tension;
  const previousStage = current.escalation_stage;

  const globalTension = nextTension(previousTension, input.globalRise);

  // Monotonic in both directions it can be pushed: by the tension curve, and by
  // a hard trigger. Neither can pull the stage back.
  let stage = maxStage(previousStage, stageForTension(globalTension));
  if (input.stageFloor) stage = maxStage(stage, input.stageFloor);
  const stageChanged = stage !== previousStage;

  await client.query(
    `UPDATE world_state SET global_tension = $2, escalation_stage = $3 WHERE world_id = $1`,
    [input.worldId, globalTension, stage],
  );

  await applyFactionTension(client, input);

  // One row per tick, so the tension curve is a plain read. Written as an upsert
  // because a tick may be re-applied after a serialization retry.
  await client.query(
    `INSERT INTO world_state_history (world_id, tick, global_tension, escalation_stage)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (world_id, tick)
     DO UPDATE SET global_tension = excluded.global_tension,
                   escalation_stage = excluded.escalation_stage`,
    [input.worldId, input.tick, globalTension, stage],
  );

  if (stageChanged) {
    await client.query(
      `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
       VALUES ($1, $2, $3, 'escalation', $4, $5)`,
      [
        input.worldId, input.tick, input.seq.next(),
        JSON.stringify({ from: previousStage, to: stage, tension: globalTension }),
        STAGE_ANNOUNCEMENTS[stage],
      ],
    );
  }

  return { globalTension, previousTension, stage, previousStage, stageChanged };
}

/**
 * Per-faction tension: how much heat is on each House specifically.
 *
 * This lives in its own table rather than JSONB on world_state because the peace
 * rules compare it every tick, and convention 9 forbids comparing on JSONB.
 */
async function applyFactionTension(
  client: Client,
  input: EscalationInput,
): Promise<void> {
  const rows = await client.query<{ faction_id: string; tension: number }>(
    `SELECT faction_id, tension FROM world_faction_state
      WHERE world_id = $1 ORDER BY faction_id`,
    [input.worldId],
  );

  for (const row of rows.rows) {
    const rise = input.factionRise?.get(row.faction_id) ?? 0;
    const next = nextTension(row.tension, rise);
    if (next === row.tension) continue;
    await client.query(
      `UPDATE world_faction_state SET tension = $3, updated_tick = $4
        WHERE world_id = $1 AND faction_id = $2`,
      [input.worldId, row.faction_id, next, input.tick],
    );
  }
}

export interface WorldStateSnapshot {
  globalTension: Fixed;
  stage: EscalationStage;
  peaceStreak: number;
  day: number;
  phase: string;
}

export async function readWorldState(
  client: Client,
  worldId: string,
): Promise<WorldStateSnapshot> {
  const result = await client.query<{
    global_tension: number; escalation_stage: EscalationStage;
    peace_streak: number; day: number; phase: string;
  }>(
    `SELECT global_tension, escalation_stage, peace_streak, day, phase
       FROM world_state WHERE world_id = $1`,
    [worldId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`world ${worldId} has no world_state row`);
  return {
    globalTension: row.global_tension,
    stage: row.escalation_stage,
    peaceStreak: row.peace_streak,
    day: row.day,
    phase: row.phase,
  };
}
