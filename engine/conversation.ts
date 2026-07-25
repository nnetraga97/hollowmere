import { createHash } from 'node:crypto';

import { estimateCostMicros, readBudget, recordUsage } from './budget.ts';
import { query, withClient, withSerializable, type Client } from './db.ts';
import { stableId } from './ids.ts';
import { createStubClient, type InferenceClient } from './inference/index.ts';
import {
  applyStructuredConversationTurn, SPEECH_ACTS, type SpeechAct,
} from './converse.ts';

export const CONVERSATION_TURN_PROMPT_VERSION = 'conversation-turn-v1';
export const CONVERSATION_SUMMARY_PROMPT_VERSION = 'conversation-summary-v1';
const HOLD_MINUTES = 5;
const TURN_TIMEOUT_SECONDS = 45;
const MEMORY_SEQ_BASE = 2_000_000;

export interface ConversationRef {
  worldId: string;
  sessionId: string;
}

export interface ConversationTurnView {
  turnId: string;
  ordinal: number;
  playerText: string;
  reply: string;
  speechAct: SpeechAct;
  fallback: boolean;
}

export interface ConversationView {
  conversationId: string;
  agentKey: string;
  agentName: string;
  status: string;
  openedTick: number;
  turnCount: number;
  timeCostTicks: number;
  participants: { agentKey: string; name: string; role: 'target' | 'observer' }[];
  turns: ConversationTurnView[];
}

interface SessionRow {
  conversation_id: string;
  target_agent_id: string;
  player_id: string;
  location_id: string;
  status: string;
  opened_tick: number;
  turn_count: number;
  time_cost_ticks: number;
  agent_key: string;
  agent_name: string;
}

export async function startConversation(input: ConversationRef & {
  agentKey: string;
  idempotencyKey: string;
}): Promise<ConversationView> {
  const { value: conversationId } = await withSerializable(async (client) => {
    const prior = await client.query<{ conversation_id: string }>(
      `SELECT payload->>'conversationId' AS conversation_id
         FROM world_commands WHERE world_id = $1 AND idempotency_key = $2`,
      [input.worldId, input.idempotencyKey],
    );
    if (prior.rows[0]?.conversation_id) return prior.rows[0].conversation_id;

    const context = await client.query<{
      current_tick: number; command_seq: number; player_id: string; player_location_id: string;
      agent_id: string; agent_location_id: string;
    }>(
      `SELECT w.current_tick, w.command_seq, p.player_id,
              p.location_id AS player_location_id, a.agent_id,
              a.location_id AS agent_location_id
         FROM worlds w
         JOIN world_players p ON p.world_id = w.world_id AND p.session_id = $2
         JOIN world_agents a ON a.world_id = w.world_id AND a.agent_key = $3
        WHERE w.world_id = $1 AND w.status = 'active'
        FOR UPDATE OF w`,
      [input.worldId, input.sessionId, input.agentKey],
    );
    const row = context.rows[0];
    if (!row) throw new Error('world, player, or agent is unavailable');
    if (row.player_location_id !== row.agent_location_id) {
      throw new Error(`${input.agentKey} is not at the player's location`);
    }
    const held = await client.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM world_conversation_sessions
        WHERE world_id = $1 AND status IN ('open', 'closing') LIMIT 1`, [input.worldId],
    );
    if (held.rows[0]) return held.rows[0].conversation_id;

    const commandSeq = row.command_seq + 1;
    const id = stableId(input.worldId, 'conversation', commandSeq);
    await client.query(
      `UPDATE worlds SET command_seq = $2, last_activity_at = now() WHERE world_id = $1`,
      [input.worldId, commandSeq],
    );
    await client.query(
      `INSERT INTO world_conversation_sessions
         (world_id, conversation_id, player_id, target_agent_id, location_id, status,
          opened_tick, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, now() + ($7::INT8 * INTERVAL '1 minute'))`,
      [input.worldId, id, row.player_id, row.agent_id, row.agent_location_id,
        row.current_tick, HOLD_MINUTES],
    );
    await client.query(
      `INSERT INTO world_conversation_participants (world_id, conversation_id, agent_id, role)
       SELECT $1, $2, agent_id, CASE WHEN agent_id = $3 THEN 'target' ELSE 'observer' END
         FROM world_agents
        WHERE world_id = $1 AND location_id = $4 AND status = 'alive'`,
      [input.worldId, id, row.agent_id, row.agent_location_id],
    );
    await client.query(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, 'conversation_start', $4, $5)`,
      [input.worldId, input.idempotencyKey, commandSeq,
        JSON.stringify({ conversationId: id, agentKey: input.agentKey }), row.current_tick],
    );
    return id;
  }, { label: 'start-conversation' });
  return getConversation(input, conversationId);
}

export async function getHeldConversation(ref: ConversationRef): Promise<ConversationView | null> {
  const rows = await query<{ conversation_id: string }>(
    `SELECT s.conversation_id FROM world_conversation_sessions s
       JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
      WHERE s.world_id = $1 AND p.session_id = $2 AND s.status IN ('open', 'closing')
      ORDER BY s.opened_at DESC LIMIT 1`, [ref.worldId, ref.sessionId],
  );
  return rows[0] ? getConversation(ref, rows[0].conversation_id) : null;
}

export async function getConversation(
  ref: ConversationRef,
  conversationId: string,
): Promise<ConversationView> {
  const sessions = await query<SessionRow>(
    `SELECT s.conversation_id, s.target_agent_id, s.player_id, s.location_id, s.status,
            s.opened_tick, s.turn_count, s.time_cost_ticks,
            a.agent_key, a.name AS agent_name
       FROM world_conversation_sessions s
       JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
       JOIN world_agents a ON a.world_id = s.world_id AND a.agent_id = s.target_agent_id
      WHERE s.world_id = $1 AND s.conversation_id = $2 AND p.session_id = $3`,
    [ref.worldId, conversationId, ref.sessionId],
  );
  const session = sessions[0];
  if (!session) throw new Error('conversation not found');
  const [participants, turns] = await Promise.all([
    query<{ agent_key: string; name: string; role: 'target' | 'observer' }>(
      `SELECT a.agent_key, a.name, p.role
         FROM world_conversation_participants p
         JOIN world_agents a ON a.world_id = p.world_id AND a.agent_id = p.agent_id
        WHERE p.world_id = $1 AND p.conversation_id = $2
        ORDER BY CASE p.role WHEN 'target' THEN 0 ELSE 1 END, a.agent_key`,
      [ref.worldId, conversationId],
    ),
    query<{
      turn_id: string; ordinal: number; player_text: string; reply: string | null;
      speech_act: string | null; status: string;
    }>(
      `SELECT turn_id, ordinal, player_text, reply, speech_act, status
         FROM world_conversation_turns WHERE world_id = $1 AND conversation_id = $2
        ORDER BY ordinal`, [ref.worldId, conversationId],
    ),
  ]);
  return {
    conversationId: session.conversation_id,
    agentKey: session.agent_key,
    agentName: session.agent_name,
    status: session.status,
    openedTick: session.opened_tick,
    turnCount: session.turn_count,
    timeCostTicks: session.time_cost_ticks,
    participants: participants.map((row) => ({ agentKey: row.agent_key, name: row.name, role: row.role })),
    turns: turns.filter((row) => row.reply && row.speech_act).map((row) => ({
      turnId: row.turn_id,
      ordinal: row.ordinal,
      playerText: row.player_text,
      reply: row.reply!,
      speechAct: row.speech_act as SpeechAct,
      fallback: row.status === 'fallback',
    })),
  };
}

export async function takeConversationTurn(input: ConversationRef & {
  conversationId: string;
  text: string;
  idempotencyKey: string;
  inference: InferenceClient;
}): Promise<{ turn: ConversationTurnView; conversation: ConversationView }> {
  const reservation = await withSerializable(async (client) => {
    const prior = await client.query<{ turn_id: string; status: string | null }>(
      `SELECT c.payload->>'turnId' AS turn_id, t.status
         FROM world_commands c
         LEFT JOIN world_conversation_turns t ON t.world_id = c.world_id
              AND t.turn_id = (c.payload->>'turnId')::UUID
        WHERE c.world_id = $1 AND c.idempotency_key = $2`, [input.worldId, input.idempotencyKey],
    );
    if (prior.rows[0]?.turn_id) return {
      turnId: prior.rows[0].turn_id,
      replayed: prior.rows[0].status === 'completed' || prior.rows[0].status === 'fallback',
    };
    const rows = await client.query<{
      next_turn_ordinal: number; target_agent_id: string; command_seq: number;
    }>(
      `SELECT s.next_turn_ordinal, s.target_agent_id, w.command_seq
         FROM world_conversation_sessions s
         JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
         JOIN worlds w ON w.world_id = s.world_id
        WHERE s.world_id = $1 AND s.conversation_id = $2 AND p.session_id = $3
          AND s.status = 'open' AND s.deadline_at > now()
        FOR UPDATE OF s, w`, [input.worldId, input.conversationId, input.sessionId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error('conversation is closed or expired');
    const ordinal = row.next_turn_ordinal;
    const turnId = stableId(input.worldId, input.conversationId, 'turn', ordinal);
    const commandSeq = row.command_seq + 1;
    await client.query(
      `UPDATE world_conversation_sessions SET next_turn_ordinal = $3,
              deadline_at = now() + ($4::INT8 * INTERVAL '1 minute')
        WHERE world_id = $1 AND conversation_id = $2`,
      [input.worldId, input.conversationId, ordinal + 1, HOLD_MINUTES],
    );
    await client.query(`UPDATE worlds SET command_seq = $2, last_activity_at = now() WHERE world_id = $1`,
      [input.worldId, commandSeq]);
    await client.query(
      `INSERT INTO world_conversation_turns
         (world_id, conversation_id, turn_id, ordinal, status, player_text, deadline_at)
       VALUES ($1, $2, $3, $4, 'reserved', $5,
               now() + ($6::INT8 * INTERVAL '1 second'))`,
      [input.worldId, input.conversationId, turnId, ordinal, input.text, TURN_TIMEOUT_SECONDS],
    );
    await client.query(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, 'conversation_turn', $4,
               (SELECT current_tick FROM worlds WHERE world_id = $1))`,
      [input.worldId, input.idempotencyKey, commandSeq,
        JSON.stringify({ conversationId: input.conversationId, turnId })],
    );
    return { turnId, replayed: false };
  }, { label: 'reserve-conversation-turn' });

  if (!reservation.value.replayed) await completeReservedTurn(input, reservation.value.turnId);
  const conversation = await getConversation(input, input.conversationId);
  const turn = conversation.turns.find((item) => item.turnId === reservation.value.turnId);
  if (!turn) throw new Error('conversation turn did not complete');
  return { turn, conversation };
}

async function completeReservedTurn(
  input: ConversationRef & { conversationId: string; text: string; inference: InferenceClient },
  turnId: string,
): Promise<void> {
  const context = await withClient(async (client) => {
    const sessions = await client.query<{
      agent_name: string; persona: { summary?: string }; kindness: number; engagement: number;
      honesty: number; trust: number; affinity: number; fear: number; respect: number;
      impression: string | null;
    }>(
      `SELECT a.name AS agent_name, a.persona, a.kindness, a.engagement, a.honesty,
              r.trust, r.affinity, r.fear, r.respect, r.impression
         FROM world_conversation_sessions s
         JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
         JOIN world_agents a ON a.world_id = s.world_id AND a.agent_id = s.target_agent_id
         JOIN player_agent_relationships r ON r.world_id = s.world_id
              AND r.player_id = s.player_id AND r.agent_id = s.target_agent_id
        WHERE s.world_id = $1 AND s.conversation_id = $2 AND p.session_id = $3
          AND s.status = 'open'`, [input.worldId, input.conversationId, input.sessionId],
    );
    if (!sessions.rows[0]) throw new Error('conversation is no longer open');
    const transcript = await client.query<{ ordinal: number; player_text: string; reply: string | null }>(
      `SELECT ordinal, player_text, reply FROM world_conversation_turns
        WHERE world_id = $1 AND conversation_id = $2 AND turn_id != $3
        ORDER BY ordinal`, [input.worldId, input.conversationId, turnId],
    );
    const memories = await client.query<{ content: string }>(
      `SELECT m.content FROM world_memories m
         JOIN world_conversation_sessions s ON s.world_id = m.world_id
              AND s.target_agent_id = m.agent_id
        WHERE m.world_id = $1 AND s.conversation_id = $2
          AND m.kind IN ('dialogue', 'reflection', 'rumor', 'observation')
        ORDER BY m.tick DESC, m.seq DESC LIMIT 8`,
      [input.worldId, input.conversationId],
    );
    const reserved = await client.query<{
      structured_outcome: { suggested?: ParsedTurn }; model_id: string | null;
      tokens_in: number; tokens_out: number; latency_ms: number; budget_tier: string;
    }>(
      `SELECT structured_outcome, model_id, tokens_in, tokens_out, latency_ms, budget_tier
         FROM world_conversation_turns WHERE world_id = $1 AND turn_id = $2 AND status = 'reserved'`,
      [input.worldId, turnId],
    );
    if (!reserved.rows[0]) throw new Error('conversation turn is no longer pending');
    return {
      agent: sessions.rows[0], transcript: transcript.rows,
      memories: memories.rows.map((row) => row.content), reserved: reserved.rows[0],
    };
  });
  const budget = await withClient((client) => readBudget(client, input.worldId));
  const budgetTier = budgetTierFor(budget.inferenceCalls);
  let parsed: ParsedTurn | null = context.reserved.structured_outcome.suggested ?? null;
  let usage = {
    tokensIn: context.reserved.tokens_in,
    tokensOut: context.reserved.tokens_out,
    modelId: context.reserved.model_id ?? 'deterministic-fallback',
    latencyMs: context.reserved.latency_ms,
  };
  if (!parsed && !budget.exhausted) {
    const response = await input.inference.complete({
      task: 'conversation_turn', promptVersion: CONVERSATION_TURN_PROMPT_VERSION,
      system: TURN_SYSTEM,
      user: buildTurnPrompt(context.agent, context.transcript, context.memories, input.text),
      maxTokens: 320, seed: seedFrom(turnId),
      choices: {
        disclosures: ['name_them', 'deflect', 'misdirect', 'demand_something_first'],
        responses: ['come', 'decline', 'come_but_tell_someone'],
      },
    });
    usage = response;
    parsed = parseTurn(response.text);
    await recordInferenceUsage(input.worldId, 'player_turn', turnId, response, input.inference.mode === 'bedrock');
  }
  const suggested = parsed ?? fallbackTurn(input.text);
  // Checkpoint the paid result before effects. A process crash can resume this
  // reserved turn without making the provider call a second time.
  await query(
    `UPDATE world_conversation_turns
        SET structured_outcome = $3, input_hash = $4, prompt_version = $5,
            model_id = $6, budget_tier = $7, tokens_in = $8, tokens_out = $9,
            latency_ms = $10
      WHERE world_id = $1 AND turn_id = $2 AND status = 'reserved'`,
    [input.worldId, turnId, JSON.stringify({ suggested }), hash(input.text),
      CONVERSATION_TURN_PROMPT_VERSION, usage.modelId, budgetTier,
      usage.tokensIn, usage.tokensOut, usage.latencyMs],
  );
  const applied = await applyStructuredConversationTurn({
    worldId: input.worldId, sessionId: input.sessionId,
    agentKey: (await getConversation(input, input.conversationId)).agentKey,
    text: input.text, turnId, act: suggested.speechAct, reply: suggested.reply,
    disclosure: suggested.disclosure as import('./evidence.ts').Disclosure | null,
    hearingResponse: suggested.hearingResponse as 'come' | 'decline' | 'come_but_tell_someone' | null,
    inference: input.inference,
  });
  const result = { ...suggested, reply: applied.reply };
  await withSerializable(async (client) => {
    const updated = await client.query(
      `UPDATE world_conversation_turns
          SET status = $4, reply = $5, speech_act = $6, structured_outcome = $7,
              input_hash = $8, prompt_version = $9, model_id = $10, budget_tier = $11,
              tokens_in = $12, tokens_out = $13, latency_ms = $14, completed_at = now()
        WHERE world_id = $1 AND conversation_id = $2 AND turn_id = $3 AND status = 'reserved'
          AND deadline_at > now()`,
      [input.worldId, input.conversationId, turnId, parsed ? 'completed' : 'fallback',
        result.reply, result.speechAct, JSON.stringify(result), hash(input.text),
        CONVERSATION_TURN_PROMPT_VERSION, usage.modelId, budgetTier,
        usage.tokensIn, usage.tokensOut, usage.latencyMs],
    );
    if (!updated.rowCount) return;
    await client.query(
      `UPDATE world_conversation_sessions SET turn_count = turn_count + 1,
              deadline_at = now() + ($3::INT8 * INTERVAL '1 minute')
        WHERE world_id = $1 AND conversation_id = $2 AND status = 'open'`,
      [input.worldId, input.conversationId, HOLD_MINUTES],
    );
  }, { label: 'complete-conversation-turn' });
}

export async function closeConversation(input: ConversationRef & {
  conversationId: string;
  idempotencyKey: string;
  inference: InferenceClient;
}): Promise<ConversationView> {
  const snapshot = await getConversation(input, input.conversationId);
  if (snapshot.status === 'closed' || snapshot.status === 'timed_out') return snapshot;
  const claimed = await withSerializable(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM world_commands WHERE world_id = $1 AND idempotency_key = $2`,
      [input.worldId, input.idempotencyKey],
    );
    if (existing.rowCount) return false;
    const pending = await client.query(
      `SELECT 1 FROM world_conversation_turns WHERE world_id = $1 AND conversation_id = $2
        AND status = 'reserved' AND deadline_at > now() LIMIT 1`,
      [input.worldId, input.conversationId],
    );
    if (pending.rowCount) throw new Error('the last reply is still being prepared');
    const rows = await client.query<{ command_seq: number }>(
      `SELECT w.command_seq FROM world_conversation_sessions s
         JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
         JOIN worlds w ON w.world_id = s.world_id
        WHERE s.world_id = $1 AND s.conversation_id = $2 AND p.session_id = $3
          AND s.status = 'open' FOR UPDATE OF s, w`,
      [input.worldId, input.conversationId, input.sessionId],
    );
    if (!rows.rows[0]) return false;
    const commandSeq = rows.rows[0].command_seq + 1;
    await client.query(`UPDATE worlds SET command_seq = $2 WHERE world_id = $1`, [input.worldId, commandSeq]);
    await client.query(
      `UPDATE world_conversation_sessions SET status = 'closing', close_idempotency_key = $3,
              closing_ordinal = next_turn_ordinal
        WHERE world_id = $1 AND conversation_id = $2`,
      [input.worldId, input.conversationId, input.idempotencyKey],
    );
    await client.query(
      `INSERT INTO world_commands (world_id, idempotency_key, command_seq, kind, payload)
       VALUES ($1, $2, $3, 'conversation_close', $4)`,
      [input.worldId, input.idempotencyKey, commandSeq,
        JSON.stringify({ conversationId: input.conversationId })],
    );
    return true;
  }, { label: 'claim-conversation-close' });
  if (!claimed.value) return getConversation(input, input.conversationId);

  const transcript = await getConversation(input, input.conversationId);
  let summary = deterministicSummary(transcript);
  let impression = relationshipImpression(transcript.turns);
  const budget = await withClient((client) => readBudget(client, input.worldId));
  if (!budget.exhausted && transcript.turns.length > 0) {
    const response = await input.inference.complete({
      task: 'conversation_summary', promptVersion: CONVERSATION_SUMMARY_PROMPT_VERSION,
      system: 'Return JSON only: {"summary":string,"impression":string}. Add no facts.',
      user: transcript.turns.map((turn) => `Player: ${turn.playerText}\n${transcript.agentName}: ${turn.reply}`).join('\n'),
      maxTokens: 180, seed: seedFrom(input.conversationId),
    });
    await recordInferenceUsage(input.worldId, 'conversation_summary', input.conversationId,
      response, input.inference.mode === 'bedrock');
    const parsed = parseSummary(response.text);
    if (parsed) summary = `${parsed.summary} ${deterministicSummary(transcript)}`;
  }
  const embeddings = await input.inference.embed([summary]);
  await recordEmbeddingUsage(input.worldId, input.conversationId, embeddings, input.inference.mode === 'bedrock');
  const timeCost = timeCostFor(transcript.turns.length);
  await finalizeConversation(input, transcript, summary, impression, embeddings.vectors[0]!, timeCost, 'closed');
  return getConversation(input, input.conversationId);
}

export async function hasConversationHold(worldId: string): Promise<boolean> {
  const rows = await query<{ held: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM world_conversation_sessions
      WHERE world_id = $1 AND status IN ('open', 'closing')) AS held`, [worldId],
  );
  return rows[0]?.held ?? false;
}

export async function sweepExpiredConversations(): Promise<number> {
  const expired = await query<{ world_id: string; conversation_id: string; session_id: string }>(
    `SELECT s.world_id, s.conversation_id, p.session_id
       FROM world_conversation_sessions s
       JOIN world_players p ON p.world_id = s.world_id AND p.player_id = s.player_id
      WHERE s.status = 'open' AND s.deadline_at <= now()`,
  );
  for (const row of expired) {
    await query(
      `UPDATE world_conversation_turns SET status = 'fallback',
              reply = 'The moment passes before an answer comes.', speech_act = 'smalltalk',
              structured_outcome = '{"reason":"turn_timeout"}', completed_at = now()
        WHERE world_id = $1 AND conversation_id = $2 AND status = 'reserved'`,
      [row.world_id, row.conversation_id],
    );
    const view = await getConversation({ worldId: row.world_id, sessionId: row.session_id }, row.conversation_id);
    const summary = deterministicSummary(view);
    const vectors = await createStubClient().embed([summary]);
    await finalizeConversation(
      { worldId: row.world_id, sessionId: row.session_id, conversationId: row.conversation_id },
      view, summary, relationshipImpression(view.turns), vectors.vectors[0]!,
      timeCostFor(view.turns.length), 'timed_out',
    );
  }
  return expired.length;
}

async function finalizeConversation(
  input: ConversationRef & { conversationId: string },
  view: ConversationView,
  summary: string,
  impression: string,
  vector: readonly number[],
  timeCost: number,
  status: 'closed' | 'timed_out',
): Promise<void> {
  const deltas = relationshipDeltas(view.turns);
  await withSerializable(async (client) => {
    const rows = await client.query<{
      player_id: string; target_agent_id: string; opened_tick: number; current_tick: number;
      command_seq: number;
    }>(
      `SELECT s.player_id, s.target_agent_id, s.opened_tick, w.current_tick, w.command_seq
         FROM world_conversation_sessions s JOIN worlds w ON w.world_id = s.world_id
        WHERE s.world_id = $1 AND s.conversation_id = $2 AND s.status IN ('closing', 'open')
        FOR UPDATE OF s, w`, [input.worldId, input.conversationId],
    );
    const row = rows.rows[0];
    if (!row) return;
    const seq = MEMORY_SEQ_BASE + row.command_seq * 64;
    await client.query(
      `UPDATE player_agent_relationships
          SET trust = greatest(0, least(10000, trust + $4)),
              affinity = greatest(-10000, least(10000, affinity + $5)),
              fear = greatest(0, least(10000, fear + $6)),
              respect = greatest(-10000, least(10000, respect + $7)),
              impression = $8, updated_tick = $9
        WHERE world_id = $1 AND player_id = $2 AND agent_id = $3`,
      [input.worldId, row.player_id, row.target_agent_id, deltas.trust, deltas.affinity,
        deltas.fear, deltas.respect, impression, row.current_tick],
    );
    await client.query(
      `INSERT INTO player_agent_relationship_updates
         (world_id, update_id, player_id, agent_id, tick, seq, trust_delta,
          affinity_delta, fear_delta, respect_delta, impression, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (world_id, update_id) DO NOTHING`,
      [input.worldId, stableId(input.worldId, input.conversationId, 'relationship'),
        row.player_id, row.target_agent_id, row.current_tick, seq, deltas.trust,
        deltas.affinity, deltas.fear, deltas.respect, impression, input.conversationId],
    );
    const participants = await client.query<{ agent_id: string; role: string }>(
      `SELECT agent_id, role FROM world_conversation_participants
        WHERE world_id = $1 AND conversation_id = $2 ORDER BY role DESC, agent_id`,
      [input.worldId, input.conversationId],
    );
    let offset = 1;
    for (const participant of participants.rows) {
      const memorySeq = seq + offset++;
      const memoryId = stableId(input.worldId, input.conversationId, 'memory', participant.agent_id);
      const content = participant.role === 'target' ? summary : `Overheard: ${summary}`;
      await client.query(
        `INSERT INTO world_memories
           (world_id, memory_id, agent_id, tick, seq, kind, content, embedding, importance,
            subject_agent_id)
         VALUES ($1, $2, $3, $4, $5, 'dialogue', $6, $7, $8, $9)
         ON CONFLICT (world_id, memory_id) DO NOTHING`,
        [input.worldId, memoryId, participant.agent_id, row.current_tick, memorySeq,
          content, `[${vector.join(',')}]`, participant.role === 'target' ? 6500 : 3500,
          row.target_agent_id],
      );
      for (const turn of view.turns) {
        await client.query(
          `INSERT INTO memory_source_edges
             (world_id, edge_id, memory_id, source_kind, source_turn_id)
           VALUES ($1, $2, $3, 'turn', $4)
           ON CONFLICT (world_id, edge_id) DO NOTHING`,
          [input.worldId, stableId(input.worldId, memoryId, turn.turnId), memoryId, turn.turnId],
        );
      }
      await client.query(
        `UPDATE world_agent_reflection_state
            SET accumulated_importance = accumulated_importance + $3
          WHERE world_id = $1 AND agent_id = $2`,
        [input.worldId, participant.agent_id, participant.role === 'target' ? 6500 : 3500],
      );
    }
    await client.query(
      `UPDATE world_conversation_sessions
          SET status = $3, closed_tick = $4, time_cost_ticks = $5, summary = $6,
              relationship_impression = $7, closed_at = now()
        WHERE world_id = $1 AND conversation_id = $2`,
      [input.worldId, input.conversationId, status, row.current_tick, timeCost, summary, impression],
    );
    await client.query(
      `UPDATE worlds SET time_debt_ticks = time_debt_ticks + $2, last_activity_at = now()
        WHERE world_id = $1`, [input.worldId, timeCost],
    );
    await client.query(
      `UPDATE world_commands SET applied_tick = $3
        WHERE world_id = $1 AND kind = 'conversation_close'
          AND payload->>'conversationId' = $2 AND applied_tick IS NULL`,
      [input.worldId, input.conversationId, row.current_tick],
    );
  }, { label: 'finalize-conversation' });
}

interface ParsedTurn {
  reply: string;
  speechAct: SpeechAct;
  disclosure: string | null;
  hearingResponse: string | null;
}

const TURN_SYSTEM = 'You are an NPC in Hollowmere. Continue the conversation naturally. Return JSON only: {"reply":string,"speechAct":string,"disclosure":string|null,"hearingResponse":string|null}. Never invent a source name or game-state fact.';

function buildTurnPrompt(
  agent: { agent_name: string; persona: { summary?: string }; kindness: number; engagement: number; honesty: number; trust: number; affinity: number; fear: number; respect: number; impression: string | null },
  transcript: readonly { ordinal: number; player_text: string; reply: string | null }[],
  memories: readonly string[],
  text: string,
): string {
  const history = transcript.filter((turn) => turn.reply).map((turn) =>
    `Player: ${turn.player_text}\n${agent.agent_name}: ${turn.reply}`).join('\n');
  const remembered = memories.length ? `What you remember:\n${memories.map((item) => `- ${item}`).join('\n')}\n` : '';
  const impression = agent.impression ? `Lasting impression of the outsider: ${agent.impression}\n` : '';
  return `${agent.agent_name}: ${agent.persona.summary ?? ''}\nPersonality kindness=${agent.kindness}, engagement=${agent.engagement}, honesty=${agent.honesty}.\nRelationship trust=${agent.trust}, affinity=${agent.affinity}, fear=${agent.fear}, respect=${agent.respect}.\n${impression}${remembered}${history}\nPlayer: ${text}`;
}

function parseTurn(text: string): ParsedTurn | null {
  try {
    const value = JSON.parse(text) as Partial<ParsedTurn>;
    if (typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 2_000) return null;
    if (!SPEECH_ACTS.includes(value.speechAct as SpeechAct)) return null;
    const disclosure = value.disclosure == null ? null : String(value.disclosure);
    const hearingResponse = value.hearingResponse == null ? null : String(value.hearingResponse);
    if (disclosure && !['name_them', 'deflect', 'misdirect', 'demand_something_first'].includes(disclosure)) return null;
    if (hearingResponse && !['come', 'decline', 'come_but_tell_someone'].includes(hearingResponse)) return null;
    return { reply: value.reply.trim(), speechAct: value.speechAct as SpeechAct, disclosure, hearingResponse };
  } catch { return null; }
}

function fallbackTurn(text: string): ParsedTurn {
  const lower = text.toLowerCase();
  const speechAct: SpeechAct = lower.includes('?') ? 'inquire'
    : lower.includes('peace') || lower.includes('forgive') ? 'reconcile'
    : lower.includes('kill') || lower.includes('or else') ? 'threaten'
    : 'smalltalk';
  return { reply: 'I need a moment before I answer that.', speechAct, disclosure: null, hearingResponse: null };
}

function parseSummary(text: string): { summary: string; impression: string } | null {
  try {
    const value = JSON.parse(text) as { summary?: unknown; impression?: unknown };
    return typeof value.summary === 'string' && typeof value.impression === 'string'
      ? { summary: value.summary.slice(0, 2_000), impression: value.impression.slice(0, 500) } : null;
  } catch { return null; }
}

function deterministicSummary(view: ConversationView): string {
  if (!view.turns.length) return `${view.agentName} and the outsider parted without speaking.`;
  const acts = [...new Set(view.turns.map((turn) => turn.speechAct))].join(', ');
  return `${view.agentName} spoke with the outsider for ${view.turns.length} turn${view.turns.length === 1 ? '' : 's'} (${acts}).`;
}

function relationshipImpression(turns: readonly ConversationTurnView[]): string {
  const acts = new Set(turns.map((turn) => turn.speechAct));
  if (acts.has('threaten')) return 'The outsider made a threat that will not be forgotten.';
  if (acts.has('reconcile')) return 'The outsider made a sincere attempt at peace.';
  if (acts.has('accuse')) return 'The outsider pressed a dangerous accusation.';
  if (turns.length >= 4) return 'The outsider stayed and listened.';
  return 'The outsider stopped to speak.';
}

function relationshipDeltas(turns: readonly ConversationTurnView[]) {
  let trust = 0, affinity = 0, fear = 0, respect = 0;
  for (const act of new Set(turns.map((turn) => turn.speechAct))) {
    if (act === 'smalltalk' || act === 'inform' || act === 'inquire') { trust += 150; affinity += 100; }
    if (act === 'reconcile' || act === 'defend') { trust += 250; affinity += 250; respect += 200; }
    if (act === 'threaten') { trust -= 700; affinity -= 500; fear += 900; respect -= 200; }
    if (act === 'accuse' || act === 'dispute') { trust -= 250; affinity -= 150; respect += 100; }
  }
  return { trust, affinity, fear, respect };
}

function timeCostFor(turns: number): number { return turns <= 2 ? 1 : turns <= 5 ? 2 : 3; }
function budgetTierFor(calls: number): 'normal' | 'background_degraded' | 'critical_only' | 'exhausted' {
  if (calls >= 900) return 'exhausted';
  if (calls >= 800) return 'critical_only';
  if (calls >= 650) return 'background_degraded';
  return 'normal';
}
function seedFrom(value: string): number { return Number.parseInt(hash(value).slice(0, 8), 16) >>> 0; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function recordInferenceUsage(
  worldId: string,
  category: 'player_turn' | 'conversation_summary',
  sourceKey: string,
  usage: { modelId: string; tokensIn: number; tokensOut: number },
  billable: boolean,
): Promise<void> {
  await withSerializable(async (client) => {
    const inserted = await client.query(
      `INSERT INTO world_inference_usage
         (world_id, usage_id, category, source_key, model_id, tokens_in, tokens_out,
          est_cost_micros)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (world_id, category, source_key, attempt) DO NOTHING`,
      [worldId, stableId(worldId, category, sourceKey), category, sourceKey,
        usage.modelId, usage.tokensIn, usage.tokensOut,
        estimateCostMicros({ calls: 1, tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut, billable })],
    );
    if (inserted.rowCount) await recordUsage(client, worldId, {
      calls: 1, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, billable,
    });
  }, { label: 'record-conversation-usage' });
}

async function recordEmbeddingUsage(
  worldId: string,
  sourceKey: string,
  usage: { modelId: string; tokensIn: number },
  billable: boolean,
): Promise<void> {
  await withSerializable(async (client) => {
    const inserted = await client.query(
      `INSERT INTO world_inference_usage
         (world_id, usage_id, category, source_key, model_id, tokens_in, est_cost_micros)
       VALUES ($1, $2, 'embedding', $3, $4, $5, $6)
       ON CONFLICT (world_id, category, source_key, attempt) DO NOTHING`,
      [worldId, stableId(worldId, 'embedding', sourceKey), sourceKey, usage.modelId, usage.tokensIn,
        estimateCostMicros({ calls: 1, tokensIn: usage.tokensIn, tokensOut: 0, billable })],
    );
    if (inserted.rowCount) await recordUsage(client, worldId, {
      calls: 1, tokensIn: usage.tokensIn, tokensOut: 0, billable,
    });
  }, { label: 'record-conversation-embedding' });
}
