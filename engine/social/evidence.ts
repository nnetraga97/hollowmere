import type { Client } from '../database/db.ts';

export const DISCLOSURES = [
  'name_them', 'deflect', 'misdirect', 'demand_something_first',
] as const;
export type Disclosure = typeof DISCLOSURES[number];

export function parseDisclosure(text: string): Disclosure {
  try {
    const value = JSON.parse(text) as { disclosure?: unknown };
    if (typeof value.disclosure === 'string' && DISCLOSURES.includes(value.disclosure as Disclosure)) {
      return value.disclosure as Disclosure;
    }
  } catch {
    // Unknown output is a deflection, never an invented source.
  }
  return 'deflect';
}

/** Discover the next authored breadcrumb held by the NPC being questioned. */
export async function recordCaseEvidenceForInquiry(
  client: Client,
  input: {
    worldId: string;
    playerId: string;
    agentId: string;
    eventId: string;
    tick: number;
  },
): Promise<string | null> {
  const definition = await client.query<{
    role: string; kind: 'provenance' | 'contradiction' | 'record';
    claim_id: string; accused_id: string | null;
  }>(
    `SELECT definition.role, definition.kind, definition.claim_id, definition.accused_id
       FROM world_case_evidence definition
      WHERE definition.world_id = $1 AND definition.holder_agent_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM world_player_evidence evidence
           WHERE evidence.world_id = definition.world_id
             AND evidence.player_id = $2 AND evidence.role = definition.role
        )
      ORDER BY CASE definition.role
        WHEN 'tamper_comparator' THEN 1 WHEN 'culprit_access' THEN 2
        WHEN 'murder_opportunity' THEN 3 ELSE 4 END
      LIMIT 1`,
    [input.worldId, input.playerId, input.agentId],
  );
  const row = definition.rows[0];
  if (!row) return null;

  let tellingId: string | null = null;
  if (row.role === 'escalation_provenance') {
    const telling = await client.query<{ telling_id: string }>(
      `SELECT telling.telling_id
         FROM world_rumor_tellings telling
         JOIN world_culprit culprit
           ON culprit.world_id = telling.world_id AND culprit.agent_id = telling.from_agent_id
        WHERE telling.world_id = $1 AND telling.to_agent_id = $2
          AND telling.claim_id = $3
        ORDER BY telling.tick, telling.seq LIMIT 1`,
      [input.worldId, input.agentId, row.claim_id],
    );
    tellingId = telling.rows[0]?.telling_id ?? null;
    if (!tellingId) return null;
  }

  await client.query(
    `INSERT INTO world_player_evidence
       (world_id, player_id, kind, role, telling_id, event_id, claim_id,
        accused_id, genuine, found_tick)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
     ON CONFLICT DO NOTHING`,
    [input.worldId, input.playerId, row.kind, row.role, tellingId,
     tellingId ? null : input.eventId, row.claim_id, row.accused_id, input.tick],
  );
  await client.query(
    `UPDATE world_claims SET locked = false
      WHERE world_id = $1 AND claim_id = $2`,
    [input.worldId, row.claim_id],
  );
  return row.role;
}

export async function recordInquiryEvidence(
  client: Client,
  input: {
    worldId: string;
    playerId: string;
    agentId: string;
    claimId: string;
    disclosure: Disclosure;
    tick: number;
  },
): Promise<{ accusedId: string; genuine: boolean } | null> {
  if (input.disclosure === 'deflect' || input.disclosure === 'demand_something_first') return null;

  const latest = await client.query<{ telling_id: string; from_agent_id: string }>(
    `SELECT telling_id, from_agent_id
       FROM world_rumor_tellings
      WHERE world_id = $1 AND to_agent_id = $2 AND claim_id = $3
        AND from_agent_id IS NOT NULL
      ORDER BY tick DESC, seq DESC
      LIMIT 1`,
    [input.worldId, input.agentId, input.claimId],
  );
  const telling = latest.rows[0];
  if (!telling) return null;

  let accusedId = telling.from_agent_id;
  let genuine = true;
  if (input.disclosure === 'misdirect') {
    const falseSource = await client.query<{ agent_id: string }>(
      `SELECT a.agent_id
         FROM world_relationships r
         JOIN world_agents a
           ON a.world_id = r.world_id AND a.agent_id = r.dst_agent_id
        WHERE r.world_id = $1 AND r.src_agent_id = $2
          AND a.agent_id NOT IN ($2, $3) AND a.status = 'alive'
        ORDER BY r.trust DESC, a.agent_key
        LIMIT 1`,
      [input.worldId, input.agentId, telling.from_agent_id],
    );
    if (!falseSource.rows[0]) return null;
    accusedId = falseSource.rows[0].agent_id;
    genuine = false;
  }

  await client.query(
    `INSERT INTO world_player_evidence
       (world_id, player_id, kind, telling_id, claim_id, accused_id, genuine, found_tick)
     VALUES ($1, $2, 'provenance', $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      input.worldId,
      input.playerId,
      telling.telling_id,
      input.claimId,
      accusedId,
      genuine,
      input.tick,
    ],
  );
  return { accusedId, genuine };
}

export async function recordWitnessedContradiction(
  client: Client,
  input: { worldId: string; playerId: string; actorId: string; tick: number },
): Promise<boolean> {
  const result = await client.query<{ event_id: string }>(
    `SELECT max(e.event_id::STRING)::UUID AS event_id
       FROM world_events e
       JOIN world_players p ON p.world_id = e.world_id AND p.player_id = $2
       JOIN world_claims c ON c.world_id = e.world_id AND c.claim_key = e.payload->>'claimKey'
       JOIN world_agents subject ON subject.world_id = c.world_id AND subject.agent_id = c.subject_agent_id
       JOIN world_factions f ON f.world_id = subject.world_id AND f.faction_id = subject.faction_id
      WHERE e.world_id = $1 AND e.actor_agent_id = $3
        AND e.kind IN ('dialogue', 'accusation') AND e.location_id = p.location_id
        AND f.belligerent
      GROUP BY e.actor_agent_id
     HAVING count(DISTINCT f.faction_id) >= 2`,
    [input.worldId, input.playerId, input.actorId],
  );
  const eventId = result.rows[0]?.event_id;
  if (!eventId) return false;
  await client.query(
    `INSERT INTO world_player_evidence
       (world_id, player_id, kind, event_id, accused_id, genuine, found_tick)
     VALUES ($1, $2, 'contradiction', $3, $4, true, $5)
     ON CONFLICT DO NOTHING`,
    [input.worldId, input.playerId, eventId, input.actorId, input.tick],
  );
  return true;
}
