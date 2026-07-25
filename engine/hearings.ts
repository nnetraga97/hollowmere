import { createHash } from 'node:crypto';

import { BELIEF, CONVERSE, HEARING, TENSION } from './config.ts';
import { recordBelief } from './beliefs.ts';
import { readBudget, recordUsage } from './budget.ts';
import type { Client } from './db.ts';
import { clampSigned, clampUnit, fpMul, SCALE, type Fixed } from './fixedpoint.ts';
import type { InferenceClient } from './inference/index.ts';
import { loadRouteGraph, type RouteGraph } from './movement.ts';
import { deriveSeed } from './rng.ts';
import type { Seq } from './seq.ts';

export const ATTENDANCE_PROMPT_VERSION = 'attendance-v1';
export const ATTENDANCE_RESPONSES = ['come', 'decline', 'come_but_tell_someone'] as const;
export type AttendanceResponse = typeof ATTENDANCE_RESPONSES[number];

export interface SummonDecision {
  response: AttendanceResponse;
  locationId: string;
  locationKey: string;
  dueTick: number;
  rejectedReason: string | null;
  inputHash: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export async function decideSummon(
  client: Client,
  input: {
    worldId: string;
    tick: number;
    commandSeq: number;
    agentId: string;
    playerId: string;
    text: string;
    inference: InferenceClient;
  },
): Promise<SummonDecision> {
  const graph = await loadRouteGraph(client, input.worldId);
  const agent = await client.query<{ location_id: string; agent_key: string }>(
    `SELECT location_id, agent_key FROM world_agents
      WHERE world_id = $1 AND agent_id = $2 AND status = 'alive'`,
    [input.worldId, input.agentId],
  );
  const row = agent.rows[0];
  if (!row) throw new Error('only a living agent can be summoned');
  const locationKey = resolveLocationKey(input.text, graph);
  const locationId = graph.idByKey.get(locationKey)!;
  const travel = shortestCost(graph, row.location_id, locationId);
  const requestedImmediate = /\b(now|immediately|this tick)\b/i.test(input.text);
  const active = await client.query<{ due_tick: number }>(
    `SELECT due_tick FROM world_hearings
      WHERE world_id = $1 AND convener_id = $2 AND location_id = $3
        AND status IN ('announced', 'gathering')
      ORDER BY due_tick, hearing_id LIMIT 1`,
    [input.worldId, input.playerId, locationId],
  );
  const dueTick = active.rows[0]?.due_tick ?? (
    requestedImmediate ? input.tick + 1 : input.tick + travel + HEARING.travelSlackTicks
  );
  const rejectedReason = travel + HEARING.travelSlackTicks > dueTick - input.tick
    ? `${row.agent_key} cannot reach ${locationKey} by tick ${dueTick}`
    : null;
  const inputHash = createHash('sha256').update(JSON.stringify({
    agentKey: row.agent_key,
    locationKey,
    dueTick,
  })).digest('hex');

  if (rejectedReason) {
    return {
      response: 'decline', locationId, locationKey, dueTick, rejectedReason,
      inputHash, modelId: 'deterministic-fallback', tokensIn: 0, tokensOut: 0, latencyMs: 0,
    };
  }

  const budget = await readBudget(client, input.worldId);
  if (budget.exhausted) {
    return {
      response: 'come', locationId, locationKey, dueTick, rejectedReason: null,
      inputHash, modelId: 'deterministic-fallback', tokensIn: 0, tokensOut: 0, latencyMs: 0,
    };
  }
  const response = await input.inference.complete({
    task: 'attendance',
    promptVersion: ATTENDANCE_PROMPT_VERSION,
    system: 'Choose how this townsperson answers a hearing summons. Return only JSON {"response":...}.',
    user: input.text,
    maxTokens: 50,
    seed: deriveSeed(input.worldId, input.commandSeq, 'attendance'),
    choices: { responses: ATTENDANCE_RESPONSES },
  });
  return {
    response: parseAttendance(response.text),
    locationId,
    locationKey,
    dueTick,
    rejectedReason: null,
    inputHash,
    modelId: response.modelId,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    latencyMs: response.latencyMs,
  };
}

export async function applySummon(
  client: Client,
  input: {
    worldId: string;
    playerId: string;
    agentId: string;
    agentName: string;
    agentLocationId: string;
    tick: number;
    seq: Seq;
    decision: SummonDecision;
  },
): Promise<{ hearingId: string | null; rejectedReason: string | null }> {
  const decision = input.decision;
  await client.query(
    `INSERT INTO cognition_records
       (world_id, tick, agent_id, task, input_hash, decision, model_id, prompt_version,
        tokens_in, tokens_out, latency_ms)
     VALUES ($1, $2, $3, 'attendance', $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.worldId,
      input.tick,
      input.agentId,
      decision.inputHash,
      JSON.stringify({ response: decision.response, locationKey: decision.locationKey, dueTick: decision.dueTick }),
      decision.modelId,
      ATTENDANCE_PROMPT_VERSION,
      decision.tokensIn,
      decision.tokensOut,
      decision.latencyMs,
    ],
  );
  await recordUsage(client, input.worldId, {
    calls: decision.modelId === 'deterministic-fallback' ? 0 : 1,
    tokensIn: decision.tokensIn,
    tokensOut: decision.tokensOut,
    billable: decision.modelId !== 'deterministic-fallback' && !decision.modelId.includes('stub'),
  });
  if (decision.rejectedReason) return { hearingId: null, rejectedReason: decision.rejectedReason };

  let hearing = await client.query<{ hearing_id: string }>(
    `SELECT hearing_id FROM world_hearings
      WHERE world_id = $1 AND convener_id = $2 AND location_id = $3 AND due_tick = $4
        AND status IN ('announced', 'gathering')
      ORDER BY hearing_id LIMIT 1`,
    [input.worldId, input.playerId, decision.locationId, decision.dueTick],
  );
  if (!hearing.rows[0]) {
    hearing = await client.query<{ hearing_id: string }>(
      `INSERT INTO world_hearings
         (world_id, convener_id, location_id, due_tick, status, announced_tick)
       VALUES ($1, $2, $3, $4, 'announced', $5)
       RETURNING hearing_id`,
      [input.worldId, input.playerId, decision.locationId, decision.dueTick, input.tick],
    );
  }
  const hearingId = hearing.rows[0]!.hearing_id;
  await client.query(
    `INSERT INTO world_agent_commitments
       (world_id, agent_id, hearing_id, location_id, due_tick, source, response, status, created_tick)
     VALUES ($1, $2, $3, $4, $5, 'player', $6, $7, $8)
     ON CONFLICT (world_id, agent_id, due_tick) DO NOTHING`,
    [
      input.worldId,
      input.agentId,
      hearingId,
      input.agentLocationId,
      decision.dueTick,
      decision.response,
      'pending',
      input.tick,
    ],
  );
  await client.query(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, kind, payload, description)
     VALUES ($1, $2, $3, $4, 'player_command', $5, $6)`,
    [
      input.worldId,
      input.tick,
      input.seq.next(),
      decision.locationId,
      JSON.stringify({ hearingId, summonedAgentId: input.agentId, dueTick: decision.dueTick }),
      `${input.agentName} is summoned to a hearing at ${decision.locationKey}.`,
    ],
  );

  if (decision.response === 'come_but_tell_someone') {
    await client.query(
      `INSERT INTO world_events
         (world_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
       SELECT $1, $2, $3, culprit.location_id, $4, 'dialogue', $5,
              $6
         FROM world_culprit wc
         JOIN world_agents culprit ON culprit.world_id = wc.world_id AND culprit.agent_id = wc.agent_id
        WHERE wc.world_id = $1`,
      [
        input.worldId,
        input.tick,
        input.seq.next(),
        input.agentId,
        JSON.stringify({ hearingId, leaked: true, dueTick: decision.dueTick }),
        `Word of the hearing reaches the wrong ears.`,
      ],
    );
  }
  return { hearingId, rejectedReason: null };
}

export async function queueHearingReveal(
  client: Client,
  input: { worldId: string; playerId: string; locationId: string; claimId: string },
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE world_hearings SET reveal_claim_id = $4
      WHERE world_id = $1 AND convener_id = $2 AND location_id = $3
        AND status IN ('announced', 'gathering', 'in_session')
      RETURNING hearing_id`,
    [input.worldId, input.playerId, input.locationId, input.claimId],
  );
  return (updated.rowCount ?? 0) > 0;
}

export interface HearingResult {
  resolved: number;
  beliefUpdates: number;
  tensionDelta: Fixed;
}

export async function runHearings(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq },
): Promise<HearingResult> {
  await client.query(
    `UPDATE world_hearings SET status = 'gathering'
      WHERE world_id = $1 AND status = 'announced' AND due_tick > $2`,
    [input.worldId, input.tick],
  );
  await client.query(
    `UPDATE world_hearings SET status = 'in_session'
      WHERE world_id = $1 AND status IN ('announced', 'gathering') AND due_tick <= $2`,
    [input.worldId, input.tick],
  );

  const hearings = await client.query<{
    hearing_id: string;
    convener_id: string;
    location_id: string;
    due_tick: number;
    reveal_claim_id: string;
    claim_key: string;
    severity: number;
    subject_faction_id: string;
  }>(
    `SELECT h.hearing_id, h.convener_id, h.location_id, h.due_tick,
            h.reveal_claim_id, c.claim_key, c.severity,
            subject.faction_id AS subject_faction_id
       FROM world_hearings h
       JOIN world_claims c
         ON c.world_id = h.world_id AND c.claim_id = h.reveal_claim_id AND NOT c.locked
       JOIN world_agents subject
         ON subject.world_id = c.world_id AND subject.agent_id = c.subject_agent_id
      WHERE h.world_id = $1 AND h.status = 'in_session' AND h.due_tick <= $2
      ORDER BY h.due_tick, h.hearing_id`,
    [input.worldId, input.tick],
  );

  const result: HearingResult = { resolved: 0, beliefUpdates: 0, tensionDelta: 0 };
  for (const hearing of hearings.rows) {
    const listeners = await client.query<{
      agent_id: string;
      faction_id: string;
      trust: number;
      reputation: number;
      confidence: number | null;
    }>(
      `SELECT a.agent_id, a.faction_id,
              5000::INT8 AS trust,
              COALESCE(rep.reputation, 0) AS reputation,
              b.confidence
         FROM world_agent_commitments commitment
         JOIN world_agents a
           ON a.world_id = commitment.world_id AND a.agent_id = commitment.agent_id
          AND a.location_id = commitment.location_id AND a.status = 'alive'
         LEFT JOIN player_reputation rep
           ON rep.world_id = a.world_id AND rep.player_id = $3 AND rep.faction_id = a.faction_id
         LEFT JOIN agent_beliefs b
           ON b.world_id = a.world_id AND b.agent_id = a.agent_id AND b.claim_id = $4
        WHERE commitment.world_id = $1 AND commitment.hearing_id = $2
          AND commitment.status = 'pending'
          AND commitment.response IN ('come', 'come_but_tell_someone')
        ORDER BY a.agent_key`,
      [input.worldId, hearing.hearing_id, hearing.convener_id, hearing.reveal_claim_id],
    );
    for (const listener of listeners.rows) {
      const persuasion = persuasionStrength(listener.reputation, listener.trust);
      const direction = listener.faction_id === hearing.subject_faction_id ? 7_000 : SCALE;
      const delta = fpMul(persuasion, direction);
      const confidence = clampSigned((listener.confidence ?? 0) + delta);
      await recordBelief(client, {
        worldId: input.worldId,
        agentId: listener.agent_id,
        claimId: hearing.reveal_claim_id,
        tick: input.tick,
        seq: input.seq.next(),
        confidence,
      });
      result.beliefUpdates++;
      result.tensionDelta += fpMul(TENSION.publicAccusation, hearing.severity);
    }
    await client.query(
      `UPDATE world_agent_commitments commitment
          SET status = CASE WHEN EXISTS (
            SELECT 1 FROM world_agents a
             WHERE a.world_id = commitment.world_id AND a.agent_id = commitment.agent_id
               AND a.location_id = commitment.location_id
          ) AND response != 'decline' THEN 'kept' ELSE 'broken' END
        WHERE commitment.world_id = $1 AND commitment.hearing_id = $2`,
      [input.worldId, hearing.hearing_id],
    );
    await client.query(
      `UPDATE world_hearings SET status = 'resolved', resolved_tick = $3
        WHERE world_id = $1 AND hearing_id = $2`,
      [input.worldId, hearing.hearing_id, input.tick],
    );
    await client.query(
      `INSERT INTO world_events
         (world_id, tick, seq, location_id, kind, payload, description)
       VALUES ($1, $2, $3, $4, 'accusation', $5, $6)`,
      [
        input.worldId,
        input.tick,
        input.seq.next(),
        hearing.location_id,
        JSON.stringify({ hearingId: hearing.hearing_id, claimKey: hearing.claim_key }),
        `The evidence is presented to the hearing: ${hearing.claim_key.replace(/_/g, ' ')}.`,
      ],
    );
    result.resolved++;
  }

  await client.query(
    `UPDATE world_agent_commitments commitment SET status = 'broken'
      WHERE commitment.world_id = $1 AND commitment.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM world_hearings h
           WHERE h.world_id = commitment.world_id AND h.hearing_id = commitment.hearing_id
             AND h.status = 'in_session' AND h.reveal_claim_id IS NULL
             AND h.due_tick + $3 < $2
        )`,
    [input.worldId, input.tick, HEARING.holdTicks],
  );
  await client.query(
    `UPDATE world_hearings SET status = 'abandoned', resolved_tick = $2
      WHERE world_id = $1 AND status = 'in_session' AND reveal_claim_id IS NULL
        AND due_tick + $3 < $2`,
    [input.worldId, input.tick, HEARING.holdTicks],
  );
  result.tensionDelta = clampUnit(result.tensionDelta);
  return result;
}

export function persuasionStrength(reputation: Fixed, trust: Fixed): Fixed {
  const reputationFactor = clampUnit(5_000 + Math.trunc(reputation / 2));
  const trustFactor = clampUnit(5_000 + Math.trunc(trust / 2));
  return Math.min(BELIEF.maxShiftPerTransmission, fpMul(fpMul(CONVERSE.persuasion, reputationFactor), trustFactor));
}

function parseAttendance(text: string): AttendanceResponse {
  try {
    const value = JSON.parse(text) as { response?: unknown };
    if (typeof value.response === 'string' && ATTENDANCE_RESPONSES.includes(value.response as AttendanceResponse)) {
      return value.response as AttendanceResponse;
    }
  } catch {
    // Unknown model output declines safely.
  }
  return 'decline';
}

function resolveLocationKey(text: string, graph: RouteGraph): string {
  const lowered = text.toLowerCase();
  for (const key of [...graph.idByKey.keys()].sort()) {
    if (lowered.includes(key.replace(/_/g, ' ')) || lowered.includes(key)) return key;
  }
  return graph.idByKey.has('plaza') ? 'plaza' : [...graph.idByKey.keys()].sort()[0]!;
}

function shortestCost(graph: RouteGraph, from: string, to: string): number {
  if (from === to) return 0;
  const distance = new Map<string, number>([[from, 0]]);
  const visited = new Set<string>();
  for (;;) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [node, cost] of distance) {
      if (!visited.has(node) && cost < best) {
        current = node;
        best = cost;
      }
    }
    if (current === null) return Number.MAX_SAFE_INTEGER;
    if (current === to) return best;
    visited.add(current);
    for (const edge of graph.edges.get(current) ?? []) {
      const candidate = best + edge.cost;
      if (candidate < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.to, candidate);
      }
    }
  }
}
