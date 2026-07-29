/**
 * Rewind a world to tick 0, keeping its identity.
 *
 * This is the missing half of replay. `cognition_records` is keyed on
 * `(world_id, tick, agent_id)`, so a recording can only be replayed by the world
 * that made it, by the agents that made it — which rules out re-instantiating
 * from the scenario, because that mints fresh UUIDs and every record is orphaned.
 * Equally, `runTick({ tick })` forces the tick *number* without restoring the
 * state that tick ran against, so replaying tick 6 of a world sitting at tick 200
 * re-runs spotlight selection against tick-200 state and asks for decisions
 * nobody recorded.
 *
 * So: reset in place. Identity rows — factions, locations, routes, agents,
 * claims, the player — keep their ids and are left alone. Everything the
 * simulation *wrote* is deleted or reset to its instantiated value, and the
 * opening event is seeded again. `cognition_records` is deliberately preserved:
 * it is the recording, and destroying it here would defeat the purpose.
 *
 * What makes this tractable is the schema's own discipline. History tables are
 * append-only, projections are rebuildable, and the initial values the rewind has
 * to restore are all derivable from rows the world already holds —
 * `world_agents.home_location_id` for position, faction membership for
 * relationships. Nothing here has to consult the scenario except the opening.
 */

import { withSerializable, type Client } from '../database/db.ts';
import { pickRumorOriginator, seedRumor } from '../social/gossip.ts';
import { createSeq } from '../core/seq.ts';

/**
 * Initial relationship values, mirroring `scenario/instantiate.ts`.
 *
 * Duplicated deliberately rather than imported: `instantiate.ts` builds these
 * from scenario rows in TypeScript, and a rewind rebuilds ~1,560 edges in one
 * statement from faction membership the world already stores. Importing the
 * constants is the part worth sharing; the loop is not.
 */
const INITIAL_SAME_FACTION = { sentiment: 3_000, trust: 6_500 };
const INITIAL_RIVAL_FACTION = { sentiment: -2_000, trust: 3_000 };
const INITIAL_NEUTRAL = { sentiment: 0, trust: 5_000 };

/**
 * Everything the simulation appends. Ordered so a child is removed before the
 * row it references — the FKs are composite and not all of them cascade.
 */
const HISTORY_TABLES = [
  'player_romance_events',
  'player_romance_flags',
  'player_romance_arcs',
  'world_player_evidence',
  'world_agent_commitments',
  'world_hearings',
  'world_rumor_tellings',
  // Conversation sessions and turns are recordings and survive rewind. Their
  // derived memories, relationship updates, and usage projections do not.
  'memory_source_edges',
  'player_agent_relationship_updates',
  'world_inference_usage',
  'memory_accesses',
  'world_memories',
  'belief_updates',
  'agent_beliefs',
  'world_rumor_spread',
  'world_rumors',
  'world_state_history',
  'trigger_firings',
  'world_tick_commits',
  'world_commands',
  'world_events',
] as const;

export interface RewindResult {
  worldId: string;
  /** The tick the world was at before being rewound, for logging. */
  fromTick: number;
  /** Cognition records preserved — what there is to replay. */
  recordsKept: number;
}

export async function rewindWorld(worldId: string): Promise<RewindResult> {
  const { value } = await withSerializable<RewindResult>(async (client) => {
    const world = await client.query<{ current_tick: number; scenario_version_id: string }>(
      `SELECT current_tick, scenario_version_id FROM worlds WHERE world_id = $1`,
      [worldId],
    );
    const row = world.rows[0];
    if (!row) throw new Error(`unknown world ${worldId}`);

    const kept = await client.query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM cognition_records WHERE world_id = $1`,
      [worldId],
    );

    for (const table of HISTORY_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE world_id = $1`, [worldId]);
    }

    await resetAgents(client, worldId);
    await resetInstigatorState(client, worldId);
    await resetRelationships(client, worldId);
    await resetProjections(client, worldId);
    await seedOpening(client, worldId, row.scenario_version_id);

    await client.query(
      `UPDATE worlds
          SET current_tick = 0, command_seq = 0, status = 'active', ending = NULL,
              active_runtime_ms = 0, lease_owner = NULL, lease_expires_at = NULL,
              time_debt_ticks = 0,
              last_activity_at = now()
        WHERE world_id = $1`,
      [worldId],
    );

    return {
      worldId,
      fromTick: row.current_tick,
      recordsKept: kept.rows[0]?.count ?? 0,
    };
  }, { label: 'rewindWorld' });

  return value;
}

async function resetInstigatorState(client: Client, worldId: string): Promise<void> {
  await client.query(
    `UPDATE world_scheme_state
        SET posture = 'press', ladder_index = 0, current_tactic = NULL,
            target_agent_id = NULL, claim_id = NULL, executes_until = 0,
            next_strategy_tick = 0, updated_tick = 0
      WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE world_agent_goals SET status = 'active', updated_tick = 0 WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE world_culprit SET exposed_tick = NULL WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE world_claims SET locked = true
      WHERE world_id = $1 AND claim_key = 'instigator_exposed'`,
    [worldId],
  );
}

/**
 * Agents go home and forget their plans.
 *
 * Status comes back from the persona, not from a blanket `'alive'` — the
 * scenario opens with a death, and the victim starts dead. Resurrecting them
 * changes who is present, who can be gossiped to, and therefore the entire run.
 * This matches `insertAgents`, which reads the same field.
 */
async function resetAgents(client: Client, worldId: string): Promise<void> {
  await client.query(
    `UPDATE world_agents
        SET location_id = home_location_id,
            status = COALESCE(persona->>'status', 'alive'),
            current_plan = NULL, current_action = NULL, updated_tick = 0
      WHERE world_id = $1`,
    [worldId],
  );
}

/**
 * Rebuild every relationship edge from faction membership, in one statement.
 *
 * The cross join is the same rule `instantiate.ts` applies in TypeScript: same
 * house warm, unaligned neutral, rival house cold.
 */
async function resetRelationships(client: Client, worldId: string): Promise<void> {
  await client.query(`DELETE FROM world_relationships WHERE world_id = $1`, [worldId]);
  await client.query(
    `INSERT INTO world_relationships (world_id, src_agent_id, dst_agent_id, sentiment, trust)
     SELECT $1, s.agent_id, d.agent_id,
            CASE WHEN sf.faction_key = df.faction_key THEN $2
                 WHEN sf.faction_key = 'unaligned' OR df.faction_key = 'unaligned' THEN $4
                 ELSE $6 END,
            CASE WHEN sf.faction_key = df.faction_key THEN $3
                 WHEN sf.faction_key = 'unaligned' OR df.faction_key = 'unaligned' THEN $5
                 ELSE $7 END
       FROM world_agents s
       JOIN world_agents d
         ON d.world_id = s.world_id AND d.agent_id != s.agent_id
       JOIN world_factions sf
         ON sf.world_id = s.world_id AND sf.faction_id = s.faction_id
       JOIN world_factions df
         ON df.world_id = d.world_id AND df.faction_id = d.faction_id
      WHERE s.world_id = $1`,
    [
      worldId,
      INITIAL_SAME_FACTION.sentiment, INITIAL_SAME_FACTION.trust,
      INITIAL_NEUTRAL.sentiment, INITIAL_NEUTRAL.trust,
      INITIAL_RIVAL_FACTION.sentiment, INITIAL_RIVAL_FACTION.trust,
    ],
  );
}

/** Tension, stage, faction state, reputation, and spend all go back to zero. */
async function resetProjections(client: Client, worldId: string): Promise<void> {
  await client.query(
    `UPDATE world_state
        SET global_tension = 0, escalation_stage = 'calm', peace_streak = 0,
            day = 0, phase = 'morning'
      WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE world_faction_state
        SET tension = 0, willing_to_negotiate = false, updated_tick = 0
      WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE world_budget
        SET inference_calls = 0, tokens_in = 0, tokens_out = 0, est_cost_micros = 0
      WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE player_reputation SET reputation = 0 WHERE world_id = $1`,
    [worldId],
  );
  await client.query(
    `UPDATE player_agent_relationships
        SET trust = 5000, affinity = 0, fear = 0, respect = 0,
            impression = NULL, updated_tick = 0
      WHERE world_id = $1`, [worldId],
  );
  await client.query(
    `UPDATE world_agent_reflection_state
        SET accumulated_importance = 0, last_reflection_tick = NULL
      WHERE world_id = $1`, [worldId],
  );
  await client.query(
    `INSERT INTO world_state_history (world_id, tick, global_tension, escalation_stage)
     VALUES ($1, 0, 0, 'calm')`,
    [worldId],
  );
}

interface OpeningSeed { claim: string; heat: number; valence: number }
interface OpeningDef {
  location: string;
  description: string;
  seedRumors: readonly OpeningSeed[];
}

/**
 * Re-seed the opening event and its rumors.
 *
 * The one part that consults the scenario, because the opening is authored data
 * rather than something the world stores. Ids are resolved from the world's own
 * rows by key, so the reseeded rumors attach to the same locations and claims
 * the recording used.
 */
async function seedOpening(
  client: Client,
  worldId: string,
  scenarioVersionId: string,
): Promise<void> {
  const version = await client.query<{ opening: OpeningDef }>(
    `SELECT opening FROM scenario_versions WHERE scenario_version_id = $1`,
    [scenarioVersionId],
  );
  const opening = version.rows[0]?.opening;
  if (!opening) return;

  const location = await client.query<{ location_id: string }>(
    `SELECT location_id FROM world_locations WHERE world_id = $1 AND location_key = $2`,
    [worldId, opening.location],
  );

  const event = await client.query<{ event_id: string }>(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, kind, payload, description)
     VALUES ($1, 0, 0, $2, 'escalation', '{"opening":true}', $3) RETURNING event_id`,
    [worldId, location.rows[0]?.location_id ?? null, opening.description],
  );
  const eventId = event.rows[0]!.event_id;

  const seq = createSeq(1);
  for (const [index, seed] of (opening.seedRumors ?? []).entries()) {
    const claim = await client.query<{ claim_id: string }>(
      `SELECT claim_id FROM world_claims WHERE world_id = $1 AND claim_key = $2`,
      [worldId, seed.claim],
    );
    const claimId = claim.rows[0]?.claim_id;
    if (!claimId) continue;

    // The same `pickRumorOriginator` instantiation uses, not a reimplementation
    // of it. Choosing the first tellers differently is enough to make the whole
    // town diverge — the rumor starts in a different corner and spreads along
    // different edges — and it is invisible until a replay refuses on inputs
    // that no longer match. Which is exactly how this was found.
    const originator = await pickRumorOriginator(client, worldId, claimId, index);
    if (!originator) continue;

    await seedRumor(client, {
      worldId,
      tick: 0,
      seq,
      claimId,
      originAgentId: originator.agentId,
      heat: seed.heat,
      valence: seed.valence,
      text: originator.claimText,
      originEventId: eventId,
    });
  }
}
