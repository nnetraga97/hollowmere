/**
 * Session-scoped read models and commands for the Phaser client.
 *
 * The browser never supplies a world id. Route handlers recover the signed
 * session/world pair and every function below proves that pair against
 * world_players before reading or writing anything.
 */

import { query, withSerializable, type Client } from './db.ts';
import {
  getClaims, getCognition, getFactions, getTickMetrics, getWorldSummary,
  listAgents, type AgentView, type ClaimView, type CognitionView,
  type FactionView, type TickMetrics, type WorldSummary,
} from './api.ts';

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
  locationKey: string;
  reputation: { factionKey: string; value: number }[];
  pendingMove: { commandId: string; locationKey: string } | null;
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
  capabilities: { instigator: boolean; hearings: boolean; evidence: boolean };
}

export interface AgentDetailView {
  agent: AgentView;
  summary: string;
  traits: string[];
  beliefs: { claimKey: string; confidence: number; updatedTick: number }[];
  relationships: { agentKey: string; sentiment: number; trust: number }[];
  cognition: CognitionView[];
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
  playerId: string; locationId: string; locationKey: string; worldStatus: string;
}> {
  const rows = await query<{
    player_id: string; location_id: string; location_key: string; status: string;
  }>(
    `SELECT p.player_id, p.location_id, l.location_key, w.status
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
    locationId: row.location_id,
    locationKey: row.location_key,
    worldStatus: row.status,
  };
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

  const [agents, factions, claims, cognition, metrics, reputations, pending, evidence, hearings] =
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
      readEvidence(ref, false),
      readHearings(ref),
    ]);

  return {
    world,
    player: {
      playerId: session.playerId,
      name: 'the outsider',
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
    capabilities: {
      instigator: await tableExists('world_culprit'),
      hearings: await tableExists('world_hearings'),
      evidence: await tableExists('world_player_evidence'),
    },
  };
}

export async function getAgentDetail(ref: SessionRef, agentKey: string): Promise<AgentDetailView> {
  await assertSession(ref);
  const agent = (await listAgents(ref.worldId)).find((item) => item.agentKey === agentKey);
  if (!agent) throw new Error(`unknown agent ${agentKey}`);
  const personas = await query<{ persona: { summary?: string; traits?: string[] } }>(
    `SELECT persona FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
    [ref.worldId, agentKey],
  );
  const beliefs = await query<{ claim_key: string; confidence: number; updated_tick: number }>(
    `SELECT c.claim_key, b.confidence, b.updated_tick FROM agent_beliefs b
       JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
       JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
      WHERE b.world_id = $1 AND a.agent_key = $2
      ORDER BY abs(b.confidence) DESC, c.claim_key LIMIT 12`,
    [ref.worldId, agentKey],
  );
  const relationships = await query<{
    agent_key: string; sentiment: number; trust: number;
  }>(
    `SELECT d.agent_key, r.sentiment, r.trust FROM world_relationships r
       JOIN world_agents s ON s.world_id = r.world_id AND s.agent_id = r.src_agent_id
       JOIN world_agents d ON d.world_id = r.world_id AND d.agent_id = r.dst_agent_id
      WHERE r.world_id = $1 AND s.agent_key = $2
      ORDER BY abs(r.sentiment) DESC, d.agent_key LIMIT 12`,
    [ref.worldId, agentKey],
  );
  const recent = (await getCognition(ref.worldId, 100))
    .filter((item) => item.agentKey === agentKey)
    .slice(0, 10);
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
    cognition: recent,
  };
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
): Promise<{ commandId: string; replayed: boolean }> {
  const { value } = await withSerializable(async (client) => {
    const player = await sessionOnClient(client, ref);
    const previous = await client.query<{ command_id: string }>(
      `SELECT command_id FROM world_commands
        WHERE world_id = $1 AND idempotency_key = $2`,
      [ref.worldId, idempotencyKey],
    );
    if (previous.rows[0]) return { commandId: previous.rows[0].command_id, replayed: true };

    const pending = await client.query(
      `SELECT 1 FROM world_commands
        WHERE world_id = $1 AND applied_tick IS NULL AND kind = 'move_player'
          AND payload->>'playerId' = $2 LIMIT 1`,
      [ref.worldId, player.playerId],
    );
    if (pending.rowCount) throw new Error('a player move is already pending');

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

    const sequence = await client.query<{ command_seq: number }>(
      `UPDATE worlds SET command_seq = command_seq + 1, last_activity_at = now()
        WHERE world_id = $1 AND status = 'active' RETURNING command_seq`,
      [ref.worldId],
    );
    if (!sequence.rows[0]) throw new Error('world is not active');
    const inserted = await client.query<{ command_id: string }>(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload)
       VALUES ($1, $2, $3, 'move_player', $4) RETURNING command_id`,
      [ref.worldId, idempotencyKey, sequence.rows[0].command_seq,
        JSON.stringify({ playerId: player.playerId, locationKey })],
    );
    return { commandId: inserted.rows[0]!.command_id, replayed: false };
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
    const previous = await client.query<{ command_id: string }>(
      `SELECT command_id FROM world_commands WHERE world_id = $1 AND idempotency_key = $2`,
      [ref.worldId, idempotencyKey],
    );
    if (previous.rows[0]) return { commandId: previous.rows[0].command_id, replayed: true };
    const sequence = await client.query<{ command_seq: number }>(
      `UPDATE worlds SET command_seq = command_seq + 1, last_activity_at = now()
        WHERE world_id = $1 AND status = 'active' RETURNING command_seq`, [ref.worldId],
    );
    if (!sequence.rows[0]) throw new Error('world is not active');
    const inserted = await client.query<{ command_id: string }>(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload)
       VALUES ($1, $2, $3, 'set_time_scale', $4) RETURNING command_id`,
      [ref.worldId, idempotencyKey, sequence.rows[0].command_seq, JSON.stringify({ timeScale })],
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

async function readEvidence(ref: SessionRef, includeTruth: boolean): Promise<EvidenceView[]> {
  const session = await assertSession(ref);
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
      ORDER BY e.found_tick, e.evidence_id`, [ref.worldId, session.playerId],
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
