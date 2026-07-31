import type { Client } from '../engine/database/db.ts';
import type { Seq } from '../engine/core/seq.ts';
import { recordBelief } from '../engine/social/beliefs.ts';
import { seedRumor } from '../engine/social/gossip.ts';
import type { OpeningEventDef } from './schema.ts';

/** Seed the selected case's accusation, private witnesses, denials, and visible tampering. */
export async function seedSelectedCaseOpening(
  client: Client,
  input: { worldId: string; opening: OpeningEventDef; eventId: string; seq: Seq },
): Promise<boolean> {
  const selected = await client.query<{
    culprit_id: string; target_faction_key: string; target_agent_key: string;
    claim_id: string; claim_text: string; recipient_id: string;
  }>(
    `SELECT culprit.agent_id AS culprit_id,
            culprit.case_state->>'targetFactionKey' AS target_faction_key,
            culprit.case_state->>'targetAgentKey' AS target_agent_key,
            claim.claim_id, claim.text AS claim_text, definition.holder_agent_id AS recipient_id
       FROM world_culprit culprit
       JOIN world_claims claim
         ON claim.world_id = culprit.world_id AND claim.claim_key = 'target_murdered_edryc'
       JOIN world_case_evidence definition
         ON definition.world_id = culprit.world_id
        AND definition.role = 'escalation_provenance'
      WHERE culprit.world_id = $1`,
    [input.worldId],
  );
  const selectedCase = selected.rows[0];
  if (!selectedCase) return false;

  const accusation = input.opening.seedRumors.find(
    (seed) => seed.claim === 'target_murdered_edryc',
  );
  await seedRumor(client, {
    worldId: input.worldId, tick: 0, seq: input.seq, claimId: selectedCase.claim_id,
    originAgentId: selectedCase.recipient_id, fromAgentId: selectedCase.culprit_id,
    channel: 'accusation', heat: accusation?.heat ?? 8_500,
    valence: accusation?.valence ?? -8_500, text: selectedCase.claim_text,
    originEventId: input.eventId, initialConfidence: 7_200,
  });

  const evidenceBeliefs = await client.query<{ holder_agent_id: string; claim_id: string }>(
    `SELECT holder_agent_id, claim_id FROM world_case_evidence
      WHERE world_id = $1 AND holder_agent_id IS NOT NULL
        AND role != 'escalation_provenance' ORDER BY role`,
    [input.worldId],
  );
  for (const belief of evidenceBeliefs.rows) await recordBelief(client, {
    worldId: input.worldId, agentId: belief.holder_agent_id, claimId: belief.claim_id,
    tick: 0, seq: input.seq.next(), confidence: 8_200, causeEventId: input.eventId,
  });

  const fairness = await client.query<{ agent_id: string; claim_id: string }>(
    `SELECT agent.agent_id, claim.claim_id FROM world_agents agent
     CROSS JOIN world_claims claim
      WHERE agent.world_id = $1 AND claim.world_id = $1
        AND agent.agent_key IN
          ('maren_aldreth', 'alric_corvane', 'father_ansel', 'ambrose_kyte', 'veranne_thule')
        AND claim.claim_key = 'edryc_investigated_fairly'
      ORDER BY agent.agent_key`,
    [input.worldId],
  );
  for (const belief of fairness.rows) await recordBelief(client, {
    worldId: input.worldId, agentId: belief.agent_id, claimId: belief.claim_id,
    tick: 0, seq: input.seq.next(), confidence: 7_500, causeEventId: input.eventId,
  });

  const authorities = selectedCase.target_faction_key === 'aldreth'
    ? ['maren_aldreth', 'sella_dorn', 'rusk_baelen']
    : ['alric_corvane', 'rowan_corvane', 'hollis_barrow'];
  const denierKeys = [...new Set([selectedCase.target_agent_key, ...authorities])]
    .slice(0, 3).sort();
  const deniers = await client.query<{ agent_id: string }>(
    `SELECT agent_id FROM world_agents
      WHERE world_id = $1 AND agent_key = ANY($2::STRING[]) ORDER BY agent_key`,
    [input.worldId, denierKeys],
  );
  for (const denier of deniers.rows) await recordBelief(client, {
    worldId: input.worldId, agentId: denier.agent_id, claimId: selectedCase.claim_id,
    tick: 0, seq: input.seq.next(), confidence: -8_500, causeEventId: input.eventId,
  });

  await client.query(
    `INSERT INTO world_player_evidence
       (world_id, player_id, kind, role, event_id, claim_id, genuine, found_tick)
     SELECT $1, player.player_id, definition.kind, definition.role, $2,
            definition.claim_id, true, 0
       FROM world_case_evidence definition
       CROSS JOIN world_players player
      WHERE definition.world_id = $1 AND player.world_id = $1
        AND definition.role = 'tamper_sign'
     ON CONFLICT DO NOTHING`,
    [input.worldId, input.eventId],
  );
  return true;
}
