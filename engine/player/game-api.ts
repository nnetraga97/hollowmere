/**
 * Session-scoped read models and commands for the Phaser client.
 *
 * The browser never supplies a world id. Route handlers recover the signed
 * session/world pair and every function below proves that pair against
 * world_players before reading or writing anything.
 */

import { query, withSerializable, type Client } from '../database/db.ts';
import {
  getClaims, getCognition, getFactions, getTickMetrics, getWorldSummary,
  listAgents, type AgentView, type ClaimView, type CognitionView,
  type FactionView, type TickMetrics, type WorldSummary,
} from './api.ts';
import { getHeldConversation, type ConversationView } from './conversation.ts';
import { getRomanceArcs, type RomanceArcView } from './romance.ts';

export interface SessionRef {
  sessionId: string;
  worldId: string;
}

export interface TownLocationView {
  key: string;
  name: string;
  districtKey: string;
  x: number;
  y: number;
  gossipBonus: number;
  controllingFactionKey: string | null;
}

export interface TownRouteView {
  from: string;
  to: string;
  cost: number;
}

export interface TownMapView {
  scenarioVersion: string;
  locations: TownLocationView[];
  routes: TownRouteView[];
}

export interface PlayerView {
  playerId: string;
  name: string;
  background: string;
  sympathyFactionKey: string | null;
  locationKey: string;
  reputation: { factionKey: string; value: number }[];
  pendingMove: { commandId: string; locationKey: string } | null;
}

export interface PlayerProfile {
  background: string;
  sympathyFactionKey: string | null;
}

export interface EvidenceView {
  evidenceId: string;
  kind: 'provenance' | 'contradiction' | 'record';
  accusedKey: string | null;
  claimKey: string | null;
  foundTick: number;
  genuine?: boolean;
}

export interface HearingCommitmentView {
  agentKey: string;
  response: string;
  status: string;
  dueTick: number;
}

export interface HearingView {
  hearingId: string;
  locationKey: string;
  dueTick: number;
  status: string;
  revealClaimKey: string | null;
  announcedTick: number;
  resolvedTick: number | null;
  commitments: HearingCommitmentView[];
}

export interface GameSnapshot {
  world: WorldSummary;
  player: PlayerView;
  agents: AgentView[];
  factions: FactionView[];
  claims: ClaimView[];
  evidence: EvidenceView[];
  hearings: HearingView[];
  cognition: CognitionView[];
  metrics: TickMetrics[];
  conversation: ConversationView | null;
  romances: RomanceArcView[];
  capabilities: { instigator: boolean; hearings: boolean; evidence: boolean };
}

/** Lightweight projection for frequent browser synchronization. */
export interface GameSync {
  world: {
    worldId: string;
    status: string;
    ending: string | null;
    currentTick: number;
  };
  player: {
    locationKey: string;
    pendingMove: { commandId: string; locationKey: string } | null;
  };
}

export interface AgentDetailView {
  agent: AgentView;
  summary: string;
  traits: string[];
  beliefs: { claimKey: string; confidence: number; updatedTick: number }[];
  relationships: { agentKey: string; sentiment: number; trust: number }[];
  cognition: CognitionView[];
  recentDialogue: { tick: number; text: string }[];
  memoryTrace: {
    memoryId: string;
    formedTick: number;
    lastAccessedTick: number | null;
    kind: string;
    excerpt: string;
    claimKey: string | null;
    sourceKind: 'turn' | 'event';
    sourceId: string;
    recalledByTurnId: string | null;
    candidatePaths: ('ann' | 'importance' | 'recency' | 'pinned_anchor')[];
  }[];
  personality: { kindness: number; engagement: number; honesty: number };
  playerRelationship: {
    trust: number; affinity: number; fear: number; respect: number; impression: string | null;
  } | null;
}

export interface DebugTruthView {
  available: boolean;
  culprit: { agentKey: string; motiveKey: string; exposedTick: number | null } | null;
  scheme: {
    posture: string;
    currentTactic: string | null;
    targetAgentKey: string | null;
    claimKey: string | null;
    nextStrategyTick: number;
  } | null;
  evidence: EvidenceView[];
}

export async function assertSession(ref: SessionRef): Promise<{
  playerId: string; playerName: string; playerProfile: PlayerProfile;
  locationId: string; locationKey: string; worldStatus: string;
}> {
  const rows = await query<{
    player_id: string; player_name: string; profile: Partial<PlayerProfile>;
    location_id: string; location_key: string; status: string;
  }>(
    `SELECT p.player_id, p.name AS player_name, p.profile, p.location_id, l.location_key, w.status
       FROM world_players p
       JOIN worlds w ON w.world_id = p.world_id
       JOIN world_locations l ON l.world_id = p.world_id AND l.location_id = p.location_id
      WHERE p.world_id = $1 AND p.session_id = $2`,
    [ref.worldId, ref.sessionId],
  );
  const row = rows[0];
  if (!row) throw new SessionAccessError();
  return {
    playerId: row.player_id,
    playerName: row.player_name,
    playerProfile: {
      background: row.profile?.background ?? '',
      sympathyFactionKey: row.profile?.sympathyFactionKey ?? null,
    },
    locationId: row.location_id,
    locationKey: row.location_key,
    worldStatus: row.status,
  };
}

export async function setPlayerProfile(
  ref: SessionRef,
  name: string,
  profile: PlayerProfile,
): Promise<void> {
  const rows = await query<{ player_id: string }>(
    `UPDATE world_players
        SET name = $3, profile = $4
      WHERE world_id = $1 AND session_id = $2
      RETURNING player_id`,
    [ref.worldId, ref.sessionId, name, JSON.stringify(profile)],
  );
  if (!rows[0]) throw new SessionAccessError();
}

export class SessionAccessError extends Error {
  constructor() {
    super('session does not own this world');
  }
}

export async function getTownMap(ref: SessionRef): Promise<TownMapView> {
  await assertSession(ref);
  const versions = await query<{ version: string }>(
    `SELECT s.version FROM worlds w
       JOIN scenario_versions s ON s.scenario_version_id = w.scenario_version_id
      WHERE w.world_id = $1`,
    [ref.worldId],
  );
  const locations = await query<{
    location_key: string; name: string; district_key: string; x: number; y: number;
    gossip_bonus: number; faction_key: string | null;
  }>(
    `SELECT l.location_key, l.name, l.district_key, l.x, l.y, l.gossip_bonus,
            f.faction_key
       FROM world_locations l
       LEFT JOIN world_factions f
         ON f.world_id = l.world_id AND f.faction_id = l.controlling_faction_id
      WHERE l.world_id = $1 ORDER BY l.location_key`,
    [ref.worldId],
  );
  const routes = await query<{
    from_key: string; to_key: string; cost: number;
  }>(
    `SELECT f.location_key AS from_key, t.location_key AS to_key, r.cost
       FROM world_routes r
       JOIN world_locations f
         ON f.world_id = r.world_id AND f.location_id = r.from_location_id
       JOIN world_locations t
         ON t.world_id = r.world_id AND t.location_id = r.to_location_id
      WHERE r.world_id = $1
      ORDER BY f.location_key, t.location_key`,
    [ref.worldId],
  );
  return {
    scenarioVersion: versions[0]?.version ?? 'unknown',
    locations: locations.map((row) => ({
      key: row.location_key,
      name: row.name,
      districtKey: row.district_key,
      x: row.x,
      y: row.y,
      gossipBonus: row.gossip_bonus,
      controllingFactionKey: row.faction_key,
    })),
    routes: routes.map((row) => ({ from: row.from_key, to: row.to_key, cost: row.cost })),
  };
}

export async function getGameSnapshot(ref: SessionRef): Promise<GameSnapshot> {
  const session = await assertSession(ref);
  const world = await getWorldSummary(ref.worldId);
  if (!world) throw new SessionAccessError();

  const [
    agents, factions, claims, cognition, metrics, reputations, pending, evidence,
    hearings, romances, conversation, capabilities,
  ] =
    await Promise.all([
      listAgents(ref.worldId),
      getFactions(ref.worldId),
      getClaims(ref.worldId),
      getCognition(ref.worldId, 24),
      getTickMetrics(ref.worldId, 80),
      query<{ faction_key: string; reputation: number }>(
        `SELECT f.faction_key, r.reputation FROM player_reputation r
          JOIN world_factions f ON f.world_id = r.world_id AND f.faction_id = r.faction_id
         WHERE r.world_id = $1 AND r.player_id = $2 ORDER BY f.faction_key`,
        [ref.worldId, session.playerId],
      ),
      query<{ command_id: string; location_key: string }>(
        `SELECT command_id, payload->>'locationKey' AS location_key
           FROM world_commands
          WHERE world_id = $1 AND applied_tick IS NULL AND kind = 'move_player'
            AND payload->>'playerId' = $2
          ORDER BY command_seq LIMIT 1`,
        [ref.worldId, session.playerId],
      ),
      readEvidence(ref, false, session.playerId),
      readHearings(ref),
      getRomanceArcs(ref),
      getHeldConversation(ref),
      getCapabilities(),
    ]);

  return {
    world,
    player: {
      playerId: session.playerId,
      name: session.playerName,
      background: session.playerProfile.background,
      sympathyFactionKey: session.playerProfile.sympathyFactionKey,
      locationKey: session.locationKey,
      reputation: reputations.map((row) => ({ factionKey: row.faction_key, value: row.reputation })),
      pendingMove: pending[0]
        ? { commandId: pending[0].command_id, locationKey: pending[0].location_key }
        : null,
    },
    agents,
    factions,
    claims,
    evidence,
    hearings,
    cognition,
    metrics,
    conversation,
    romances,
    capabilities,
  };
}

export async function getGameSync(ref: SessionRef): Promise<GameSync> {
  const rows = await query<{
    world_id: string; status: string; ending: string | null; current_tick: number;
    location_key: string; command_id: string | null; pending_location_key: string | null;
  }>(
    `SELECT w.world_id, w.status, w.ending, w.current_tick, l.location_key,
            pending.command_id, pending.location_key AS pending_location_key
       FROM world_players p
       JOIN worlds w ON w.world_id = p.world_id
       JOIN world_locations l
         ON l.world_id = p.world_id AND l.location_id = p.location_id
       LEFT JOIN LATERAL (
         SELECT c.command_id, c.payload->>'locationKey' AS location_key
           FROM world_commands c
          WHERE c.world_id = p.world_id AND c.applied_tick IS NULL
            AND c.kind = 'move_player'
            AND c.payload->>'playerId' = p.player_id::STRING
          ORDER BY c.command_seq
          LIMIT 1
       ) pending ON true
      WHERE p.world_id = $1 AND p.session_id = $2`,
    [ref.worldId, ref.sessionId],
  );
  const row = rows[0];
  if (!row) throw new SessionAccessError();
  return {
    world: {
      worldId: row.world_id,
      status: row.status,
      ending: row.ending,
      currentTick: row.current_tick,
    },
    player: {
      locationKey: row.location_key,
      pendingMove: row.command_id && row.pending_location_key
        ? { commandId: row.command_id, locationKey: row.pending_location_key }
        : null,
    },
  };
}

export async function getAgentDetail(ref: SessionRef, agentKey: string): Promise<AgentDetailView> {
  await assertSession(ref);
  const [
    agents, personas, beliefs, relationships, recent, recentDialogue, personality,
    memories, recallTurns,
  ] =
    await Promise.all([
      query<{
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
          WHERE a.world_id = $1 AND a.agent_key = $2`,
        [ref.worldId, agentKey],
      ),
      query<{ persona: { summary?: string; traits?: string[] } }>(
        `SELECT persona FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
        [ref.worldId, agentKey],
      ),
      query<{ claim_key: string; confidence: number; updated_tick: number }>(
        `SELECT c.claim_key, b.confidence, b.updated_tick FROM agent_beliefs b
           JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
           JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
          WHERE b.world_id = $1 AND a.agent_key = $2
          ORDER BY abs(b.confidence) DESC, c.claim_key LIMIT 12`,
        [ref.worldId, agentKey],
      ),
      query<{ agent_key: string; sentiment: number; trust: number }>(
        `SELECT d.agent_key, r.sentiment, r.trust FROM world_relationships r
           JOIN world_agents s ON s.world_id = r.world_id AND s.agent_id = r.src_agent_id
           JOIN world_agents d ON d.world_id = r.world_id AND d.agent_id = r.dst_agent_id
          WHERE r.world_id = $1 AND s.agent_key = $2
          ORDER BY abs(r.sentiment) DESC, d.agent_key LIMIT 12`,
        [ref.worldId, agentKey],
      ),
      query<{
        tick: number; agent_key: string; model_id: string; prompt_version: string;
        decision: Record<string, unknown>; latency_ms: number;
      }>(
        `SELECT r.tick, a.agent_key, r.model_id, r.prompt_version, r.decision, r.latency_ms
           FROM cognition_records r
           JOIN world_agents a ON a.world_id = r.world_id AND a.agent_id = r.agent_id
          WHERE r.world_id = $1 AND a.agent_key = $2
          ORDER BY r.tick DESC
          LIMIT 10`,
        [ref.worldId, agentKey],
      ),
      query<{ tick: number; description: string }>(
        `SELECT e.tick, e.description FROM world_events e
           JOIN world_agents a ON a.world_id = e.world_id AND a.agent_id = e.actor_agent_id
          WHERE e.world_id = $1 AND a.agent_key = $2 AND e.kind = 'dialogue'
          ORDER BY e.tick DESC, e.seq DESC LIMIT 10`, [ref.worldId, agentKey],
      ),
      query<{
        kindness: number; engagement: number; honesty: number; trust: number | null;
        affinity: number | null; fear: number | null; respect: number | null; impression: string | null;
      }>(
        `SELECT a.kindness, a.engagement, a.honesty, r.trust, r.affinity, r.fear,
                r.respect, r.impression
           FROM world_agents a
           LEFT JOIN world_players p ON p.world_id = a.world_id AND p.session_id = $3
           LEFT JOIN player_agent_relationships r ON r.world_id = a.world_id
                AND r.player_id = p.player_id AND r.agent_id = a.agent_id
          WHERE a.world_id = $1 AND a.agent_key = $2`,
        [ref.worldId, agentKey, ref.sessionId],
      ),
      query<{
        memory_id: string; formed_tick: number; last_accessed_tick: number | null;
        kind: string; excerpt: string; claim_key: string | null;
        source_kind: 'turn' | 'event'; source_id: string;
      }>(
        `SELECT m.memory_id, m.tick AS formed_tick, access.last_accessed_tick,
                m.kind, left(m.content, 220) AS excerpt, claim.claim_key,
                source.source_kind, source.source_id
           FROM world_memories m
           JOIN world_agents a
             ON a.world_id = m.world_id AND a.agent_id = m.agent_id
           LEFT JOIN world_claims claim
             ON claim.world_id = m.world_id AND claim.claim_id = m.claim_id
           LEFT JOIN LATERAL (
             SELECT max(accessed_tick)::INT8 AS last_accessed_tick
               FROM memory_accesses
              WHERE world_id = m.world_id AND memory_id = m.memory_id
           ) access ON true
           JOIN LATERAL (
             SELECT edge.source_kind,
                    COALESCE(edge.source_turn_id::STRING, edge.source_event_id::STRING) AS source_id
               FROM memory_source_edges edge
              WHERE edge.world_id = m.world_id AND edge.memory_id = m.memory_id
                AND edge.source_kind IN ('turn', 'event')
              ORDER BY CASE edge.source_kind WHEN 'turn' THEN 0 ELSE 1 END, edge.edge_id
              LIMIT 1
           ) source ON true
          WHERE m.world_id = $1 AND a.agent_key = $2
            AND m.kind NOT IN ('plan', 'reflection')
          ORDER BY COALESCE(access.last_accessed_tick, m.tick) DESC,
                   m.importance DESC, m.tick DESC, m.memory_id
          LIMIT 5`,
        [ref.worldId, agentKey],
      ),
      query<{ turn_id: string; structured_outcome: unknown }>(
        `SELECT turn_row.turn_id, turn_row.structured_outcome
           FROM world_conversation_turns turn_row
           JOIN world_conversation_sessions session
             ON session.world_id = turn_row.world_id
            AND session.conversation_id = turn_row.conversation_id
           JOIN world_agents agent
             ON agent.world_id = session.world_id
            AND agent.agent_id = session.target_agent_id
          WHERE turn_row.world_id = $1 AND agent.agent_key = $2
            AND turn_row.status IN ('completed', 'fallback')
          ORDER BY turn_row.completed_at DESC, turn_row.turn_id
          LIMIT 100`,
        [ref.worldId, agentKey],
      ),
    ]);
  const agentRow = agents[0];
  if (!agentRow) throw new Error(`unknown agent ${agentKey}`);
  const agent: AgentView = {
    agentKey: agentRow.agent_key,
    name: agentRow.name,
    factionKey: agentRow.faction_key,
    locationKey: agentRow.location_key,
    status: agentRow.status,
    currentAction: agentRow.current_action,
    topClaimKey: agentRow.top_claim_key,
    topConfidence: agentRow.top_confidence ?? 0,
  };
  const personal = personality[0];
  const recalled = latestMemoryRecalls(recallTurns);
  return {
    agent,
    summary: personas[0]?.persona.summary ?? '',
    traits: personas[0]?.persona.traits ?? [],
    beliefs: beliefs.map((row) => ({
      claimKey: row.claim_key, confidence: row.confidence, updatedTick: row.updated_tick,
    })),
    relationships: relationships.map((row) => ({
      agentKey: row.agent_key, sentiment: row.sentiment, trust: row.trust,
    })),
    cognition: recent.map((row) => ({
      tick: row.tick,
      agentKey: row.agent_key,
      modelId: row.model_id,
      promptVersion: row.prompt_version,
      decision: row.decision,
      latencyMs: row.latency_ms,
    })),
    recentDialogue: recentDialogue.map((row) => ({ tick: row.tick, text: row.description })),
    memoryTrace: memories.map((row) => {
      const recall = recalled.get(row.memory_id);
      return {
        memoryId: row.memory_id,
        formedTick: row.formed_tick,
        lastAccessedTick: row.last_accessed_tick,
        kind: row.kind,
        excerpt: row.excerpt,
        claimKey: row.claim_key,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        recalledByTurnId: recall?.turnId ?? null,
        candidatePaths: recall?.candidatePaths ?? [],
      };
    }),
    personality: {
      kindness: personal?.kindness ?? 5000,
      engagement: personal?.engagement ?? 5000,
      honesty: personal?.honesty ?? 5000,
    },
    playerRelationship: personal?.trust == null ? null : {
      trust: personal.trust,
      affinity: personal.affinity ?? 0,
      fear: personal.fear ?? 0,
      respect: personal.respect ?? 0,
      impression: personal.impression,
    },
  };
}

const MEMORY_CANDIDATE_PATHS = new Set([
  'ann', 'importance', 'recency', 'pinned_anchor',
] as const);

function latestMemoryRecalls(
  turns: { turn_id: string; structured_outcome: unknown }[],
): Map<string, {
  turnId: string;
  candidatePaths: ('ann' | 'importance' | 'recency' | 'pinned_anchor')[];
}> {
  const result = new Map<string, {
    turnId: string;
    candidatePaths: ('ann' | 'importance' | 'recency' | 'pinned_anchor')[];
  }>();
  for (const turn of turns) {
    if (!turn.structured_outcome || typeof turn.structured_outcome !== 'object') continue;
    const recalled = (turn.structured_outcome as { recalledMemories?: unknown }).recalledMemories;
    if (!Array.isArray(recalled)) continue;
    for (const value of recalled) {
      if (!value || typeof value !== 'object') continue;
      const memoryId = (value as { memoryId?: unknown }).memoryId;
      if (typeof memoryId !== 'string' || result.has(memoryId)) continue;
      const rawPaths = (value as { candidatePaths?: unknown }).candidatePaths;
      const candidatePaths = Array.isArray(rawPaths)
        ? [...new Set(rawPaths.filter((path): path is
          'ann' | 'importance' | 'recency' | 'pinned_anchor' =>
          typeof path === 'string' && MEMORY_CANDIDATE_PATHS.has(path as never)))]
        : [];
      result.set(memoryId, { turnId: turn.turn_id, candidatePaths });
    }
  }
  return result;
}

export async function getDebugTruth(ref: SessionRef): Promise<DebugTruthView> {
  await assertSession(ref);
  if (!(await tableExists('world_culprit'))) {
    return { available: false, culprit: null, scheme: null, evidence: [] };
  }
  const culprits = await optionalQuery<{
    agent_key: string; motive_key: string; exposed_tick: number | null;
  }>(
    `SELECT a.agent_key, c.motive_key, c.exposed_tick FROM world_culprit c
       JOIN world_agents a ON a.world_id = c.world_id AND a.agent_id = c.agent_id
      WHERE c.world_id = $1`, [ref.worldId],
  );
  const schemes = await optionalQuery<{
    posture: string; current_tactic: string | null; target_key: string | null;
    claim_key: string | null; next_strategy_tick: number;
  }>(
    `SELECT s.posture, s.current_tactic, t.agent_key AS target_key,
            c.claim_key, s.next_strategy_tick
       FROM world_scheme_state s
       LEFT JOIN world_agents t
         ON t.world_id = s.world_id AND t.agent_id = s.target_agent_id
       LEFT JOIN world_claims c
         ON c.world_id = s.world_id AND c.claim_id = s.claim_id
      WHERE s.world_id = $1 ORDER BY s.updated_tick DESC LIMIT 1`, [ref.worldId],
  );
  return {
    available: true,
    culprit: culprits[0] ? {
      agentKey: culprits[0].agent_key,
      motiveKey: culprits[0].motive_key,
      exposedTick: culprits[0].exposed_tick,
    } : null,
    scheme: schemes[0] ? {
      posture: schemes[0].posture,
      currentTactic: schemes[0].current_tactic,
      targetAgentKey: schemes[0].target_key,
      claimKey: schemes[0].claim_key,
      nextStrategyTick: schemes[0].next_strategy_tick,
    } : null,
    evidence: await readEvidence(ref, true),
  };
}

export async function assertColocated(ref: SessionRef, agentKey: string): Promise<void> {
  const session = await assertSession(ref);
  const rows = await query<{ location_id: string }>(
    `SELECT location_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
    [ref.worldId, agentKey],
  );
  if (!rows[0]) throw new Error(`unknown agent ${agentKey}`);
  if (rows[0].location_id !== session.locationId) {
    throw new Error(`${agentKey} is not at the player's location`);
  }
}

export async function queuePlayerMove(
  ref: SessionRef,
  locationKey: string,
  idempotencyKey: string,
): Promise<{ commandId: string; replayed: boolean; locationKey: string; appliedTick: number }> {
  const { value } = await withSerializable(async (client) => {
    const player = await sessionOnClient(client, ref);
    const previous = await client.query<{
      command_id: string; applied_tick: number | null; current_tick: number;
      current_location_key: string; requested_location_id: string | null;
      requested_location_key: string | null; world_status: string;
      requested_location_adjacent: boolean; conversation_open: boolean;
    }>(
      `SELECT c.command_id, c.applied_tick, w.current_tick,
              current_location.location_key AS current_location_key,
              requested_location.location_id AS requested_location_id,
              requested_location.location_key AS requested_location_key,
              w.status AS world_status,
              EXISTS (
                SELECT 1 FROM world_routes route
                 WHERE route.world_id = p.world_id
                   AND route.from_location_id = p.location_id
                   AND route.to_location_id = requested_location.location_id
              ) AS requested_location_adjacent,
              EXISTS (
                SELECT 1 FROM world_conversation_sessions conversation
                 WHERE conversation.world_id = p.world_id
                   AND conversation.player_id = p.player_id
                   AND conversation.status IN ('open', 'closing')
              ) AS conversation_open
         FROM world_commands c
         JOIN worlds w ON w.world_id = c.world_id
         JOIN world_players p ON p.world_id = c.world_id AND p.session_id = $3
         JOIN world_locations current_location
           ON current_location.world_id = p.world_id
          AND current_location.location_id = p.location_id
         LEFT JOIN world_locations requested_location
           ON requested_location.world_id = c.world_id
          AND requested_location.location_key = c.payload->>'locationKey'
        WHERE c.world_id = $1 AND c.idempotency_key = $2 AND c.kind = 'move_player'
          AND c.payload->>'playerId' = $4`,
      [ref.worldId, idempotencyKey, ref.sessionId, player.playerId],
    );
    const prior = previous.rows[0];
    if (prior) {
      if (prior.applied_tick === null) {
        if (!prior.requested_location_id || !prior.requested_location_key) {
          throw new Error('pending move has an invalid destination');
        }
        if (prior.world_status !== 'active') throw new Error('world is not active');
        if (prior.conversation_open) throw new Error('end the conversation before travelling');
        if (!prior.requested_location_adjacent) {
          throw new Error('destination is not adjacent to the player');
        }
        await client.query(
          `UPDATE world_players SET location_id = $3
            WHERE world_id = $1 AND player_id = $2`,
          [ref.worldId, player.playerId, prior.requested_location_id],
        );
        await client.query(
          `UPDATE world_commands SET applied_tick = $3
            WHERE world_id = $1 AND command_id = $2 AND applied_tick IS NULL`,
          [ref.worldId, prior.command_id, prior.current_tick],
        );
        return {
          commandId: prior.command_id,
          replayed: true,
          locationKey: prior.requested_location_key,
          appliedTick: prior.current_tick,
        };
      }
      return {
        commandId: prior.command_id,
        replayed: true,
        locationKey: prior.current_location_key,
        appliedTick: prior.applied_tick,
      };
    }

    const pending = await client.query(
      `SELECT 1 FROM world_commands
        WHERE world_id = $1 AND applied_tick IS NULL AND kind = 'move_player'
          AND payload->>'playerId' = $2 LIMIT 1`,
      [ref.worldId, player.playerId],
    );
    if (pending.rowCount) throw new Error('a player move is already pending');

    const conversation = await client.query(
      `SELECT 1 FROM world_conversation_sessions
        WHERE world_id = $1 AND player_id = $2 AND status IN ('open', 'closing') LIMIT 1`,
      [ref.worldId, player.playerId],
    );
    if (conversation.rowCount) throw new Error('end the conversation before travelling');

    const target = await client.query<{ location_id: string }>(
      `SELECT t.location_id FROM world_locations t
        WHERE t.world_id = $1 AND t.location_key = $2
          AND EXISTS (
            SELECT 1 FROM world_routes r
             WHERE r.world_id = $1 AND r.from_location_id = $3
               AND r.to_location_id = t.location_id
          )`,
      [ref.worldId, locationKey, player.locationId],
    );
    if (!target.rows[0]) throw new Error('destination is not adjacent to the player');

    const sequence = await client.query<{ command_seq: number; current_tick: number }>(
      `UPDATE worlds SET command_seq = command_seq + 1, last_activity_at = now()
        WHERE world_id = $1 AND status = 'active' RETURNING command_seq, current_tick`,
      [ref.worldId],
    );
    if (!sequence.rows[0]) throw new Error('world is not active');
    await client.query(
      `UPDATE world_players SET location_id = $3
        WHERE world_id = $1 AND player_id = $2`,
      [ref.worldId, player.playerId, target.rows[0].location_id],
    );
    const inserted = await client.query<{ command_id: string }>(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, 'move_player', $4, $5) RETURNING command_id`,
      [ref.worldId, idempotencyKey, sequence.rows[0].command_seq,
        JSON.stringify({ playerId: player.playerId, locationKey }), sequence.rows[0].current_tick],
    );
    return {
      commandId: inserted.rows[0]!.command_id,
      replayed: false,
      locationKey,
      appliedTick: sequence.rows[0].current_tick,
    };
  }, { label: 'queue-player-move' });
  return value;
}

export async function queueTimeScale(
  ref: SessionRef,
  timeScale: number,
  idempotencyKey: string,
): Promise<{ commandId: string; replayed: boolean }> {
  if (![5_000, 10_000, 20_000, 40_000, 80_000].includes(timeScale)) {
    throw new Error('unsupported time scale');
  }
  const { value } = await withSerializable(async (client) => {
    await sessionOnClient(client, ref);
    const previous = await client.query<{
      command_id: string; applied_tick: number | null; requested_scale: number;
      current_tick: number; world_status: string;
    }>(
      `SELECT c.command_id, c.applied_tick,
              (c.payload->>'timeScale')::INT8 AS requested_scale, w.current_tick,
              w.status AS world_status
         FROM world_commands c
         JOIN worlds w ON w.world_id = c.world_id
        WHERE c.world_id = $1 AND c.idempotency_key = $2 AND c.kind = 'set_time_scale'`,
      [ref.worldId, idempotencyKey],
    );
    const prior = previous.rows[0];
    if (prior) {
      if (prior.applied_tick === null) {
        if (prior.world_status !== 'active') throw new Error('world is not active');
        await client.query(
          `UPDATE worlds SET time_scale = $2, last_activity_at = now()
            WHERE world_id = $1 AND status = 'active'`,
          [ref.worldId, prior.requested_scale],
        );
        await client.query(
          `UPDATE world_commands SET applied_tick = $3
            WHERE world_id = $1 AND command_id = $2 AND applied_tick IS NULL`,
          [ref.worldId, prior.command_id, prior.current_tick],
        );
      }
      return { commandId: prior.command_id, replayed: true };
    }
    const sequence = await client.query<{ command_seq: number; current_tick: number }>(
      `UPDATE worlds
          SET command_seq = command_seq + 1, time_scale = $2, last_activity_at = now()
        WHERE world_id = $1 AND status = 'active'
        RETURNING command_seq, current_tick`, [ref.worldId, timeScale],
    );
    if (!sequence.rows[0]) throw new Error('world is not active');
    const inserted = await client.query<{ command_id: string }>(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, 'set_time_scale', $4, $5) RETURNING command_id`,
      [ref.worldId, idempotencyKey, sequence.rows[0].command_seq,
        JSON.stringify({ timeScale }), sequence.rows[0].current_tick],
    );
    return { commandId: inserted.rows[0]!.command_id, replayed: false };
  }, { label: 'queue-time-scale' });
  return value;
}

export async function pauseSessionWorld(ref: SessionRef): Promise<boolean> {
  const rows = await query<{ world_id: string }>(
    `UPDATE worlds w SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL
      FROM world_players p
     WHERE w.world_id = $1 AND p.world_id = w.world_id AND p.session_id = $2
       AND w.status = 'active'
     RETURNING w.world_id`, [ref.worldId, ref.sessionId],
  );
  return rows.length > 0;
}

export async function resumeSessionWorld(ref: SessionRef): Promise<boolean> {
  const rows = await query<{ world_id: string }>(
    `UPDATE worlds w SET status = 'active', last_activity_at = now()
      FROM world_players p
     WHERE w.world_id = $1 AND p.world_id = w.world_id AND p.session_id = $2
       AND w.status = 'paused'
     RETURNING w.world_id`, [ref.worldId, ref.sessionId],
  );
  return rows.length > 0;
}

/**
 * Permanently end the world owned by this signed player session.
 *
 * This is intentionally different from pause: an ended world is immutable to
 * the scheduler and may be inspected later, but it can never be resumed.
 */
export async function endSessionWorld(ref: SessionRef): Promise<boolean> {
  const { value } = await withSerializable(async (client) => {
    await sessionOnClient(client, ref);
    const worlds = await client.query<{ status: string; current_tick: number }>(
      `SELECT status, current_tick FROM worlds WHERE world_id = $1 FOR UPDATE`,
      [ref.worldId],
    );
    const world = worlds.rows[0];
    if (!world) throw new SessionAccessError();
    if (world.status === 'ended') return false;
    if (!['active', 'paused'].includes(world.status)) {
      throw new Error('world cannot be ended from its current state');
    }

    // A player may leave during a conversation. Release the scheduler hold so
    // the completed world cannot retain live conversational work.
    await client.query(
      `UPDATE world_conversation_sessions
          SET status = 'abandoned', closed_tick = $2, closed_at = now()
        WHERE world_id = $1 AND status IN ('open', 'closing')`,
      [ref.worldId, world.current_tick],
    );
    await client.query(
      `UPDATE worlds
          SET status = 'ended', ending = 'player_ended',
              lease_owner = NULL, lease_expires_at = NULL, last_activity_at = now()
        WHERE world_id = $1`,
      [ref.worldId],
    );
    return true;
  }, { label: 'end-session-world' });
  return value;
}

async function readEvidence(
  ref: SessionRef,
  includeTruth: boolean,
  knownPlayerId?: string,
): Promise<EvidenceView[]> {
  const playerId = knownPlayerId ?? (await assertSession(ref)).playerId;
  const rows = await optionalQuery<{
    evidence_id: string; kind: EvidenceView['kind']; accused_key: string | null;
    claim_key: string | null; found_tick: number; genuine: boolean;
  }>(
    `SELECT e.evidence_id, e.kind, a.agent_key AS accused_key,
            c.claim_key, e.found_tick, e.genuine
       FROM world_player_evidence e
       LEFT JOIN world_agents a
         ON a.world_id = e.world_id AND a.agent_id = e.accused_id
       LEFT JOIN world_claims c
         ON c.world_id = e.world_id AND c.claim_id = e.claim_id
      WHERE e.world_id = $1 AND e.player_id = $2
      ORDER BY e.found_tick, e.evidence_id`, [ref.worldId, playerId],
  );
  return rows.map((row) => ({
    evidenceId: row.evidence_id,
    kind: row.kind,
    accusedKey: row.accused_key,
    claimKey: row.claim_key,
    foundTick: row.found_tick,
    ...(includeTruth ? { genuine: row.genuine } : {}),
  }));
}

async function readHearings(ref: SessionRef): Promise<HearingView[]> {
  const hearings = await optionalQuery<{
    hearing_id: string; location_key: string; due_tick: number; status: string;
    reveal_claim_key: string | null; announced_tick: number; resolved_tick: number | null;
  }>(
    `SELECT h.hearing_id, l.location_key, h.due_tick, h.status,
            c.claim_key AS reveal_claim_key, h.announced_tick, h.resolved_tick
       FROM world_hearings h
       JOIN world_locations l ON l.world_id = h.world_id AND l.location_id = h.location_id
       LEFT JOIN world_claims c
         ON c.world_id = h.world_id AND c.claim_id = h.reveal_claim_id
      WHERE h.world_id = $1
      ORDER BY h.due_tick DESC, h.hearing_id`, [ref.worldId],
  );
  if (!hearings.length) return [];
  const commitments = await optionalQuery<{
    hearing_id: string; agent_key: string; response: string; status: string; due_tick: number;
  }>(
    `SELECT c.hearing_id, a.agent_key, c.response, c.status, c.due_tick
       FROM world_agent_commitments c
       JOIN world_agents a ON a.world_id = c.world_id AND a.agent_id = c.agent_id
      WHERE c.world_id = $1 AND c.hearing_id IS NOT NULL
      ORDER BY c.due_tick, a.agent_key`, [ref.worldId],
  );
  return hearings.map((row) => ({
    hearingId: row.hearing_id,
    locationKey: row.location_key,
    dueTick: row.due_tick,
    status: row.status,
    revealClaimKey: row.reveal_claim_key,
    announcedTick: row.announced_tick,
    resolvedTick: row.resolved_tick,
    commitments: commitments
      .filter((item) => item.hearing_id === row.hearing_id)
      .map((item) => ({
        agentKey: item.agent_key,
        response: item.response,
        status: item.status,
        dueTick: item.due_tick,
      })),
  }));
}

async function sessionOnClient(client: Client, ref: SessionRef): Promise<{
  playerId: string; locationId: string;
}> {
  const rows = await client.query<{ player_id: string; location_id: string }>(
    `SELECT player_id, location_id FROM world_players
      WHERE world_id = $1 AND session_id = $2`, [ref.worldId, ref.sessionId],
  );
  if (!rows.rows[0]) throw new SessionAccessError();
  return { playerId: rows.rows[0].player_id, locationId: rows.rows[0].location_id };
}

const tableCache = new Map<string, boolean>();

async function getCapabilities(): Promise<GameSnapshot['capabilities']> {
  const [instigator, hearings, evidence] = await Promise.all([
    tableExists('world_culprit'),
    tableExists('world_hearings'),
    tableExists('world_player_evidence'),
  ]);
  return { instigator, hearings, evidence };
}

async function tableExists(table: string): Promise<boolean> {
  const cached = tableCache.get(table);
  if (cached !== undefined) return cached;
  const rows = await query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`],
  );
  const present = rows[0]?.present ?? false;
  tableCache.set(table, present);
  return present;
}

async function optionalQuery<T extends Record<string, unknown>>(
  text: string,
  params: readonly unknown[],
): Promise<T[]> {
  try {
    return await query<T>(text, params);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        ((error as { code?: unknown }).code === '42P01' ||
         (error as { code?: unknown }).code === '42703')) {
      return [];
    }
    throw error;
  }
}
