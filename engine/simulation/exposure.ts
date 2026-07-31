import { BELIEF } from '../core/config.ts';
import type { Client } from '../database/db.ts';
import { suspendGoals } from '../agents/goals.ts';
import { endWorld } from './peace.ts';
import type { Seq } from '../core/seq.ts';

const REQUIRED_ROLES = [
  'tamper_sign',
  'tamper_comparator',
  'culprit_access',
  'murder_opportunity',
  'escalation_provenance',
] as const;

export async function maybeUnlockExposure(
  client: Client,
  input: { worldId: string; playerId: string; tick: number; seq: Seq },
): Promise<boolean> {
  const proof = await client.query<{ roles: number }>(
    `SELECT count(DISTINCT definition.role)::INT8 AS roles
       FROM world_case_evidence definition
       JOIN world_player_evidence evidence
         ON evidence.world_id = definition.world_id
        AND evidence.player_id = $2 AND evidence.role = definition.role
        AND evidence.genuine AND NOT evidence.manufactured
      WHERE definition.world_id = $1 AND definition.role = ANY($3::STRING[])`,
    [input.worldId, input.playerId, [...REQUIRED_ROLES]],
  );
  if ((proof.rows[0]?.roles ?? 0) !== REQUIRED_ROLES.length) return false;

  const unlocked = await client.query(
    `UPDATE world_claims SET locked = false
      WHERE world_id = $1
        AND claim_key IN ('instigator_altered_notebook', 'instigator_murdered_for_war')
        AND locked
      RETURNING claim_id`,
    [input.worldId],
  );
  if ((unlocked.rowCount ?? 0) === 0) return false;

  await client.query(
    `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
     VALUES ($1, $2, $3, 'trigger', '{"evidenceComplete":true}',
             'The five breadcrumbs now form a complete case: murder, alteration, and deliberate escalation.')`,
    [input.worldId, input.tick, input.seq.next()],
  );
  return true;
}

const AUTHORITY_ORDER = {
  aldreth: ['maren_aldreth', 'sella_dorn', 'rusk_baelen'],
  corvane: ['alric_corvane', 'rowan_corvane', 'hollis_barrow'],
} as const;

/** End only when the full verdict is legitimized by the magistrate and both Houses. */
export async function evaluateExposureEnding(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq },
): Promise<'exposed' | 'war' | null> {
  const state = await client.query<{
    culprit_id: string; agent_id: string; agent_key: string; status: string;
  }>(
    `SELECT culprit.agent_id AS culprit_id, agent.agent_id, agent.agent_key, agent.status
       FROM world_culprit culprit
       JOIN world_agents agent ON agent.world_id = culprit.world_id
      WHERE culprit.world_id = $1
        AND agent.agent_key IN
          ('veranne_thule', 'maren_aldreth', 'sella_dorn', 'rusk_baelen',
           'alric_corvane', 'rowan_corvane', 'hollis_barrow')
      ORDER BY agent.agent_key`,
    [input.worldId],
  );
  if (state.rows.length === 0) return null;
  const culpritId = state.rows[0]!.culprit_id;
  const available = new Map(state.rows
    .filter((row) => row.agent_id !== culpritId && ['alive', 'injured'].includes(row.status))
    .map((row) => [row.agent_key, row.agent_id]));
  const validators = [
    available.get('veranne_thule'),
    AUTHORITY_ORDER.aldreth.map((key) => available.get(key)).find(Boolean),
    AUTHORITY_ORDER.corvane.map((key) => available.get(key)).find(Boolean),
  ].filter((id): id is string => Boolean(id));

  if (validators.length !== 3) {
    await client.query(
      `INSERT INTO world_events (world_id, tick, seq, kind, payload, description)
       VALUES ($1, $2, $3, 'trigger', '{"authorityFailed":true}',
               'With no neutral and recognized House authorities left to judge the evidence, the rival Houses mobilize.')`,
      [input.worldId, input.tick, input.seq.next()],
    );
    return 'war';
  }

  const belief = await client.query<{ believers: number }>(
    `SELECT count(*) FILTER (WHERE belief.confidence >= $3)::INT8 AS believers
       FROM world_claims claim
       CROSS JOIN unnest($2::UUID[]) AS required(agent_id)
       LEFT JOIN agent_beliefs belief
         ON belief.world_id = claim.world_id AND belief.agent_id = required.agent_id
        AND belief.claim_id = claim.claim_id
      WHERE claim.world_id = $1 AND claim.claim_key = 'instigator_murdered_for_war'
        AND NOT claim.locked`,
    [input.worldId, validators, BELIEF.actionableConfidence],
  );
  if ((belief.rows[0]?.believers ?? 0) !== 3) return null;

  await client.query(
    `UPDATE world_agents SET status = 'detained', updated_tick = $3
      WHERE world_id = $1 AND agent_id = $2`,
    [input.worldId, culpritId, input.tick],
  );
  await client.query(
    `UPDATE world_culprit SET exposed_tick = $2 WHERE world_id = $1`,
    [input.worldId, input.tick],
  );
  await suspendGoals(client, input.worldId, culpritId, input.tick);
  await client.query(
    `UPDATE world_rumors rumor SET heat = 0, updated_tick = $3
      WHERE rumor.world_id = $1 AND EXISTS (
        SELECT 1 FROM world_rumor_tellings telling
         WHERE telling.world_id = rumor.world_id AND telling.rumor_id = rumor.rumor_id
           AND telling.from_agent_id = $2
      )`,
    [input.worldId, culpritId, input.tick],
  );
  return await endWorld(client, { ...input, ending: 'exposed' }) ? 'exposed' : null;
}
