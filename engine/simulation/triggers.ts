/**
 * Authored triggers.
 *
 * A trigger is a condition over the world's numbers and an ordered list of
 * effects. Both come from scenario JSON, which is authored content but is still
 * treated as untrusted input: conditions are matched against a closed grammar
 * of facts and comparisons, and effects against a fixed verb set. Nothing here
 * evaluates a string as code, builds SQL from scenario data, or reaches any
 * capability the engine does not already have.
 *
 * This is also where the "hard trigger" rule lives. A murder does not raise
 * tension and hope it crosses a threshold — it sets the stage to war outright,
 * from wherever the town happened to be. Some events are not survivable by
 * degree.
 */

import type { Client } from '../database/db.ts';
import { clampSigned, clampUnit, type Fixed } from '../core/fixedpoint.ts';
import { seedRumor, pickRumorOriginator } from '../social/gossip.ts';
import { setNegotiationWillingness, type Ending } from './peace.ts';
import { maxStage, stageIndex, type EscalationStage } from './tension.ts';
import type { Seq } from '../core/seq.ts';
import type {
  Condition,
  ConditionOp,
  Effect,
  LeafCondition,
} from '../../scenario/schema.ts';

/**
 * Everything a condition may look at. Assembled once per tick: a trigger must
 * see the same world every other trigger in the same tick sees, or firing order
 * would silently change outcomes.
 */
export interface TriggerFacts {
  tick: number;
  globalTension: Fixed;
  stage: EscalationStage;
  peaceStreak: number;
  maxRumorHeat: Fixed;
  /** By faction key. */
  factionTension: ReadonlyMap<string, Fixed>;
  /** By agent key. */
  agentStatus: ReadonlyMap<string, string>;
}

export interface TriggerOutcome {
  /** Keys that fired this tick, in firing order. */
  fired: string[];
  /** Tension the triggers added, for the escalation step to apply. */
  globalRise: Fixed;
  factionRise: Map<string, Fixed>;
  /** A stage the world must be at least at. Hard triggers set this to `war`. */
  stageFloor: EscalationStage | null;
  /** A trigger demanded the world end. */
  ending: Ending | null;
}

export interface TriggerContext {
  worldId: string;
  tick: number;
  seq: Seq;
  facts: TriggerFacts;
  /** faction_key -> faction_id, for effects that name a faction. */
  factionIds: ReadonlyMap<string, string>;
  /** claim_key -> claim_id, for seed_rumor. */
  claimIds: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function compare(left: number | string, op: ConditionOp, right: number | string): boolean {
  // Stage comparisons are ordered by escalation, not alphabetically: "trials"
  // must be greater than "accusations", which string comparison gets backwards.
  switch (op) {
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'lt': return left < right;
    case 'lte': return left <= right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
  }
}

function leafValue(
  condition: LeafCondition,
  facts: TriggerFacts,
): { actual: number | string; expected: number | string } | null {
  switch (condition.fact) {
    case 'tick':
      return { actual: facts.tick, expected: condition.value };
    case 'global_tension':
      return { actual: facts.globalTension, expected: condition.value };
    case 'peace_streak':
      return { actual: facts.peaceStreak, expected: condition.value };
    case 'max_rumor_heat':
      return { actual: facts.maxRumorHeat, expected: condition.value };
    case 'stage':
      return {
        actual: stageIndex(facts.stage),
        expected: stageIndex(condition.value as EscalationStage),
      };
    case 'faction_tension': {
      const tension = facts.factionTension.get(condition.faction ?? '');
      // A condition naming a faction this world does not have is false, not an
      // error: worlds outlive the scenario edits that introduced them.
      if (tension === undefined) return null;
      return { actual: tension, expected: condition.value };
    }
    case 'agent_status': {
      const status = facts.agentStatus.get(condition.agent ?? '');
      if (status === undefined) return null;
      return { actual: status, expected: condition.value };
    }
  }
}

/** Evaluate a validated condition tree. Pure, and tested without a database. */
export function evaluateCondition(condition: Condition, facts: TriggerFacts): boolean {
  if ('all' in condition) {
    return condition.all.every((child) => evaluateCondition(child, facts));
  }
  if ('any' in condition) {
    return condition.any.some((child) => evaluateCondition(child, facts));
  }
  if ('not' in condition) {
    return !evaluateCondition(condition.not, facts);
  }

  const resolved = leafValue(condition, facts);
  if (resolved === null) return false;
  return compare(resolved.actual, condition.op, resolved.expected);
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

interface TriggerRow {
  trigger_key: string;
  condition: Condition;
  effect: { effects: readonly Effect[] };
  priority: number;
  once: boolean;
  fired_tick: number | null;
}

/**
 * Evaluate every trigger for this world and apply the effects of those whose
 * condition holds.
 *
 * Order is `(priority DESC, trigger_key)` — explicit and total, because two
 * triggers that both fire in one tick can write the same rows, and a run must
 * not depend on which the database happened to return first.
 */
export async function runTriggers(
  client: Client,
  ctx: TriggerContext,
): Promise<TriggerOutcome> {
  const outcome: TriggerOutcome = {
    fired: [],
    globalRise: 0,
    factionRise: new Map(),
    stageFloor: null,
    ending: null,
  };

  const triggers = await client.query<TriggerRow>(
    `SELECT t.trigger_key, t.condition, t.effect, t.priority, t.once, f.fired_tick
       FROM trigger_templates t
       JOIN worlds w ON w.scenario_version_id = t.scenario_version_id
       LEFT JOIN trigger_firings f
              ON f.world_id = w.world_id AND f.trigger_key = t.trigger_key
      WHERE w.world_id = $1
      ORDER BY t.priority DESC, t.trigger_key`,
    [ctx.worldId],
  );

  for (const trigger of triggers.rows) {
    if (trigger.once && trigger.fired_tick !== null) continue;
    if (!evaluateCondition(trigger.condition, ctx.facts)) continue;

    // Recorded before the effects run: a `once` trigger whose effects fail
    // should still not be retried forever, and the row is the firing record the
    // chronicle reads.
    await client.query(
      `INSERT INTO trigger_firings (world_id, trigger_key, fired_tick)
       VALUES ($1, $2, $3)
       ON CONFLICT (world_id, trigger_key) DO UPDATE SET fired_tick = excluded.fired_tick`,
      [ctx.worldId, trigger.trigger_key, ctx.tick],
    );

    for (const effect of trigger.effect.effects) {
      await applyEffect(client, ctx, trigger.trigger_key, effect, outcome);
    }
    outcome.fired.push(trigger.trigger_key);
  }

  return outcome;
}

async function applyEffect(
  client: Client,
  ctx: TriggerContext,
  triggerKey: string,
  effect: Effect,
  outcome: TriggerOutcome,
): Promise<void> {
  switch (effect.verb) {
    case 'set_stage':
      // Collected rather than written: the escalation step owns the stage, so
      // that "never reverses" is enforced in exactly one place.
      outcome.stageFloor = outcome.stageFloor
        ? maxStage(outcome.stageFloor, effect.stage as EscalationStage)
        : (effect.stage as EscalationStage);
      break;

    case 'add_global_tension':
      outcome.globalRise = clampUnit(outcome.globalRise + (effect.amount ?? 0));
      break;

    case 'add_faction_tension': {
      const factionId = ctx.factionIds.get(effect.faction ?? '');
      if (!factionId) break;
      const current = outcome.factionRise.get(factionId) ?? 0;
      outcome.factionRise.set(factionId, clampUnit(current + (effect.amount ?? 0)));
      break;
    }

    case 'emit_event':
      await client.query(
        `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
         VALUES ($1, $2, $3, 'trigger', $4, $5)`,
        [
          ctx.worldId, ctx.tick, ctx.seq.next(),
          JSON.stringify({ trigger: triggerKey }),
          effect.description ?? triggerKey,
        ],
      );
      break;

    case 'seed_rumor': {
      const claimId = ctx.claimIds.get(effect.claim ?? '');
      if (!claimId) break;
      const originator = await pickRumorOriginator(client, ctx.worldId, claimId);
      // A rumor nobody holds cannot spread, so a world with no eligible teller
      // simply does not get this rumor rather than getting an inert one.
      if (!originator) break;
      await seedRumor(client, {
        worldId: ctx.worldId,
        tick: ctx.tick,
        seq: ctx.seq,
        claimId,
        originAgentId: originator.agentId,
        heat: clampUnit(effect.heat ?? 0),
        valence: clampSigned(effect.valence ?? 0),
        text: originator.claimText,
      });
      break;
    }

    case 'set_negotiation': {
      const factionId = ctx.factionIds.get(effect.faction ?? '');
      if (!factionId) break;
      await setNegotiationWillingness(client, {
        worldId: ctx.worldId,
        tick: ctx.tick,
        factionId,
        willing: effect.willing ?? false,
      });
      break;
    }

    case 'end_world':
      outcome.ending = (effect.ending ?? 'war') as Ending;
      break;
  }
}

/**
 * Assemble the fact snapshot. One query set per tick, shared by every trigger.
 */
export async function loadTriggerFacts(
  client: Client,
  input: {
    worldId: string;
    tick: number;
    globalTension: Fixed;
    stage: EscalationStage;
    peaceStreak: number;
  },
): Promise<TriggerFacts> {
  const factions = await client.query<{ faction_key: string; tension: number }>(
    `SELECT f.faction_key, s.tension
       FROM world_faction_state s
       JOIN world_factions f ON f.world_id = s.world_id AND f.faction_id = s.faction_id
      WHERE s.world_id = $1
      ORDER BY f.faction_key`,
    [input.worldId],
  );

  const agents = await client.query<{ agent_key: string; status: string }>(
    `SELECT agent_key, status FROM world_agents WHERE world_id = $1 ORDER BY agent_key`,
    [input.worldId],
  );

  const heat = await client.query<{ heat: number }>(
    `SELECT COALESCE(max(heat), 0)::INT8 AS heat FROM world_rumors WHERE world_id = $1`,
    [input.worldId],
  );

  return {
    tick: input.tick,
    globalTension: input.globalTension,
    stage: input.stage,
    peaceStreak: input.peaceStreak,
    maxRumorHeat: heat.rows[0]?.heat ?? 0,
    factionTension: new Map(factions.rows.map((r) => [r.faction_key, r.tension])),
    agentStatus: new Map(agents.rows.map((r) => [r.agent_key, r.status])),
  };
}

/** Key → id maps the effect verbs need. Loaded once per tick alongside the facts. */
export async function loadTriggerKeyMaps(
  client: Client,
  worldId: string,
): Promise<{ factionIds: Map<string, string>; claimIds: Map<string, string> }> {
  const factions = await client.query<{ faction_key: string; faction_id: string }>(
    `SELECT faction_key, faction_id FROM world_factions WHERE world_id = $1
      ORDER BY faction_key`,
    [worldId],
  );
  const claims = await client.query<{ claim_key: string; claim_id: string }>(
    `SELECT claim_key, claim_id FROM world_claims WHERE world_id = $1 ORDER BY claim_key`,
    [worldId],
  );
  return {
    factionIds: new Map(factions.rows.map((r) => [r.faction_key, r.faction_id])),
    claimIds: new Map(claims.rows.map((r) => [r.claim_key, r.claim_id])),
  };
}
