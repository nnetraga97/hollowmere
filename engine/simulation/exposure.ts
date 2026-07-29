import { BELIEF, EVIDENCE } from '../core/config.ts';
import type { Client } from '../database/db.ts';
import { suspendGoals } from '../agents/goals.ts';
import { endWorld } from './peace.ts';
import type { Seq } from '../core/seq.ts';

export async function maybeUnlockExposure(
  client: Client,
  input: { worldId: string; playerId: string; tick: number; seq: Seq },
): Promise<boolean> {
  const culprit = await client.query<{ agent_id: string }>(
    `SELECT agent_id FROM world_culprit WHERE world_id = $1`,
    [input.worldId],
  );
  const culpritId = culprit.rows[0]?.agent_id;
  if (!culpritId) return false;

  const proof = await client.query<{
    links: number;
    claims: number;
    contradictions: number;
    records: number;
  }>(
    `SELECT
       count(DISTINCT telling.telling_id) FILTER
         (WHERE e.kind = 'provenance' AND telling.from_agent_id = $3
            AND telling.claim_id = e.claim_id)::INT8 AS links,
       count(DISTINCT telling.claim_id) FILTER
         (WHERE e.kind = 'provenance' AND telling.from_agent_id = $3
            AND telling.claim_id = e.claim_id)::INT8 AS claims,
       count(DISTINCT event.event_id) FILTER
         (WHERE e.kind = 'contradiction' AND e.genuine)::INT8 AS contradictions,
       count(DISTINCT event.event_id) FILTER
         (WHERE e.kind = 'record' AND e.genuine)::INT8 AS records
      FROM world_player_evidence e
      LEFT JOIN world_rumor_tellings telling
        ON telling.world_id = e.world_id AND telling.telling_id = e.telling_id
      LEFT JOIN world_events event
        ON event.world_id = e.world_id AND event.event_id = e.event_id
     WHERE e.world_id = $1 AND e.player_id = $2`,
    [input.worldId, input.playerId, culpritId],
  );
  const row = proof.rows[0] ?? { links: 0, claims: 0, contradictions: 0, records: 0 };
  if (
    row.links < EVIDENCE.provenanceRequired ||
    row.claims < EVIDENCE.distinctClaimsRequired ||
    row.contradictions < EVIDENCE.contradictionRequired ||
    row.records < EVIDENCE.recordRequired
  ) return false;

  const unlocked = await client.query(
    `UPDATE world_claims SET locked = false
      WHERE world_id = $1 AND claim_key = 'instigator_exposed' AND locked
      RETURNING claim_id`,
    [input.worldId],
  );
  if ((unlocked.rowCount ?? 0) === 0) return false;

  await client.query(
    `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
     VALUES ($1, $2, $3, 'trigger', '{"evidenceComplete":true}',
             'The evidence now forms one accusation: someone engineered the feud.')`,
    [input.worldId, input.tick, input.seq.next()],
  );
  return true;
}

/** End the world only when the two House leaders and Magistrate Thule believe the case. */
export async function evaluateExposureEnding(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq },
): Promise<boolean> {
  const result = await client.query<{ believers: number; culprit_id: string }>(
    `SELECT count(*) FILTER (WHERE b.confidence >= $2)::INT8 AS believers,
            wc.agent_id AS culprit_id
       FROM world_culprit wc
       JOIN world_claims c
         ON c.world_id = wc.world_id AND c.claim_key = 'instigator_exposed' AND NOT c.locked
       JOIN world_agents required
         ON required.world_id = wc.world_id
        AND required.agent_key IN ('maren_aldreth', 'alric_corvane', 'veranne_thule')
       LEFT JOIN agent_beliefs b
         ON b.world_id = required.world_id AND b.agent_id = required.agent_id
        AND b.claim_id = c.claim_id
      WHERE wc.world_id = $1
      GROUP BY wc.agent_id`,
    [input.worldId, BELIEF.actionableConfidence],
  );
  const row = result.rows[0];
  if (!row || row.believers !== 3) return false;

  await client.query(
    `UPDATE world_agents SET status = 'detained', updated_tick = $3
      WHERE world_id = $1 AND agent_id = $2`,
    [input.worldId, row.culprit_id, input.tick],
  );
  await client.query(
    `UPDATE world_culprit SET exposed_tick = $2 WHERE world_id = $1`,
    [input.worldId, input.tick],
  );
  await suspendGoals(client, input.worldId, row.culprit_id, input.tick);
  await client.query(
    `UPDATE world_rumors r SET heat = 0, updated_tick = $3
      WHERE r.world_id = $1 AND EXISTS (
        SELECT 1 FROM world_rumor_tellings t
         WHERE t.world_id = r.world_id AND t.rumor_id = r.rumor_id AND t.from_agent_id = $2
      )`,
    [input.worldId, row.culprit_id, input.tick],
  );
  return endWorld(client, { ...input, ending: 'exposed' });
}
