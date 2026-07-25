import { createHash } from 'node:crypto';

import { estimateCostMicros, readBudget, recordUsage } from './budget.ts';
import { recordBelief } from './beliefs.ts';
import { SCHEME } from './config.ts';
import type { Client } from './db.ts';
import { isBillableInferenceMode, type InferenceClient } from './inference/index.ts';
import type { RouteGraph } from './movement.ts';
import type { Rng } from './rng.ts';
import type { Seq } from './seq.ts';
import { evaluateCondition, loadTriggerFacts } from './triggers.ts';
import type { Condition, SchemeTactic } from '../scenario/schema.ts';
import type { EscalationStage } from './tension.ts';
import type { Fixed } from './fixedpoint.ts';
import { seedRumor } from './gossip.ts';
import { loadAgentGoals } from './goals.ts';
import { stableId } from './ids.ts';

export const STRATEGY_PROMPT_VERSION = 'strategy-v1';
export const POSTURES = ['press', 'lie_low', 'redirect', 'force'] as const;
export type Posture = typeof POSTURES[number];

interface SchemeTemplate {
  scheme_key: string;
  ladder_index: number;
  tactic: SchemeTactic;
  audience: string;
  claim_key: string | null;
  condition: Condition;
}

export interface SchemeDecision {
  agentId: string;
  tactic: SchemeTactic;
  targetAgentId: string;
  claimId: string;
  posture: Posture;
  ladderIndex: number;
  inputHash: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export async function thinkStrategy(
  client: Client,
  input: {
    worldId: string;
    tick: number;
    seed: number;
    rng: Rng;
    graph: RouteGraph;
    stage: EscalationStage;
    globalTension: Fixed;
    peaceStreak: number;
    inference: InferenceClient;
    replay?: boolean;
  },
): Promise<SchemeDecision | null> {
  const state = await client.query<{
    agent_id: string;
    agent_key: string;
    location_id: string;
    posture: Posture;
    ladder_index: number;
    next_strategy_tick: number;
    motive_key: string;
  }>(
    `SELECT s.agent_id, a.agent_key, a.location_id, s.posture,
            s.ladder_index, s.next_strategy_tick, wc.motive_key
       FROM world_scheme_state s
       JOIN world_agents a ON a.world_id = s.world_id AND a.agent_id = s.agent_id
       JOIN world_culprit wc ON wc.world_id = s.world_id AND wc.agent_id = s.agent_id
      WHERE s.world_id = $1 AND a.status = 'alive'`,
    [input.worldId],
  );
  const schemer = state.rows[0];
  if (!schemer || input.tick < schemer.next_strategy_tick) return null;

  const facts = await loadTriggerFacts(client, {
    worldId: input.worldId,
    tick: input.tick,
    globalTension: input.globalTension,
    stage: input.stage,
    peaceStreak: input.peaceStreak,
  });
  const templates = await client.query<SchemeTemplate>(
    `SELECT st.scheme_key, st.ladder_index, st.tactic, st.audience, st.claim_key, st.condition
       FROM scheme_templates st
       JOIN worlds w ON w.scenario_version_id = st.scenario_version_id
      WHERE w.world_id = $1
      ORDER BY st.ladder_index, st.scheme_key`,
    [input.worldId],
  );
  const eligible = templates.rows.filter((scheme) => evaluateCondition(scheme.condition, facts));
  if (eligible.length === 0) return null;

  const fallback = eligible.find((scheme) => scheme.ladder_index === schemer.ladder_index);
  const targetRows = await loadTargets(client, input.worldId, schemer.agent_id, schemer.location_id, input.graph);
  if (targetRows.length === 0) return null;
  const claims = await loadClaims(client, input.worldId, eligible);
  if (claims.length === 0) return null;
  const goals = (await loadAgentGoals(client, input.worldId, schemer.agent_id))
    .filter((goal) => goal.status === 'active');
  const beliefs = await loadStrategyBeliefs(client, input.worldId, schemer.agent_id);

  const heat = await heatOnCulprit(client, input.worldId, schemer.agent_id);
  const inputHash = createHash('sha256').update(JSON.stringify({
    tick: input.tick,
    agentKey: schemer.agent_key,
    stage: input.stage,
    posture: schemer.posture,
    ladderIndex: schemer.ladder_index,
    heat,
    tactics: eligible.map((s) => s.tactic),
    targets: targetRows.map((row) => row.agent_key),
    claims: claims.map((row) => row.claim_key),
    motive: schemer.motive_key,
    goals: goals.map((goal) => [goal.key, goal.priority]),
    beliefs,
  })).digest('hex');

  if (input.replay) {
    return loadRecordedStrategy(client, input.worldId, input.tick, schemer.agent_id, inputHash);
  }

  const budget = await readBudget(client, input.worldId);
  if (input.inference.mode === 'stub' || budget.exhausted) {
    if (!fallback) return null;
    const target = chooseTargetForTemplate(fallback, targetRows) ?? targetRows[0]!;
    const claim = claims.find((row) => row.claim_key === fallback.claim_key) ?? claims[0]!;
    return {
      agentId: schemer.agent_id,
      tactic: fallback.tactic,
      targetAgentId: target.agent_id,
      claimId: claim.claim_id,
      posture: schemer.posture,
      ladderIndex: fallback.ladder_index,
      inputHash,
      modelId: 'deterministic-fallback',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
    };
  }

  const response = await input.inference.complete({
    task: 'strategy',
    promptVersion: STRATEGY_PROMPT_VERSION,
    system:
      'Privately choose the next move for a concealed instigator. Return only JSON with ' +
      'tactic, target, claim, and posture chosen from the supplied options.',
    user:
      `Motive: ${schemer.motive_key}. Goals: ${goals.map((goal) => goal.key).join(', ') || 'none'}. ` +
      `Stage: ${input.stage}. Heat on you: ${heat}. Current posture: ${schemer.posture}. ` +
      `Current beliefs: ${beliefs.map((belief) => `${belief.claim_key}:${belief.confidence}`).join(', ') || 'none'}. ` +
      `Reachable people: ${targetRows.map((target) =>
        `${target.agent_key} (${target.faction_key}, ${target.location_key})`).join(', ')}.`,
    maxTokens: 120,
    seed: input.rng.nextU32(),
    choices: {
      tactics: eligible.map((scheme) => scheme.tactic),
      targets: targetRows.map((row) => row.agent_key),
      claims: claims.map((row) => row.claim_key),
      postures: POSTURES,
    },
  });
  const parsed = parseStrategy(response.text, eligible, targetRows, claims, schemer.posture);
  if (!parsed) return null;
  await recordUsage(client, input.worldId, {
    calls: 1,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    billable: isBillableInferenceMode(input.inference.mode),
  });
  return {
    agentId: schemer.agent_id,
    ...parsed,
    inputHash,
    modelId: response.modelId,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    latencyMs: response.latencyMs,
  };
}

export async function applyStrategy(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq; decision: SchemeDecision | null },
): Promise<void> {
  const decision = input.decision;
  if (!decision) return;
  await client.query(
    `INSERT INTO cognition_records
       (world_id, tick, agent_id, task, input_hash, decision, model_id, prompt_version,
        tokens_in, tokens_out, latency_ms)
     VALUES ($1, $2, $3, 'strategy', $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.worldId,
      input.tick,
      decision.agentId,
      decision.inputHash,
      JSON.stringify({
        tactic: decision.tactic,
        targetAgentId: decision.targetAgentId,
        claimId: decision.claimId,
        posture: decision.posture,
        ladderIndex: decision.ladderIndex,
      }),
      decision.modelId,
      STRATEGY_PROMPT_VERSION,
      decision.tokensIn,
      decision.tokensOut,
      decision.latencyMs,
    ],
  );
  if (decision.modelId !== 'deterministic-fallback' && decision.modelId !== 'replay') {
    const sourceKey = String(input.tick);
    await client.query(
      `INSERT INTO world_inference_usage
         (world_id, usage_id, category, source_key, model_id, calls, tokens_in, tokens_out,
          est_cost_micros)
       VALUES ($1, $2, 'instigator', $3, $4, 1, $5, $6, $7)
       ON CONFLICT (world_id, category, source_key, attempt) DO NOTHING`,
      [input.worldId, stableId(input.worldId, 'instigator', sourceKey), sourceKey,
        decision.modelId, decision.tokensIn, decision.tokensOut,
        estimateCostMicros({
          calls: 1,
          tokensIn: decision.tokensIn,
          tokensOut: decision.tokensOut,
          billable: !decision.modelId.includes('stub'),
        })],
    );
  }
  await client.query(
    `UPDATE world_scheme_state
        SET posture = $3, ladder_index = $4, current_tactic = $5,
            target_agent_id = $6, claim_id = $7, executes_until = $8,
            next_strategy_tick = $9, updated_tick = $2
      WHERE world_id = $1 AND agent_id = $10`,
    [
      input.worldId,
      input.tick,
      decision.posture,
      decision.ladderIndex + 1,
      decision.tactic,
      decision.targetAgentId,
      decision.claimId,
      input.tick + SCHEME.tacticDurationTicks,
      input.tick + SCHEME.strategyIntervalTicks,
      decision.agentId,
    ],
  );
  const claim = await client.query<{ text: string; severity: number }>(
    `SELECT text, severity FROM world_claims
      WHERE world_id = $1 AND claim_id = $2 AND NOT locked`,
    [input.worldId, decision.claimId],
  );
  if (claim.rows[0]) {
    await seedRumor(client, {
      worldId: input.worldId,
      tick: input.tick,
      seq: input.seq,
      claimId: decision.claimId,
      originAgentId: decision.agentId,
      heat: SCHEME.rumorHeat,
      valence: -claim.rows[0].severity,
      text: claim.rows[0].text,
    });
    await recordBelief(client, {
      worldId: input.worldId,
      agentId: decision.agentId,
      claimId: decision.claimId,
      tick: input.tick,
      seq: input.seq.next(),
      confidence: -SCHEME.rumorHeat,
    });
  }
}

function parseStrategy(
  text: string,
  schemes: readonly SchemeTemplate[],
  targets: readonly { agent_id: string; agent_key: string; faction_key: string; location_key: string }[],
  claims: readonly { claim_id: string; claim_key: string }[],
  previousPosture: Posture,
): Omit<SchemeDecision, 'agentId' | 'inputHash' | 'modelId' | 'tokensIn' | 'tokensOut' | 'latencyMs'> | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const scheme = schemes.find((item) => item.tactic === parsed.tactic);
    const target = targets.find((item) => item.agent_key === parsed.target);
    const claim = claims.find((item) => item.claim_key === parsed.claim);
    if (!scheme || !target || !claim) return null;
    const posture = typeof parsed.posture === 'string' && POSTURES.includes(parsed.posture as Posture)
      ? parsed.posture as Posture
      : previousPosture;
    return {
      tactic: scheme.tactic,
      targetAgentId: target.agent_id,
      claimId: claim.claim_id,
      posture,
      ladderIndex: scheme.ladder_index,
    };
  } catch {
    return null;
  }
}

async function loadTargets(
  client: Client,
  worldId: string,
  culpritId: string,
  locationId: string,
  graph: RouteGraph,
) {
  const reachable = [locationId, ...(graph.edges.get(locationId) ?? []).map((edge) => edge.to)];
  const result = await client.query<{
    agent_id: string; agent_key: string; faction_key: string; location_key: string;
  }>(
    `SELECT a.agent_id, a.agent_key, f.faction_key, l.location_key
       FROM world_agents a
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
       JOIN world_locations l ON l.world_id = a.world_id AND l.location_id = a.location_id
      WHERE a.world_id = $1 AND a.agent_id != $2 AND a.status = 'alive'
        AND a.location_id = ANY($3::UUID[])
      ORDER BY a.agent_key`,
    [worldId, culpritId, reachable],
  );
  return result.rows;
}

async function loadClaims(client: Client, worldId: string, schemes: readonly SchemeTemplate[]) {
  const keys = [...new Set(schemes.map((scheme) => scheme.claim_key).filter((key): key is string => Boolean(key)))];
  if (keys.length === 0) return [];
  const result = await client.query<{ claim_id: string; claim_key: string }>(
    `SELECT claim_id, claim_key FROM world_claims
      WHERE world_id = $1 AND claim_key = ANY($2::STRING[]) AND NOT locked
      ORDER BY claim_key`,
    [worldId, keys],
  );
  return result.rows;
}

async function loadStrategyBeliefs(client: Client, worldId: string, agentId: string) {
  const result = await client.query<{ claim_key: string; confidence: number }>(
    `SELECT c.claim_key, b.confidence
       FROM agent_beliefs b
       JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
      WHERE b.world_id = $1 AND b.agent_id = $2 AND NOT c.locked
      ORDER BY abs(b.confidence) DESC, c.claim_key LIMIT 8`,
    [worldId, agentId],
  );
  return result.rows;
}

function chooseTargetForTemplate<T extends { faction_key: string; location_key: string }>(
  scheme: SchemeTemplate,
  targets: readonly T[],
): T | null {
  return targets.find((target) =>
    target.faction_key === scheme.audience || target.location_key === scheme.audience) ?? null;
}

async function heatOnCulprit(client: Client, worldId: string, culpritId: string): Promise<number> {
  const result = await client.query<{ heat: number }>(
    `SELECT LEAST(10000,
       COALESCE((SELECT count(*) * 800 FROM world_player_evidence
                  WHERE world_id = $1 AND accused_id = $2), 0) +
       COALESCE((SELECT count(*) * 600 FROM world_events e
                  JOIN world_agents culprit
                    ON culprit.world_id = e.world_id AND culprit.agent_id = $2
                 WHERE e.world_id = $1 AND e.location_id = culprit.location_id
                   AND (e.payload->>'leaked' = 'true'
                        OR e.payload->>'hearingId' IS NOT NULL)), 0) +
       COALESCE((SELECT avg(b.confidence)::INT8
                   FROM agent_beliefs b
                   JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
                  WHERE b.world_id = $1 AND c.claim_key = 'instigator_exposed'), 0)
     )::INT8 AS heat`,
    [worldId, culpritId],
  );
  return result.rows[0]?.heat ?? 0;
}

async function loadRecordedStrategy(
  client: Client,
  worldId: string,
  tick: number,
  agentId: string,
  inputHash: string,
): Promise<SchemeDecision | null> {
  const result = await client.query<{
    input_hash: string;
    prompt_version: string;
    decision: { tactic: SchemeTactic; targetAgentId: string; claimId: string; posture: Posture; ladderIndex: number };
  }>(
    `SELECT input_hash, prompt_version, decision FROM cognition_records
      WHERE world_id = $1 AND tick = $2 AND agent_id = $3 AND task = 'strategy'
      LIMIT 1`,
    [worldId, tick, agentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`replay: no strategy record at tick ${tick}`);
  if (row.prompt_version !== STRATEGY_PROMPT_VERSION || row.input_hash !== inputHash) {
    throw new Error(`replay: strategy inputs changed at tick ${tick}`);
  }
  return {
    agentId,
    ...row.decision,
    inputHash,
    modelId: 'replay',
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
  };
}
