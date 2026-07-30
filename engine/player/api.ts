/**
 * Read models.
 *
 * Everything that looks at a world — the REPL, the debug dashboard, later the
 * game client and the read-only Town Investigator — goes through here rather
 * than writing its own SQL. Two reasons: the queries are the interesting part
 * of the submission and belong somewhere they can be read, and every one of
 * them must be world-scoped. A read model that forgets its `world_id` predicate
 * is the one way isolation could leak, so there is exactly one place to check.
 *
 * Every function here is read-only. Nothing in this file writes.
 */

import { query } from '../database/db.ts';
import type { Fixed } from '../core/fixedpoint.ts';
import type { EscalationStage } from '../simulation/tension.ts';
import type { WorldInferenceProfile } from '../inference/profiles.ts';

export interface WorldSummary {
  worldId: string;
  status: string;
  ending: string | null;
  currentTick: number;
  day: number;
  phase: string;
  stage: EscalationStage;
  globalTension: Fixed;
  peaceStreak: number;
  seed: number;
  inferenceProfile: WorldInferenceProfile;
  timeScale: number;
  timeDebtTicks: number;
  agentsAlive: number;
  inferenceCalls: number;
  estCostMicros: number;
}

export async function getWorldSummary(worldId: string): Promise<WorldSummary | null> {
  const rows = await query<{
    world_id: string; status: string; ending: string | null; current_tick: number;
    seed: number; inference_profile: WorldInferenceProfile; time_scale: number;
    time_debt_ticks: number; day: number; phase: string;
    escalation_stage: EscalationStage; global_tension: number; peace_streak: number;
    agents_alive: number; inference_calls: number; est_cost_micros: number;
  }>(
    `SELECT w.world_id, w.status, w.ending, w.current_tick, w.seed,
            w.inference_profile, w.time_scale,
            w.time_debt_ticks,
            s.day, s.phase, s.escalation_stage, s.global_tension, s.peace_streak,
            (SELECT count(*)::INT8 FROM world_agents a
              WHERE a.world_id = w.world_id AND a.status = 'alive') AS agents_alive,
            COALESCE(b.inference_calls, 0) AS inference_calls,
            COALESCE(b.est_cost_micros, 0) AS est_cost_micros
       FROM worlds w
       JOIN world_state s ON s.world_id = w.world_id
       LEFT JOIN world_budget b ON b.world_id = w.world_id
      WHERE w.world_id = $1`,
    [worldId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    worldId: row.world_id,
    status: row.status,
    ending: row.ending,
    currentTick: row.current_tick,
    day: row.day,
    phase: row.phase,
    stage: row.escalation_stage,
    globalTension: row.global_tension,
    peaceStreak: row.peace_streak,
    seed: row.seed,
    inferenceProfile: row.inference_profile,
    timeScale: row.time_scale,
    timeDebtTicks: row.time_debt_ticks,
    agentsAlive: row.agents_alive,
    inferenceCalls: row.inference_calls,
    estCostMicros: row.est_cost_micros,
  };
}

export interface AgentView {
  agentKey: string;
  name: string;
  factionKey: string;
  locationKey: string;
  status: string;
  currentAction: string | null;
  /** Strongest belief, which is usually what the agent is about to act on. */
  topClaimKey: string | null;
  topConfidence: Fixed;
}

export async function listAgents(worldId: string): Promise<AgentView[]> {
  const rows = await query<{
    agent_key: string; name: string; faction_key: string; location_key: string;
    status: string; current_action: string | null;
    top_claim_key: string | null; top_confidence: number | null;
  }>(
    `SELECT a.agent_key, a.name, f.faction_key, l.location_key, a.status, a.current_action,
            top.claim_key AS top_claim_key, top.confidence AS top_confidence
       FROM world_agents a
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
       JOIN world_locations l ON l.world_id = a.world_id AND l.location_id = a.location_id
       LEFT JOIN LATERAL (
         SELECT c.claim_key, b.confidence
           FROM agent_beliefs b
           JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
          WHERE b.world_id = a.world_id AND b.agent_id = a.agent_id AND NOT c.locked
          ORDER BY b.confidence DESC, c.claim_key
          LIMIT 1
       ) top ON true
      WHERE a.world_id = $1
      ORDER BY a.agent_key`,
    [worldId],
  );

  return rows.map((row) => ({
    agentKey: row.agent_key,
    name: row.name,
    factionKey: row.faction_key,
    locationKey: row.location_key,
    status: row.status,
    currentAction: row.current_action,
    topClaimKey: row.top_claim_key,
    topConfidence: row.top_confidence ?? 0,
  }));
}

export interface ChronicleEntry {
  tick: number;
  seq: number;
  kind: string;
  description: string;
  actorKey: string | null;
  locationKey: string | null;
}

/**
 * The story so far.
 *
 * Movement is excluded by default: thirty people walking to work every tick is
 * true, voluminous, and not the story. The dashboard can ask for it explicitly.
 */
export async function getChronicle(
  worldId: string,
  options: { limit?: number; sinceTick?: number; includeMovement?: boolean } = {},
): Promise<ChronicleEntry[]> {
  const rows = await query<{
    tick: number; seq: number; kind: string; description: string;
    actor_key: string | null; location_key: string | null;
  }>(
    `SELECT e.tick, e.seq, e.kind, e.description,
            a.agent_key AS actor_key, l.location_key
       FROM world_events e
       LEFT JOIN world_agents a ON a.world_id = e.world_id AND a.agent_id = e.actor_agent_id
       LEFT JOIN world_locations l ON l.world_id = e.world_id AND l.location_id = e.location_id
      WHERE e.world_id = $1
        AND e.tick >= $2
        AND ($3 OR e.kind != 'movement')
      ORDER BY e.tick DESC, e.seq DESC
      LIMIT $4`,
    [worldId, options.sinceTick ?? 0, options.includeMovement ?? false, options.limit ?? 100],
  );
  return rows.map((row) => ({
    tick: row.tick,
    seq: row.seq,
    kind: row.kind,
    description: row.description,
    actorKey: row.actor_key,
    locationKey: row.location_key,
  }));
}

export interface TensionPoint {
  tick: number;
  globalTension: Fixed;
  stage: EscalationStage;
}

export async function getTensionCurve(worldId: string): Promise<TensionPoint[]> {
  const rows = await query<{
    tick: number; global_tension: number; escalation_stage: EscalationStage;
  }>(
    `SELECT tick, global_tension, escalation_stage FROM world_state_history
      WHERE world_id = $1 ORDER BY tick`,
    [worldId],
  );
  return rows.map((row) => ({
    tick: row.tick,
    globalTension: row.global_tension,
    stage: row.escalation_stage,
  }));
}

export interface SocialEdge {
  src: string;
  dst: string;
  sentiment: Fixed;
  trust: Fixed;
}

export interface SocialGraph {
  nodes: { key: string; name: string; factionKey: string; status: string }[];
  edges: SocialEdge[];
}

/**
 * The social graph, thresholded.
 *
 * All ~1,560 edges would render as a grey disc and say nothing. Only edges that
 * have actually moved away from where they started are worth drawing, because
 * those are the ones the simulation produced rather than the ones it was
 * seeded with.
 */
export async function getSocialGraph(
  worldId: string,
  minMagnitude = 2_500,
): Promise<SocialGraph> {
  const nodes = await query<{
    agent_key: string; name: string; faction_key: string; status: string;
  }>(
    `SELECT a.agent_key, a.name, f.faction_key, a.status
       FROM world_agents a
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
      WHERE a.world_id = $1 ORDER BY a.agent_key`,
    [worldId],
  );

  const edges = await query<{
    src: string; dst: string; sentiment: number; trust: number;
  }>(
    `SELECT s.agent_key AS src, d.agent_key AS dst, r.sentiment, r.trust
       FROM world_relationships r
       JOIN world_agents s ON s.world_id = r.world_id AND s.agent_id = r.src_agent_id
       JOIN world_agents d ON d.world_id = r.world_id AND d.agent_id = r.dst_agent_id
      WHERE r.world_id = $1 AND abs(r.sentiment) >= $2
      ORDER BY abs(r.sentiment) DESC, s.agent_key, d.agent_key
      LIMIT 400`,
    [worldId, minMagnitude],
  );

  return {
    nodes: nodes.map((row) => ({
      key: row.agent_key, name: row.name,
      factionKey: row.faction_key, status: row.status,
    })),
    edges,
  };
}

export interface ClaimView {
  claimKey: string;
  text: string;
  truth: string;
  severity: Fixed;
  subjectKey: string;
  heat: Fixed;
  believers: number;
  deniers: number;
  averageConfidence: Fixed;
  reached: number;
}

/**
 * Every claim, with what the town has made of it.
 *
 * `truth` sits next to `believers` on purpose — the gap between the two columns
 * is the entire misinformation demonstration, and putting them side by side is
 * the most honest way to show it.
 */
export async function getClaims(worldId: string): Promise<ClaimView[]> {
  const rows = await query<{
    claim_key: string; text: string; truth: string; severity: number;
    subject_key: string; heat: number; believers: number; deniers: number;
    average_confidence: number; reached: number;
  }>(
    `SELECT c.claim_key, c.text, c.truth, c.severity, s.agent_key AS subject_key,
            COALESCE(r.heat, 0) AS heat,
            count(*) FILTER (WHERE b.confidence >= 4500)::INT8 AS believers,
            count(*) FILTER (WHERE b.confidence < 0)::INT8 AS deniers,
            COALESCE(avg(b.confidence), 0)::INT8 AS average_confidence,
            count(b.agent_id)::INT8 AS reached
       FROM world_claims c
       JOIN world_agents s ON s.world_id = c.world_id AND s.agent_id = c.subject_agent_id
       LEFT JOIN world_rumors r ON r.world_id = c.world_id AND r.claim_id = c.claim_id
       LEFT JOIN agent_beliefs b ON b.world_id = c.world_id AND b.claim_id = c.claim_id
      WHERE c.world_id = $1 AND NOT c.locked
      GROUP BY c.claim_key, c.text, c.truth, c.severity, s.agent_key, r.heat
      ORDER BY believers DESC, c.claim_key`,
    [worldId],
  );

  return rows.map((row) => ({
    claimKey: row.claim_key,
    text: row.text,
    truth: row.truth,
    severity: row.severity,
    subjectKey: row.subject_key,
    heat: row.heat,
    believers: row.believers,
    deniers: row.deniers,
    averageConfidence: row.average_confidence,
    reached: row.reached,
  }));
}

export interface BeliefPoint {
  tick: number;
  confidence: Fixed;
}

/**
 * What one agent believed about one claim, tick by tick.
 *
 * Reconstructed from `belief_updates`, which is append-only and indexed in
 * simulation time. Deliberately not `AS OF SYSTEM TIME`: product history has to
 * outlive the database's garbage-collection window and be expressed in ticks,
 * not wall clock. Time travel is a separate resilience demonstration.
 */
export async function getBeliefHistory(
  worldId: string,
  agentKey: string,
  claimKey: string,
): Promise<BeliefPoint[]> {
  const rows = await query<{ tick: number; confidence: number }>(
    `SELECT u.tick, u.confidence
       FROM belief_updates u
       JOIN world_agents a ON a.world_id = u.world_id AND a.agent_id = u.agent_id
       JOIN world_claims c ON c.world_id = u.world_id AND c.claim_id = u.claim_id
      WHERE u.world_id = $1 AND a.agent_key = $2 AND c.claim_key = $3 AND NOT c.locked
      ORDER BY u.tick, u.seq`,
    [worldId, agentKey, claimKey],
  );
  return rows.map((row) => ({ tick: row.tick, confidence: row.confidence }));
}

/** Who believed what about one claim at a given tick, rebuilt from history. */
export async function getBeliefSnapshot(
  worldId: string,
  claimKey: string,
  tick: number,
): Promise<{ agentKey: string; factionKey: string; confidence: Fixed }[]> {
  const rows = await query<{
    agent_key: string; faction_key: string; confidence: number;
  }>(
    `SELECT DISTINCT ON (a.agent_key)
            a.agent_key, f.faction_key, u.confidence
       FROM belief_updates u
       JOIN world_agents a ON a.world_id = u.world_id AND a.agent_id = u.agent_id
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
       JOIN world_claims c ON c.world_id = u.world_id AND c.claim_id = u.claim_id
      WHERE u.world_id = $1 AND c.claim_key = $2 AND u.tick <= $3 AND NOT c.locked
      ORDER BY a.agent_key, u.tick DESC, u.seq DESC`,
    [worldId, claimKey, tick],
  );
  return rows.map((row) => ({
    agentKey: row.agent_key,
    factionKey: row.faction_key,
    confidence: row.confidence,
  }));
}

export interface FactionView {
  factionKey: string;
  name: string;
  belligerent: boolean;
  tension: Fixed;
  willingToNegotiate: boolean;
  leaderKey: string | null;
  members: number;
}

export async function getFactions(worldId: string): Promise<FactionView[]> {
  const rows = await query<{
    faction_key: string; name: string; belligerent: boolean; tension: number;
    willing_to_negotiate: boolean; leader_key: string | null; members: number;
  }>(
    `SELECT f.faction_key, f.name, f.belligerent, s.tension, s.willing_to_negotiate,
            l.agent_key AS leader_key,
            (SELECT count(*)::INT8 FROM world_agents m
              WHERE m.world_id = f.world_id AND m.faction_id = f.faction_id) AS members
       FROM world_factions f
       JOIN world_faction_state s ON s.world_id = f.world_id AND s.faction_id = f.faction_id
       LEFT JOIN world_agents l ON l.world_id = f.world_id AND l.agent_id = f.leader_agent_id
      WHERE f.world_id = $1
      ORDER BY f.faction_key`,
    [worldId],
  );
  return rows.map((row) => ({
    factionKey: row.faction_key,
    name: row.name,
    belligerent: row.belligerent,
    tension: row.tension,
    willingToNegotiate: row.willing_to_negotiate,
    leaderKey: row.leader_key,
    members: row.members,
  }));
}

export interface TickMetrics {
  tick: number;
  durationMs: number;
  retryCount: number;
}

/** Operational, not narrative: how the engine itself is behaving. */
export async function getTickMetrics(worldId: string, limit = 120): Promise<TickMetrics[]> {
  const rows = await query<{ tick: number; duration_ms: number; retry_count: number }>(
    `SELECT tick, duration_ms, retry_count FROM world_tick_commits
      WHERE world_id = $1 ORDER BY tick DESC LIMIT $2`,
    [worldId, limit],
  );
  return rows
    .map((row) => ({ tick: row.tick, durationMs: row.duration_ms, retryCount: row.retry_count }))
    .reverse();
}

export interface CognitionView {
  tick: number;
  agentKey: string;
  modelId: string;
  promptVersion: string;
  decision: Record<string, unknown>;
  latencyMs: number;
}

export async function getCognition(worldId: string, limit = 40): Promise<CognitionView[]> {
  const rows = await query<{
    tick: number; agent_key: string; model_id: string; prompt_version: string;
    decision: Record<string, unknown>; latency_ms: number;
  }>(
    `SELECT r.tick, a.agent_key, r.model_id, r.prompt_version, r.decision, r.latency_ms
       FROM cognition_records r
       JOIN world_agents a ON a.world_id = r.world_id AND a.agent_id = r.agent_id
      WHERE r.world_id = $1
      ORDER BY r.tick DESC, a.agent_key
      LIMIT $2`,
    [worldId, limit],
  );
  return rows.map((row) => ({
    tick: row.tick,
    agentKey: row.agent_key,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    decision: row.decision,
    latencyMs: row.latency_ms,
  }));
}

/** Worlds, newest first. The dashboard's landing view. */
export async function listWorlds(limit = 25): Promise<{
  worldId: string; status: string; ending: string | null; currentTick: number;
  stage: string; createdAt: string;
}[]> {
  const rows = await query<{
    world_id: string; status: string; ending: string | null; current_tick: number;
    escalation_stage: string; created_at: Date;
  }>(
    `SELECT w.world_id, w.status, w.ending, w.current_tick, s.escalation_stage, w.created_at
       FROM worlds w
       JOIN world_state s ON s.world_id = w.world_id
      ORDER BY w.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    worldId: row.world_id,
    status: row.status,
    ending: row.ending,
    currentTick: row.current_tick,
    stage: row.escalation_stage,
    createdAt: row.created_at.toISOString(),
  }));
}
