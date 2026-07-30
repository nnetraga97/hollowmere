-- Least-privilege web and scheduler role.
--
-- Applied by `npm run db:roles`, which safely substitutes the quoted database
-- identifier below. Scenario publication and schema migration use a separate
-- DDL-capable identity. The runtime can read published templates and mutate
-- only private-world state.

CREATE ROLE IF NOT EXISTS hollowmere_runtime LOGIN;

-- CockroachDB grants CREATE on the public schema to PUBLIC by default. Remove
-- that inherited privilege so a runtime or reader login cannot create tables.
-- Administrators and the explicit migrator retain their own grants.
REVOKE CREATE ON SCHEMA public FROM public;

REVOKE ALL ON DATABASE {{DATABASE_NAME}} FROM hollowmere_runtime;
REVOKE ALL ON SCHEMA public FROM hollowmere_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hollowmere_runtime;

GRANT CONNECT ON DATABASE {{DATABASE_NAME}} TO hollowmere_runtime;
GRANT USAGE ON SCHEMA public TO hollowmere_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hollowmere_runtime;

GRANT INSERT, UPDATE, DELETE ON TABLE
  worlds,
  world_successors,
  world_factions,
  world_locations,
  world_routes,
  world_agents,
  world_relationships,
  world_claims,
  agent_beliefs,
  world_state,
  world_faction_state,
  world_rumors,
  world_players,
  player_reputation,
  player_agent_relationships,
  player_romance_arcs,
  player_romance_flags,
  player_romance_events,
  world_agent_reflection_state,
  world_culprit,
  world_agent_goals,
  world_scheme_state,
  world_budget,
  world_conversation_sessions,
  world_conversation_participants,
  world_conversation_turns,
  world_events,
  world_memories,
  memory_accesses,
  memory_source_edges,
  player_agent_relationship_updates,
  world_inference_usage,
  belief_updates,
  world_rumor_spread,
  world_rumor_tellings,
  world_hearings,
  world_agent_commitments,
  world_player_evidence,
  world_state_history,
  trigger_firings,
  cognition_records,
  world_tick_commits,
  world_commands
TO hollowmere_runtime;

-- New tables are readable by default but never writable until their runtime
-- need is reviewed and added to the explicit list above.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO hollowmere_runtime;
