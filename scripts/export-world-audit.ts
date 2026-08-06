/**
 * Read-only export for a single production Hollowmere world.
 *
 * Usage:
 *   PROD_DATABASE_URL=... node scripts/export-world-audit.ts 760347392 web/src/data/world-760347392.json
 *
 * The export deliberately never selects provider prompts, embeddings, hashes,
 * or connection metadata. Every query is scoped to the resolved world ID.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';

const [seed, outputPath] = process.argv.slice(2);
if (!seed || !outputPath) throw new Error('usage: export-world-audit <seed> <output-path>');
if (!process.env.PROD_DATABASE_URL) throw new Error('PROD_DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: process.env.PROD_DATABASE_URL,
  application_name: 'hollowmere-world-audit',
});

async function rows(text: string, values: readonly unknown[]) {
  return (await pool.query(text, values)).rows;
}

try {
  const [world] = await rows(
    `SELECT w.world_id, w.seed, w.status, w.current_tick, w.created_at, w.last_activity_at,
            w.inference_profile, w.active_runtime_ms, w.time_debt_ticks,
            s.day, s.phase, s.escalation_stage, s.global_tension, s.peace_streak,
            b.inference_calls, b.tokens_in, b.tokens_out, b.est_cost_micros
       FROM worlds w
       JOIN world_state s USING (world_id)
       LEFT JOIN world_budget b USING (world_id)
      WHERE w.seed = $1
      ORDER BY w.created_at DESC
      LIMIT 1`,
    [seed],
  );
  if (!world) throw new Error(`no world found for seed ${seed}`);
  const worldId = world.world_id as string;

  const [conversations, inference, ticks, stateHistory, events, agents, beliefs, memories,
    relationshipUpdates, usage, rumors] = await Promise.all([
    rows(
      `SELECT session.opened_tick, session.closed_tick, session.status AS session_status,
              session.turn_count, session.time_cost_ticks, session.relationship_impression,
              agent.agent_key, agent.name,
              turn.ordinal, turn.player_text, turn.reply, turn.speech_act, turn.status,
              turn.model_id, turn.prompt_version, turn.budget_tier, turn.tokens_in,
              turn.tokens_out, turn.latency_ms, turn.structured_outcome,
              command.payload->'effects' AS effects
         FROM world_conversation_turns turn
         JOIN world_conversation_sessions session
           ON session.world_id = turn.world_id AND session.conversation_id = turn.conversation_id
         JOIN world_agents agent
           ON agent.world_id = session.world_id AND agent.agent_id = session.target_agent_id
         LEFT JOIN world_commands command
           ON command.world_id = turn.world_id
          AND command.kind = 'conversation_turn'
          AND command.payload->>'turnId' = turn.turn_id::STRING
        WHERE turn.world_id = $1
        ORDER BY session.opened_tick, agent.agent_key, turn.ordinal`,
      [worldId],
    ),
    rows(
      `SELECT task, model_id, prompt_version, count(*)::INT8 AS calls,
              sum(tokens_in)::INT8 AS tokens_in, sum(tokens_out)::INT8 AS tokens_out,
              avg(latency_ms)::FLOAT8 AS avg_latency_ms, min(latency_ms)::INT8 AS min_latency_ms,
              max(latency_ms)::INT8 AS max_latency_ms
         FROM cognition_records
        WHERE world_id = $1
        GROUP BY task, model_id, prompt_version
        ORDER BY task, model_id, prompt_version`,
      [worldId],
    ),
    rows(
      `SELECT tick, duration_ms, retry_count, committed_at
         FROM world_tick_commits
        WHERE world_id = $1
        ORDER BY tick`,
      [worldId],
    ),
    rows(
      `SELECT tick, global_tension, escalation_stage
         FROM world_state_history
        WHERE world_id = $1
        ORDER BY tick`,
      [worldId],
    ),
    rows(
      `SELECT event.tick, event.seq, event.kind, event.description,
              actor.agent_key, event.payload
         FROM world_events event
         LEFT JOIN world_agents actor
           ON actor.world_id = event.world_id AND actor.agent_id = event.actor_agent_id
        WHERE event.world_id = $1
          AND event.kind != 'movement'
        ORDER BY event.tick, event.seq`,
      [worldId],
    ),
    rows(
      `SELECT agent.agent_key, agent.name, agent.status, faction.faction_key, location.location_key,
              agent.current_action, agent.updated_tick, agent.credulity, agent.talkativeness,
              agent.kindness, agent.engagement, agent.honesty
         FROM world_agents agent
         JOIN world_factions faction ON faction.world_id = agent.world_id AND faction.faction_id = agent.faction_id
         JOIN world_locations location ON location.world_id = agent.world_id AND location.location_id = agent.location_id
        WHERE agent.world_id = $1
        ORDER BY agent.agent_key`,
      [worldId],
    ),
    rows(
      `SELECT claim.claim_key, claim.text,
              sum(CASE WHEN belief.confidence > 0 THEN 1 ELSE 0 END)::INT8 AS believers,
              sum(CASE WHEN belief.confidence < 0 THEN 1 ELSE 0 END)::INT8 AS disbelievers,
              max(abs(belief.confidence))::INT8 AS strongest_confidence
         FROM agent_beliefs belief
         JOIN world_claims claim ON claim.world_id = belief.world_id AND claim.claim_id = belief.claim_id
        WHERE belief.world_id = $1
        GROUP BY claim.claim_key, claim.text
        ORDER BY believers DESC, disbelievers DESC, claim.claim_key`,
      [worldId],
    ),
    rows(
      `SELECT memory.kind, count(*)::INT8 AS count,
              coalesce(avg(memory.importance), 0)::FLOAT8 AS avg_importance
         FROM world_memories memory
        WHERE memory.world_id = $1
        GROUP BY memory.kind
        ORDER BY memory.kind`,
      [worldId],
    ),
    rows(
      `SELECT update.tick, agent.agent_key, update.trust_delta, update.affinity_delta,
              update.fear_delta, update.respect_delta, update.impression
         FROM player_agent_relationship_updates update
         JOIN world_agents agent ON agent.world_id = update.world_id AND agent.agent_id = update.agent_id
        WHERE update.world_id = $1
        ORDER BY update.tick, agent.agent_key`,
      [worldId],
    ),
    rows(
      `SELECT category, model_id, sum(calls)::INT8 AS calls, sum(tokens_in)::INT8 AS tokens_in,
              sum(tokens_out)::INT8 AS tokens_out, sum(est_cost_micros)::INT8 AS est_cost_micros
         FROM world_inference_usage
        WHERE world_id = $1
        GROUP BY category, model_id
        ORDER BY category, model_id`,
      [worldId],
    ),
    rows(
      `SELECT claim.claim_key, rumor.heat, rumor.created_tick, rumor.updated_tick,
              (SELECT count(*)::INT8 FROM world_rumor_spread spread
                WHERE spread.world_id = rumor.world_id AND spread.rumor_id = rumor.rumor_id) AS reached_agents,
              (SELECT count(*)::INT8 FROM world_rumor_tellings telling
                WHERE telling.world_id = rumor.world_id AND telling.rumor_id = rumor.rumor_id) AS tellings
         FROM world_rumors rumor
         JOIN world_claims claim ON claim.world_id = rumor.world_id AND claim.claim_id = rumor.claim_id
        WHERE rumor.world_id = $1
        ORDER BY reached_agents DESC, tellings DESC, claim.claim_key`,
      [worldId],
    ),
  ]);

  const [accessCounts] = await rows(
    `SELECT count(*)::INT8 AS accesses, count(DISTINCT memory_id)::INT8 AS accessed_memories
       FROM memory_accesses
      WHERE world_id = $1`,
    [worldId],
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(), world, conversations, inference, ticks, stateHistory,
    events, agents, beliefs, memories, memoryAccess: accessCounts, relationshipUpdates, usage, rumors,
  }, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
} finally {
  await pool.end();
}
