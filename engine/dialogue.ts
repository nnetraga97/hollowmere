import { createHash } from 'node:crypto';

import { BELIEF, DIALOGUE, GOSSIP } from './config.ts';
import { recordBelief, shiftConfidence } from './beliefs.ts';
import { estimateCostMicros, readBudget, recordUsage } from './budget.ts';
import type { Client } from './db.ts';
import { recordTelling } from './gossip.ts';
import type { InferenceClient } from './inference/index.ts';
import type { Rng } from './rng.ts';
import type { Seq } from './seq.ts';
import { stableId } from './ids.ts';

export const SPEECH_PROMPT_VERSION = 'speech-v2';

export interface DialogueDecision {
  fromAgentId: string;
  fromAgentKey: string;
  fromName: string;
  toAgentId: string;
  toAgentKey: string;
  toName: string;
  locationId: string;
  rumorId: string;
  claimId: string;
  claimKey: string;
  claimText: string;
  line: string;
  response: string;
  tactic: string | null;
  inputHash: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

interface PairRow {
  from_agent_id: string;
  from_agent_key: string;
  from_name: string;
  to_agent_id: string;
  to_agent_key: string;
  to_name: string;
  location_id: string;
  rumor_id: string;
  claim_id: string;
  claim_key: string;
  claim_text: string;
  tactic: string | null;
}

export async function thinkDialogue(
  client: Client,
  input: {
    worldId: string;
    tick: number;
    rng: Rng;
    inference: InferenceClient;
    replay?: boolean;
  },
): Promise<DialogueDecision | null> {
  if (input.tick % DIALOGUE.intervalTicks !== 0) return null;

  // The draw is unconditional even though ordering supplies the fallback pair.
  // That keeps the dialogue stream stable when replay skips inference.
  const draw = input.rng.nextU32();
  const pairs = await loadPairs(client, input.worldId, input.tick);
  if (pairs.length === 0) return null;
  const instigator = pairs.find((pair) => pair.tactic !== null);
  const pair = instigator ?? pairs[draw % pairs.length]!;
  const inputHash = createHash('sha256').update(JSON.stringify({
    tick: input.tick,
    from: pair.from_agent_key,
    to: pair.to_agent_key,
    claim: pair.claim_key,
    tactic: pair.tactic,
  })).digest('hex');

  if (input.replay) return loadRecordedDialogue(client, input.worldId, input.tick, pair, inputHash);

  const budget = await readBudget(client, input.worldId);
  if (budget.exhausted) {
    return makeDecision(pair, inputHash, `I heard ${pair.claim_text.toLowerCase()}`,
      'I will remember what you said.', 'deterministic-fallback');
  }

  const response = await input.inference.complete({
    task: 'npc_conversation',
    promptVersion: SPEECH_PROMPT_VERSION,
    system:
      `Write a brief exchange between ${pair.from_name} and ${pair.to_name}. ` +
      'Return JSON only: {"utterance":string,"response":string}. The first speaker carries ' +
      'the supplied claim. Do not name a source unless directed.',
    user: pair.tactic
      ? `Directive: ${pair.tactic}. Claim to convey: ${pair.claim_text}`
      : `Claim to convey: ${pair.claim_text}`,
    maxTokens: 100,
    seed: draw,
  });
  const exchange = parseExchange(response.text, pair.claim_text);
  return {
    ...makeDecision(pair, inputHash, exchange.utterance, exchange.response, response.modelId),
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    latencyMs: response.latencyMs,
  };
}

export async function applyDialogue(
  client: Client,
  input: { worldId: string; tick: number; seq: Seq; decision: DialogueDecision | null },
): Promise<number> {
  const decision = input.decision;
  if (!decision) return 0;

  await client.query(
    `INSERT INTO cognition_records
       (world_id, tick, agent_id, task, input_hash, decision, model_id, prompt_version,
        tokens_in, tokens_out, latency_ms)
     VALUES ($1, $2, $3, 'dialogue', $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.worldId,
      input.tick,
      decision.fromAgentId,
      decision.inputHash,
      JSON.stringify(decision),
      decision.modelId,
      SPEECH_PROMPT_VERSION,
      decision.tokensIn,
      decision.tokensOut,
      decision.latencyMs,
    ],
  );
  const event = await client.query<{ event_id: string }>(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
     VALUES ($1, $2, $3, $4, $5, 'dialogue', $6, $7)
     RETURNING event_id`,
    [
      input.worldId,
      input.tick,
      input.seq.next(),
      decision.locationId,
      decision.fromAgentId,
      JSON.stringify({
        toAgentKey: decision.toAgentKey,
        claimKey: decision.claimKey,
        tactic: decision.tactic,
      }),
      `${decision.fromName}: ${decision.line}`,
    ],
  );
  await client.query(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
     VALUES ($1, $2, $3, $4, $5, 'dialogue', $6, $7)`,
    [input.worldId, input.tick, input.seq.next(), decision.locationId, decision.toAgentId,
      JSON.stringify({ toAgentKey: decision.fromAgentKey, responseToEventId: event.rows[0]!.event_id }),
      `${decision.toName}: ${decision.response}`],
  );

  await client.query(
    `INSERT INTO world_rumor_spread
       (world_id, rumor_id, agent_id, received_tick, distorted_text, from_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (world_id, rumor_id, agent_id) DO NOTHING`,
    [
      input.worldId,
      decision.rumorId,
      decision.toAgentId,
      input.tick,
      decision.line,
      decision.fromAgentId,
    ],
  );
  await recordTelling(client, {
    worldId: input.worldId,
    rumorId: decision.rumorId,
    claimId: decision.claimId,
    fromAgentId: decision.fromAgentId,
    toAgentId: decision.toAgentId,
    eventId: event.rows[0]!.event_id,
    tick: input.tick,
    seq: input.seq.next(),
    channel: 'dialogue',
  });

  if (decision.tactic !== null) {
    await recordBelief(client, {
      worldId: input.worldId,
      agentId: decision.fromAgentId,
      claimId: decision.claimId,
      tick: input.tick,
      seq: input.seq.next(),
      confidence: -SCHEME_BELIEF,
      causeEventId: event.rows[0]!.event_id,
    });
  }

  const listener = await client.query<{
    credulity: number;
    trust: number;
    confidence: number | null;
    same_faction: boolean;
  }>(
    `SELECT a.credulity, COALESCE(rel.trust, 5000) AS trust, b.confidence,
            (a.faction_id = subject.faction_id) AS same_faction
       FROM world_agents a
       JOIN world_claims c ON c.world_id = a.world_id AND c.claim_id = $3
       JOIN world_agents subject ON subject.world_id = c.world_id AND subject.agent_id = c.subject_agent_id
       LEFT JOIN world_relationships rel
         ON rel.world_id = a.world_id AND rel.src_agent_id = a.agent_id AND rel.dst_agent_id = $4
       LEFT JOIN agent_beliefs b
         ON b.world_id = a.world_id AND b.agent_id = a.agent_id AND b.claim_id = c.claim_id
      WHERE a.world_id = $1 AND a.agent_id = $2`,
    [input.worldId, decision.toAgentId, decision.claimId, decision.fromAgentId],
  );
  const row = listener.rows[0];
  if (row) {
    const confidence = shiftConfidence({
      current: row.confidence ?? 0,
      credulity: row.credulity,
      trust: row.trust,
      heat: GOSSIP.minHeat,
      alignment: row.same_faction ? 'same' : 'rival',
    });
    await recordBelief(client, {
      worldId: input.worldId,
      agentId: decision.toAgentId,
      claimId: decision.claimId,
      tick: input.tick,
      seq: input.seq.next(),
      confidence,
      causeEventId: event.rows[0]!.event_id,
    });
    await client.query(
      `UPDATE world_relationships
          SET trust = LEAST(10000, trust + $4), updated_tick = $5
        WHERE world_id = $1 AND src_agent_id = $2 AND dst_agent_id = $3`,
      [input.worldId, decision.toAgentId, decision.fromAgentId, DIALOGUE.trustShift, input.tick],
    );
  }
  await recordUsage(client, input.worldId, {
    calls: decision.modelId === 'deterministic-fallback' || decision.modelId === 'replay' ? 0 : 1,
    tokensIn: decision.tokensIn,
    tokensOut: decision.tokensOut,
    billable: decision.modelId !== 'deterministic-fallback' &&
      decision.modelId !== 'replay' && !decision.modelId.includes('stub'),
  });
  if (decision.modelId !== 'deterministic-fallback' && decision.modelId !== 'replay') {
    const sourceKey = `${input.tick}:${decision.fromAgentKey}:${decision.toAgentKey}`;
    await client.query(
      `INSERT INTO world_inference_usage
         (world_id, usage_id, category, source_key, model_id, tokens_in, tokens_out,
          est_cost_micros)
       VALUES ($1, $2, 'npc_dialogue', $3, $4, $5, $6, $7)
       ON CONFLICT (world_id, category, source_key, attempt) DO NOTHING`,
      [input.worldId, stableId(input.worldId, 'npc_dialogue', sourceKey), sourceKey,
        decision.modelId, decision.tokensIn, decision.tokensOut,
        estimateCostMicros({ calls: 1, tokensIn: decision.tokensIn,
          tokensOut: decision.tokensOut, billable: !decision.modelId.includes('stub') })],
    );
  }
  return 1;
}

const SCHEME_BELIEF = 7_200;

function makeDecision(
  pair: PairRow,
  inputHash: string,
  line: string,
  response: string,
  modelId: string,
): DialogueDecision {
  return {
    fromAgentId: pair.from_agent_id,
    fromAgentKey: pair.from_agent_key,
    fromName: pair.from_name,
    toAgentId: pair.to_agent_id,
    toAgentKey: pair.to_agent_key,
    toName: pair.to_name,
    locationId: pair.location_id,
    rumorId: pair.rumor_id,
    claimId: pair.claim_id,
    claimKey: pair.claim_key,
    claimText: pair.claim_text,
    line,
    response,
    tactic: pair.tactic,
    inputHash,
    modelId,
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
  };
}

function parseExchange(text: string, fallback: string): { utterance: string; response: string } {
  try {
    const value = JSON.parse(text) as { utterance?: unknown; response?: unknown };
    if (typeof value.utterance === 'string' && value.utterance.trim() &&
        typeof value.response === 'string' && value.response.trim()) {
      return { utterance: value.utterance.trim(), response: value.response.trim() };
    }
  } catch { /* deterministic fallback below */ }
  return { utterance: fallback, response: 'I will remember what you said.' };
}

async function loadPairs(client: Client, worldId: string, tick: number): Promise<PairRow[]> {
  const result = await client.query<PairRow>(
    `WITH instigator AS (
       SELECT s.agent_id AS from_agent_id, target.agent_id AS to_agent_id,
              s.claim_id, s.current_tactic AS tactic
         FROM world_scheme_state s
         JOIN world_agents culprit
           ON culprit.world_id = s.world_id AND culprit.agent_id = s.agent_id AND culprit.status = 'alive'
         JOIN world_agents target
           ON target.world_id = s.world_id AND target.agent_id = s.target_agent_id
          AND target.status = 'alive'
        WHERE s.world_id = $1 AND s.executes_until >= $2 AND s.posture != 'lie_low'
     ), ambient AS (
       SELECT holder.agent_id AS from_agent_id, listener.agent_id AS to_agent_id,
              r.claim_id, NULL::STRING AS tactic
         FROM world_rumor_spread spread
         JOIN world_rumors r
           ON r.world_id = spread.world_id AND r.rumor_id = spread.rumor_id AND r.heat >= $3
         JOIN world_agents holder
           ON holder.world_id = spread.world_id AND holder.agent_id = spread.agent_id
          AND holder.status = 'alive'
         JOIN world_agents listener
           ON listener.world_id = holder.world_id AND listener.location_id = holder.location_id
          AND listener.agent_id != holder.agent_id AND listener.status = 'alive'
         LEFT JOIN agent_beliefs b
           ON b.world_id = listener.world_id AND b.agent_id = listener.agent_id AND b.claim_id = r.claim_id
        WHERE spread.world_id = $1
          AND (b.updated_tick IS NULL OR b.updated_tick <= $2 - $4)
     ), candidates AS (
       SELECT * FROM instigator
       UNION ALL
       SELECT * FROM ambient
     )
     SELECT sender.agent_id AS from_agent_id, sender.agent_key AS from_agent_key,
            sender.name AS from_name, receiver.agent_id AS to_agent_id,
            receiver.agent_key AS to_agent_key, receiver.name AS to_name,
            sender.location_id, r.rumor_id, c.claim_id, c.claim_key,
            c.text AS claim_text, candidates.tactic
       FROM candidates
       JOIN world_agents sender
         ON sender.world_id = $1 AND sender.agent_id = candidates.from_agent_id
       JOIN world_agents receiver
         ON receiver.world_id = $1 AND receiver.agent_id = candidates.to_agent_id
       JOIN world_claims c
         ON c.world_id = $1 AND c.claim_id = candidates.claim_id AND NOT c.locked
       JOIN world_rumors r ON r.world_id = c.world_id AND r.claim_id = c.claim_id
      WHERE sender.location_id = receiver.location_id
      ORDER BY (candidates.tactic IS NOT NULL) DESC, sender.agent_key, receiver.agent_key, c.claim_key`,
    [worldId, tick, GOSSIP.minHeat, GOSSIP.retellCooldown],
  );
  return result.rows;
}

async function loadRecordedDialogue(
  client: Client,
  worldId: string,
  tick: number,
  pair: PairRow,
  inputHash: string,
): Promise<DialogueDecision> {
  const result = await client.query<{
    input_hash: string;
    prompt_version: string;
    decision: DialogueDecision;
  }>(
    `SELECT input_hash, prompt_version, decision FROM cognition_records
      WHERE world_id = $1 AND tick = $2 AND agent_id = $3 AND task = 'dialogue'
      LIMIT 1`,
    [worldId, tick, pair.from_agent_id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`replay: no dialogue record at tick ${tick}`);
  if (row.input_hash !== inputHash || row.prompt_version !== SPEECH_PROMPT_VERSION) {
    throw new Error(`replay: dialogue inputs changed at tick ${tick}`);
  }
  // Runtime ids for rumors are regenerated by rewind. The recorded decision
  // owns the model-authored line; the freshly reconstructed pair owns every
  // database identity used to apply it.
  return makeDecision(pair, inputHash, row.decision.line,
    row.decision.response ?? 'I will remember what you said.', 'replay');
}
