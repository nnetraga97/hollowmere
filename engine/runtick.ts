/**
 * One tick of Hollowmere.
 *
 * The tick is the whole simulation loop, and its shape is dictated by two hard
 * constraints rather than by taste:
 *
 *  - **Inference happens outside the transaction.** A model call inside a
 *    retryable transaction would be re-billed on every serialization retry, and
 *    could duplicate output that had already been streamed to a player. So the
 *    tick thinks first, with nothing open, and then commits what it decided.
 *  - **A tick either applies once or not at all.** `world_tick_commits` carries
 *    `PRIMARY KEY (world_id, tick)`, and claiming that row is the first thing
 *    the transaction does. Two schedulers racing the same world is therefore
 *    safe by construction: the loser commits nothing, rather than applying a
 *    second copy of the tick's effects.
 *
 * Everything between those two points is integer rule logic reading and writing
 * one world's rows.
 */

import { withClient, withSerializable, type Client } from './db.ts';
import { COGNITION, TIME } from './config.ts';
import { runAccusations } from './accusations.ts';
import { applyCognition, selectSpotlight, think, type CognitionDecision } from './cognition.ts';
import { runGossip } from './gossip.ts';
import { applyDialogue, thinkDialogue, type DialogueDecision } from './dialogue.ts';
import { evaluateExposureEnding } from './exposure.ts';
import { runHearings } from './hearings.ts';
import { loadRouteGraph, phaseForTick, dayForTick, runMovement } from './movement.ts';
import { endWorld, evaluatePeace, type Ending, type PeaceEvaluation } from './peace.ts';
import { createSeq } from './seq.ts';
import { tickRng } from './rng.ts';
import { applyStrategy, thinkStrategy, type SchemeDecision } from './schemes.ts';
import {
  applyEscalation, readWorldState, type EscalationStage,
} from './tension.ts';
import { loadTriggerFacts, loadTriggerKeyMaps, runTriggers } from './triggers.ts';
import { clampUnit, type Fixed } from './fixedpoint.ts';
import type { InferenceClient } from './inference/index.ts';
import { hasConversationHold } from './conversation.ts';

export type SkipReason =
  | 'not_active'
  | 'already_committed'
  | 'conversation_held'
  | 'tick_ceiling';

export interface TickReport {
  worldId: string;
  tick: number;
  committed: boolean;
  skipped: SkipReason | null;
  stage: EscalationStage;
  previousStage: EscalationStage;
  globalTension: Fixed;
  transmissions: number;
  distortions: number;
  accusations: number;
  movements: number;
  thinkers: number;
  dialogues: number;
  hearings: number;
  firedTriggers: string[];
  peace: PeaceEvaluation | null;
  ending: Ending | null;
  durationMs: number;
  retries: number;
}

export interface RunTickOptions {
  worldId: string;
  inference: InferenceClient;
  /** @deprecated Distortion is disabled until it becomes persisted world configuration. */
  allowDistortion?: boolean;
  /** Re-run a recorded world from cognition_records, with no model calls. */
  replay?: boolean;
  /** Force the tick number, for tests that need to re-run a specific tick. */
  tick?: number;
  /** An extra tick charged by a completed player conversation. */
  debtTick?: boolean;
}

interface WorldRow {
  current_tick: number;
  status: string;
  seed: number;
  player_location_id: string | null;
}

export async function runTick(options: RunTickOptions): Promise<TickReport> {
  const started = Date.now();

  if (await hasConversationHold(options.worldId)) {
    const state = await withClient((client) => readWorldState(client, options.worldId));
    const world = await withClient((client) => client.query<{ current_tick: number }>(
      `SELECT current_tick FROM worlds WHERE world_id = $1`, [options.worldId],
    ));
    return emptyReport(options.worldId, (world.rows[0]?.current_tick ?? 0) + 1,
      state.stage, state.globalTension, 'conversation_held', Date.now() - started);
  }

  // ---------------------------------------------------------------------
  // Phase 1 — read and think. No transaction is open here, and none may be.
  // ---------------------------------------------------------------------
  const prepared = await withClient(async (client) => {
    const world = await client.query<WorldRow>(
      `SELECT w.current_tick, w.status, w.seed,
              (SELECT p.location_id FROM world_players p
                WHERE p.world_id = w.world_id ORDER BY p.player_id LIMIT 1)
                AS player_location_id
         FROM worlds w WHERE w.world_id = $1`,
      [options.worldId],
    );
    const row = world.rows[0];
    if (!row) throw new Error(`unknown world ${options.worldId}`);

    const tick = options.tick ?? row.current_tick + 1;
    const state = await readWorldState(client, options.worldId);
    const graph = await loadRouteGraph(client, options.worldId);

    if (row.status !== 'active') {
      return { tick, seed: row.seed, state, graph,
               decisions: [] as CognitionDecision[], scheme: null as SchemeDecision | null,
               dialogue: null as DialogueDecision | null, blocked: 'not_active' as const };
    }
    if (tick > TIME.maxTicks) {
      return { tick, seed: row.seed, state, graph,
               decisions: [] as CognitionDecision[], scheme: null as SchemeDecision | null,
               dialogue: null as DialogueDecision | null, blocked: 'tick_ceiling' as const };
    }

    // Cognition runs on its own, slower cadence: thinking is the only part of
    // the tick that costs money, and a town does not need thirty people
    // reconsidering their lives every five seconds.
    let decisions: CognitionDecision[] = [];
    if (tick % COGNITION.intervalTicks === 0) {
      const spotlight = await selectSpotlight(client, {
        worldId: options.worldId,
        tick,
        playerLocationId: row.player_location_id,
        // A burst is allowed when the town has just been shaken; the stage is
        // the cheapest available proxy for "something is happening".
        allowBurst: state.stage === 'first_blood' || state.stage === 'war',
      });
      decisions = await think(
        client,
        {
          worldId: options.worldId,
          tick,
          rng: tickRng(row.seed, tick, 'cognition'),
          stage: state.stage,
          graph,
          inference: options.inference,
          replay: options.replay,
        },
        spotlight,
      );
    }

    const scheme = await thinkStrategy(client, {
      worldId: options.worldId,
      tick,
      seed: row.seed,
      rng: tickRng(row.seed, tick, 'scheme'),
      graph,
      stage: state.stage,
      globalTension: state.globalTension,
      peaceStreak: state.peaceStreak,
      inference: options.inference,
      ...(options.replay === undefined ? {} : { replay: options.replay }),
    });
    const dialogue = await thinkDialogue(client, {
      worldId: options.worldId,
      tick,
      rng: tickRng(row.seed, tick, 'dialogue'),
      inference: options.inference,
      ...(options.replay === undefined ? {} : { replay: options.replay }),
    });

    return { tick, seed: row.seed, state, graph, decisions, scheme, dialogue, blocked: null };
  });

  const { tick, seed, graph, decisions, scheme, dialogue } = prepared;

  if (prepared.blocked) {
    return emptyReport(options.worldId, tick, prepared.state.stage,
      prepared.state.globalTension, prepared.blocked, Date.now() - started);
  }

  // ---------------------------------------------------------------------
  // Phase 2 — commit. Database work only; every model call is already done.
  // ---------------------------------------------------------------------
  const outcome = await withSerializable(async (client) => {
    const seq = createSeq(0);

    // The partial unique index is the durable hold; this lock makes the
    // scheduler and conversation start serialize on the same world row.
    const locked = await client.query<{ time_debt_ticks: number }>(
      `SELECT time_debt_ticks FROM worlds WHERE world_id = $1 FOR UPDATE`,
      [options.worldId],
    );
    if (!locked.rows[0]) throw new Error(`unknown world ${options.worldId}`);
    const held = await client.query(
      `SELECT 1 FROM world_conversation_sessions
        WHERE world_id = $1 AND status IN ('open', 'closing') LIMIT 1`,
      [options.worldId],
    );
    if (held.rowCount) return null;
    if (options.debtTick && locked.rows[0].time_debt_ticks <= 0) return null;

    // Claiming the tick is the first statement, so a racing scheduler that
    // loses does no work at all rather than doing it and discarding it.
    const claimed = await client.query<{ tick: number }>(
      `INSERT INTO world_tick_commits (world_id, tick) VALUES ($1, $2)
       ON CONFLICT (world_id, tick) DO NOTHING
       RETURNING tick`,
      [options.worldId, tick],
    );
    if (claimed.rows.length === 0) {
      return null;
    }

    const phase = phaseForTick(tick);
    await client.query(
      `UPDATE world_state SET phase = $2, day = $3 WHERE world_id = $1`,
      [options.worldId, phase, dayForTick(tick)],
    );
    await client.query(
      `UPDATE worlds SET current_tick = $2, last_activity_at = now(),
              time_debt_ticks = time_debt_ticks - $3
        WHERE world_id = $1`,
      [options.worldId, tick, options.debtTick ? 1 : 0],
    );

    const commands = await applyPendingCommands(client, options.worldId, tick);

    const state = await readWorldState(client, options.worldId);

    // --- rules, in the order the plan fixes them ---
    const gossip = await runGossip(client, {
      worldId: options.worldId,
      tick,
      rng: tickRng(seed, tick, 'gossip'),
      seq,
      inference: options.inference,
      // Tick-level distortion is disabled until it is a persisted world
      // setting. A per-call flag is not replayable configuration. The
      // deterministic distortion rule remains directly testable in gossip.
      allowDistortion: false,
    });

    const accusations = await runAccusations(client, {
      worldId: options.worldId,
      tick,
      seq,
      rng: tickRng(seed, tick, 'accusation'),
      stage: state.stage,
    });

    const cognition = await applyCognition(client, { worldId: options.worldId, tick, seq }, decisions);
    await applyStrategy(client, { worldId: options.worldId, tick, seq, decision: scheme });
    const dialogues = await applyDialogue(client, {
      worldId: options.worldId, tick, seq, decision: dialogue,
    });

    const movements = await runMovement(client, {
      worldId: options.worldId, tick, seq, phase, graph,
    });
    const hearings = await runHearings(client, { worldId: options.worldId, tick, seq });

    // Triggers see the world as it stood before this tick's escalation, so that
    // every trigger in a tick evaluates against the same numbers regardless of
    // the order they fire in.
    const facts = await loadTriggerFacts(client, {
      worldId: options.worldId,
      tick,
      globalTension: state.globalTension,
      stage: state.stage,
      peaceStreak: state.peaceStreak,
    });
    const keyMaps = await loadTriggerKeyMaps(client, options.worldId);
    const triggers = await runTriggers(client, {
      worldId: options.worldId, tick, seq, facts,
      factionIds: keyMaps.factionIds, claimIds: keyMaps.claimIds,
    });

    const factionRise = mergeDeltas([
      gossip.factionDelta, accusations.factionDelta,
      cognition.factionDelta, triggers.factionRise,
    ]);

    const escalation = await applyEscalation(client, {
      worldId: options.worldId,
      tick,
      seq,
      globalRise: clampUnit(
        gossip.tensionDelta + accusations.tensionDelta +
        cognition.tensionDelta + hearings.tensionDelta + triggers.globalRise,
      ),
      factionRise,
      stageFloor: triggers.stageFloor ?? undefined,
    });

    const peace = await evaluatePeace(client, {
      worldId: options.worldId,
      tick,
      seq,
      globalTension: escalation.globalTension,
      stage: escalation.stage,
      previousStreak: state.peaceStreak,
    });

    // War is an outcome of the stage, peace of a sustained streak, and a
    // trigger may demand either outright. They are resolved in that order, and
    // endWorld itself is idempotent, so a tick that produces two endings still
    // records exactly one.
    let ending: Ending | null = null;
    if (escalation.stage === 'war') ending = 'war';
    else if (peace.declared) ending = 'peace';
    else if (triggers.ending) ending = triggers.ending;
    else if (await evaluateExposureEnding(client, {
      worldId: options.worldId, tick, seq,
    })) ending = 'exposed';
    if (ending && ending !== 'exposed') {
      const first = await endWorld(client, { worldId: options.worldId, tick, seq, ending });
      if (!first) ending = null;
    }

    return {
      commands,
      gossip,
      accusations,
      cognition,
      dialogues,
      movements,
      hearings,
      triggers,
      escalation,
      peace,
      ending,
    };
  }, { label: `runTick(${options.worldId}#${tick})` });

  const durationMs = Date.now() - started;

  if (!outcome.value) {
    const held = await hasConversationHold(options.worldId);
    return emptyReport(options.worldId, tick, prepared.state.stage,
      prepared.state.globalTension, held ? 'conversation_held' : 'already_committed', durationMs);
  }

  const result = outcome.value;

  // Recorded after the fact rather than inside the transaction: the duration of
  // a transaction is not knowable from within it, and the retry count is a
  // property of the attempt sequence, not of the successful attempt.
  await withClient(async (client) => {
    await client.query(
      `UPDATE world_tick_commits SET duration_ms = $3, retry_count = $4
        WHERE world_id = $1 AND tick = $2`,
      [options.worldId, tick, durationMs, outcome.retries],
    );
  });

  return {
    worldId: options.worldId,
    tick,
    committed: true,
    skipped: null,
    stage: result.escalation.stage,
    previousStage: result.escalation.previousStage,
    globalTension: result.escalation.globalTension,
    transmissions: result.gossip.transmissions.length,
    distortions: result.gossip.distortions,
    accusations: result.accusations.accusations.length + result.cognition.accusations,
    movements: result.movements.length,
    thinkers: result.cognition.records,
    dialogues: result.dialogues,
    hearings: result.hearings.resolved,
    firedTriggers: result.triggers.fired,
    peace: result.peace,
    ending: result.ending,
    durationMs,
    retries: outcome.retries,
  };
}

function mergeDeltas(deltas: readonly ReadonlyMap<string, Fixed>[]): Map<string, Fixed> {
  const merged = new Map<string, Fixed>();
  for (const delta of deltas) {
    for (const [factionId, amount] of delta) {
      merged.set(factionId, clampUnit((merged.get(factionId) ?? 0) + amount));
    }
  }
  return merged;
}

function emptyReport(
  worldId: string, tick: number, stage: EscalationStage, tension: Fixed,
  skipped: SkipReason, durationMs: number,
): TickReport {
  return {
    worldId, tick, committed: false, skipped,
    stage, previousStage: stage, globalTension: tension,
    transmissions: 0, distortions: 0, accusations: 0, movements: 0, thinkers: 0,
    dialogues: 0, hearings: 0,
    firedTriggers: [], peace: null, ending: null, durationMs, retries: 0,
  };
}

/**
 * Apply commands that arrived since the last tick.
 *
 * Conversation effects are applied by `converse` itself, at the moment the
 * player speaks — waiting for the next tick would make the town feel deaf.
 * What is left here is the state a tick is the right place to change.
 */
async function applyPendingCommands(
  client: Client,
  worldId: string,
  tick: number,
): Promise<number> {
  const pending = await client.query<{
    command_id: string; kind: string; payload: Record<string, unknown>;
  }>(
    `SELECT command_id, kind, payload FROM world_commands
      WHERE world_id = $1 AND applied_tick IS NULL
      ORDER BY command_seq`,
    [worldId],
  );

  for (const command of pending.rows) {
    switch (command.kind) {
      case 'move_player': {
        const locationKey = command.payload.locationKey;
        if (typeof locationKey === 'string') {
          await client.query(
            `UPDATE world_players p
                SET location_id = l.location_id
               FROM world_locations l, world_routes r
              WHERE p.world_id = $1 AND l.world_id = $1 AND l.location_key = $2
                AND p.player_id = $3
                AND r.world_id = p.world_id
                AND r.from_location_id = p.location_id
                AND r.to_location_id = l.location_id`,
            [worldId, locationKey, command.payload.playerId ?? null],
          );
        }
        break;
      }
      case 'set_time_scale': {
        const scale = command.payload.timeScale;
        if (typeof scale === 'number' && Number.isInteger(scale) && scale > 0) {
          await client.query(
            `UPDATE worlds SET time_scale = $2 WHERE world_id = $1`,
            [worldId, scale],
          );
        }
        break;
      }
      // 'converse' is applied when it is spoken; 'restart' is handled by the
      // world lifecycle, not by a running tick. Both are simply marked applied.
      default:
        break;
    }

    await client.query(
      `UPDATE world_commands SET applied_tick = $3
        WHERE world_id = $1 AND command_id = $2`,
      [worldId, command.command_id, tick],
    );
  }

  return pending.rows.length;
}
