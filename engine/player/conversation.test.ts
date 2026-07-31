import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeConversation, ConversationRateLimitError, startConversation,
  findUnsupportedCapitalizedToken, parseTurn, parseTurnWithDiagnostics,
  sweepExpiredConversations, takeConversationTurn,
} from './conversation.ts';
import { COGNITION } from '../core/config.ts';
import { closePool, query } from '../database/db.ts';
import { createStubClient } from '../inference/index.ts';
import { runTick } from '../simulation/runtick.ts';
import { rewindWorld } from '../simulation/rewind.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe('player conversation output parsing', () => {
  test('accepts only the structured allowlists', () => {
    assert.deepEqual(parseTurn(JSON.stringify({
      reply: 'I have heard enough.', speechAct: 'inquire',
      disclosure: 'deflect', hearingResponse: null,
      referencedClaimKeys: ['rowan_at_quay'],
    }), new Set(['rowan_at_quay'])), {
      reply: 'I have heard enough.', speechAct: 'inquire',
      disclosure: 'deflect', hearingResponse: null,
      referencedClaimKeys: ['rowan_at_quay'],
    });
    assert.deepEqual(parseTurn(JSON.stringify({
      reply: 'Come to the square.', speechAct: 'summon',
      disclosure: null, hearingResponse: 'come_but_tell_someone', referencedClaimKeys: [],
    })), {
      reply: 'Come to the square.', speechAct: 'summon',
      disclosure: null, hearingResponse: 'come_but_tell_someone', referencedClaimKeys: [],
    });
  });

  test('rejects malformed and non-allowlisted outputs', () => {
    const invalid = [
      'not json',
      JSON.stringify({ reply: '', speechAct: 'smalltalk', disclosure: null,
        hearingResponse: null, referencedClaimKeys: [] }),
      JSON.stringify({ reply: 'x'.repeat(2001), speechAct: 'smalltalk', disclosure: null,
        hearingResponse: null, referencedClaimKeys: [] }),
      JSON.stringify({ reply: 'Hello.', speechAct: 'invent', disclosure: null,
        hearingResponse: null, referencedClaimKeys: [] }),
      JSON.stringify({ reply: 'Hello.', speechAct: 'inquire', disclosure: 'invent',
        hearingResponse: null, referencedClaimKeys: [] }),
      JSON.stringify({ reply: 'Hello.', speechAct: 'summon', disclosure: null,
        hearingResponse: 'invent', referencedClaimKeys: [] }),
      JSON.stringify({ reply: 'Hello.', speechAct: 'smalltalk', disclosure: null,
        hearingResponse: null, referencedClaimKeys: ['invented_claim'] }),
      JSON.stringify({ reply: 'Hello.', speechAct: 'smalltalk', disclosure: null,
        hearingResponse: null }),
    ];
    for (const text of invalid) assert.equal(parseTurn(text), null);
  });

  test('identifies why a structured output was rejected', () => {
    assert.equal(parseTurnWithDiagnostics('not json').rejection?.code, 'invalid_json');
    assert.deepEqual(parseTurnWithDiagnostics(JSON.stringify({
      reply: 'I heard Rowan was there.', speechAct: 'inform', disclosure: null,
      hearingResponse: null, referencedClaimKeys: ['invented_claim'],
    })).rejection, {
      code: 'unknown_claim_key', detail: 'received "invented_claim"',
    });
  });

  test('allows sentence-opening prose while rejecting unknown mid-sentence proper nouns', () => {
    const accepted = [
      'Oh, sweetie, thank you for asking.',
      'Seen? Oh—folk pass faster than the tide.',
      'They said the mill was empty that night.',
      'You said you would help me.',
      'She told me the same thing.',
      'That said, I would rather not talk about it.',
      'Nothing said here leaves this room.',
      'He leaned close and whispered, "Oh, I know."',
      'There was a light burning at the mill that night.',
      'There is nothing more to say.',
      'There were three of them on the steps.',
      'Everything was quiet until the bell rang.',
      'Something was wrong that night.',
      'Everybody knows the old story.',
      'Word is she left before dawn.',
      'Others said the same thing.',
      // Unknown sentence-leading names are accepted deliberately: capitalization
      // cannot distinguish them from ordinary prose without an NER model, and
      // free-form reply text cannot authorize a claim or world effect.
      'Bram saw the lantern go out past the mill.',
      'Marla knows more than she lets on.',
      'Marla mentioned it to me yesterday.',
      'He leaned close and whispered, "Garrick is the one you want."',
      'Mr. Halloway keeps the ledger.',
      'The tide turns... Garrick will be there.',
    ];
    for (const reply of accepted) {
      assert.equal(findUnsupportedCapitalizedToken(reply), null, reply);
    }
    assert.equal(
      findUnsupportedCapitalizedToken('I have not met Marla.', new Set(['marla'])),
      null,
      'an unknown name supplied by the player may be repeated without becoming an engine fact',
    );

    const rejected = [
      'I heard it from Marla while she polished the lantern glass.',
      'Yesterday, Marla mentioned it to me.',
      'Ask Bram about the lantern.',
      "The millers' Garrick keeps the key.",
    ];
    for (const reply of rejected) {
      assert.match(findUnsupportedCapitalizedToken(reply) ?? '', /unsupported capitalized token/, reply);
    }
  });
});

describe('durable conversations', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    scenarioVersionId = (await publishScenario(
      await loadScenarioFile(join(here, '..', '..', 'scenario', 'hollowmere-v2.json')),
    )).scenarioVersionId;
  });
  after(closePool);

  async function freshWorld(seed: number) {
    const sessionId = `durable-conversation-${seed}-${Date.now()}`;
    const world = await instantiateWorld({ scenarioVersionId, seed, sessionId });
    const agents = await query<{ agent_key: string; location_id: string }>(
      `SELECT agent_key, location_id FROM world_agents WHERE world_id = $1 ORDER BY agent_key LIMIT 1`,
      [world.worldId],
    );
    const agent = agents[0]!;
    await query(`UPDATE world_players SET location_id = $2 WHERE world_id = $1`,
      [world.worldId, agent.location_id]);
    return { worldId: world.worldId, sessionId, agentKey: agent.agent_key };
  }

  test('a held conversation stops the scheduler before inference', async () => {
    const ref = await freshWorld(701);
    const started = await startConversation({
      ...ref, idempotencyKey: 'start-once',
    });
    const repeated = await startConversation({ ...ref, idempotencyKey: 'start-once' });
    assert.equal(repeated.conversationId, started.conversationId);

    let calls = 0;
    const stub = createStubClient();
    const inference = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        calls++;
        return stub.complete(request);
      },
    };
    const report = await runTick({ worldId: ref.worldId, inference });
    assert.equal(report.skipped, 'conversation_held');
    assert.equal(calls, 0);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('turns are idempotent; closing writes memories, a relationship, and time debt', async () => {
    const ref = await freshWorld(702);
    const inference = createStubClient();
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const turnInput = {
      worldId: ref.worldId, sessionId: ref.sessionId,
      conversationId: started.conversationId,
      text: 'I want peace between the houses. Will you help?',
      idempotencyKey: 'turn', inference,
    };
    const first = await takeConversationTurn(turnInput);
    const replay = await takeConversationTurn(turnInput);
    assert.equal(replay.turn.turnId, first.turn.turnId);
    assert.equal(replay.conversation.turnCount, 1);

    const closed = await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId,
      conversationId: started.conversationId, idempotencyKey: 'close', inference,
    });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.timeCostTicks, 1);
    const state = await query<{ time_debt_ticks: number; memories: number; impressions: number }>(
      `SELECT w.time_debt_ticks,
              (SELECT count(*)::INT8 FROM world_memories m
                WHERE m.world_id = w.world_id AND m.kind = 'dialogue') AS memories,
              (SELECT count(*)::INT8 FROM player_agent_relationships r
                WHERE r.world_id = w.world_id AND r.impression IS NOT NULL) AS impressions
         FROM worlds w WHERE w.world_id = $1`, [ref.worldId],
    );
    assert.equal(state[0]!.time_debt_ticks, 1);
    assert.ok(state[0]!.memories >= 1);
    assert.equal(state[0]!.impressions, 1);

    const charged = await runTick({ worldId: ref.worldId, inference, debtTick: true });
    assert.equal(charged.committed, true);
    const debt = await query<{ time_debt_ticks: number }>(
      `SELECT time_debt_ticks FROM worlds WHERE world_id = $1`, [ref.worldId],
    );
    assert.equal(debt[0]!.time_debt_ticks, 0);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('an embedding outage closes with a metered, explicitly labeled deterministic vector', async () => {
    const ref = await freshWorld(712);
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const stub = createStubClient();
    const unavailable = {
      ...stub,
      mode: 'azure' as const,
      embeddingModelId: 'unavailable-live-model',
      async embed() { throw new Error('provider unavailable'); },
    };
    const closed = await closeConversation({
      ...ref, conversationId: started.conversationId,
      idempotencyKey: 'close', inference: unavailable,
    });
    assert.equal(closed.status, 'closed');
    const rows = await query<{ summary_embedding_model_id: string; inference_calls: number }>(
      `SELECT session.summary_embedding_model_id, budget.inference_calls
         FROM world_conversation_sessions session
         JOIN world_budget budget ON budget.world_id = session.world_id
        WHERE session.world_id = $1 AND session.conversation_id = $2`,
      [ref.worldId, started.conversationId],
    );
    assert.equal(rows[0]!.summary_embedding_model_id, 'stub-embedding-v1');
    assert.equal(rows[0]!.inference_calls, 1, 'fallback work remains inside the world cap');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('rate limiting blocks new paid turns but permits an idempotent retry', async () => {
    const ref = await freshWorld(708);
    const stub = createStubClient();
    let calls = 0;
    const inference = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        calls++;
        return stub.complete(request);
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const firstInput = {
      worldId: ref.worldId, sessionId: ref.sessionId,
      conversationId: started.conversationId, text: 'Good evening.',
      idempotencyKey: 'turn-1', inference, rateLimitPerMinute: 1,
    };
    const first = await takeConversationTurn(firstInput);
    const replay = await takeConversationTurn(firstInput);
    assert.equal(replay.turn.turnId, first.turn.turnId);
    assert.equal(calls, 1);

    await assert.rejects(
      takeConversationTurn({
        ...firstInput, text: 'Tell me more.', idempotencyKey: 'turn-2',
      }),
      ConversationRateLimitError,
    );
    assert.equal(calls, 1, 'a rejected turn must not reach inference');
    const commands = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_commands
        WHERE world_id = $1 AND kind = 'conversation_turn'`, [ref.worldId],
    );
    assert.equal(commands[0]!.count, 1);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('the sweeper closes an abandoned hold without provider inference', async () => {
    const ref = await freshWorld(703);
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    await query(
      `UPDATE world_conversation_sessions SET deadline_at = now() - INTERVAL '1 second'
        WHERE world_id = $1 AND conversation_id = $2`, [ref.worldId, started.conversationId],
    );
    assert.ok(await sweepExpiredConversations() >= 1);
    const status = await query<{ status: string }>(
      `SELECT status FROM world_conversation_sessions
        WHERE world_id = $1 AND conversation_id = $2`, [ref.worldId, started.conversationId],
    );
    assert.equal(status[0]!.status, 'timed_out');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('rewind preserves the transcript while rebuilding its projections', async () => {
    const ref = await freshWorld(704);
    const inference = createStubClient();
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId,
      conversationId: started.conversationId, text: 'I will remember this kindness.',
      idempotencyKey: 'turn', inference,
    });
    await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      idempotencyKey: 'close', inference,
    });
    await rewindWorld(ref.worldId);
    const recording = await query<{ turns: number; memories: number; impressions: number }>(
      `SELECT
          (SELECT count(*)::INT8 FROM world_conversation_turns t
            WHERE t.world_id = $1 AND t.conversation_id = $2) AS turns,
          (SELECT count(*)::INT8 FROM world_memories m WHERE m.world_id = $1) AS memories,
          (SELECT count(*)::INT8 FROM player_agent_relationships r
            WHERE r.world_id = $1 AND r.impression IS NOT NULL) AS impressions`,
      [ref.worldId, started.conversationId],
    );
    assert.equal(recording[0]!.turns, 1);
    assert.equal(recording[0]!.memories, 0);
    assert.equal(recording[0]!.impressions, 0);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('a later conversation recalls the NPC relationship and prior exchange', async () => {
    const ref = await freshWorld(705);
    const stub = createStubClient();
    const first = await startConversation({ ...ref, idempotencyKey: 'start-1' });
    await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: first.conversationId,
      text: 'I will ruin you. Watch yourself.', idempotencyKey: 'turn-1', inference: stub,
    });
    await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: first.conversationId,
      idempotencyKey: 'close-1', inference: stub,
    });

    const durable = await query<{
      memory_id: string; agent_id: string; content: string; tick: number;
    }>(
      `SELECT memory_id, agent_id, content, tick FROM world_memories
        WHERE world_id = $1 AND kind = 'dialogue'
        ORDER BY importance DESC, memory_id LIMIT 1`,
      [ref.worldId],
    );
    assert.match(durable[0]!.content, /I will ruin you/);

    // Fill and overrun the old latest-eight window. These memories are newer
    // and maximally important but have no player-turn provenance, so durable
    // relationship retrieval must still carry the threat into the next prompt.
    const fillerTexts = Array.from({ length: 60 }, (_, index) =>
      `Routine market observation number ${index + 1}.`);
    const retrievalVector = Array.from({ length: 1024 }, () => 1);
    for (const [index, text] of fillerTexts.entries()) {
      await query(
        `INSERT INTO world_memories
           (world_id, agent_id, tick, seq, kind, content, embedding, importance)
         VALUES ($1, $2, $3, $4, 'observation', $5, $6, 10000)`,
        [ref.worldId, durable[0]!.agent_id, index + 1, 8_000_000 + index,
          text, `[${retrievalVector.join(',')}]`],
      );
    }
    await query(`UPDATE worlds SET current_tick = 27 WHERE world_id = $1`, [ref.worldId]);

    // A new pool proves this is database memory, not process-local context.
    await closePool();

    const second = await startConversation({ ...ref, idempotencyKey: 'start-2' });
    let systemPrompt = '';
    let userPrompt = '';
    let speechActChoices: readonly string[] = [];
    const observing = {
      ...stub,
      async embed(texts: readonly string[]) {
        const embedded = await stub.embed(texts);
        return { ...embedded, vectors: texts.map(() => retrievalVector) };
      },
      async complete(request: Parameters<typeof stub.complete>[0]) {
        if (request.task === 'conversation_turn') {
          systemPrompt = request.system;
          userPrompt = request.user;
          speechActChoices = request.choices?.speechActs ?? [];
        }
        return stub.complete(request);
      },
    };
    const recalled = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: second.conversationId,
      text: 'Do you remember me?', idempotencyKey: 'turn-2', inference: observing,
    });
    const replay = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: second.conversationId,
      text: 'Do you remember me?', idempotencyKey: 'turn-2', inference: observing,
    });
    const prompt = JSON.parse(userPrompt) as {
      scene: {
        location: { name: string }; publicEscalationStage: string;
        audience: { count: number; privacy: string };
      };
      npc: { name: string; persona: string; personality: { honesty: number } };
      relationshipWithPlayer: { lastingImpression: string };
      recalledMemories: string[];
      knowledgeItems: unknown[];
      latestPlayerUtterance: string;
    };
    assert.match(systemPrompt, /speechAct classifies the latest PLAYER utterance/);
    assert.ok(speechActChoices.includes('inquire'));
    assert.ok(speechActChoices.includes('summon'));
    assert.ok(prompt.scene.location.name.length > 0);
    assert.equal(prompt.scene.publicEscalationStage, 'calm');
    assert.ok(Number.isInteger(prompt.scene.audience.count));
    assert.ok(['private', 'public'].includes(prompt.scene.audience.privacy));
    assert.ok(prompt.npc.name.length > 0);
    assert.ok(prompt.npc.persona.length > 0);
    assert.ok(Number.isInteger(prompt.npc.personality.honesty));
    assert.match(prompt.relationshipWithPlayer.lastingImpression, /threat/i);
    assert.ok(prompt.recalledMemories.length > 0);
    assert.ok(prompt.recalledMemories.some((memory) => memory.includes('I will ruin you')),
      'the salient player memory must survive restart and more than eight newer memories');
    assert.ok(recalled.turn.recalledMemories.length > 1,
      'the completed turn should identify every memory supplied to the prompt');
    const durableReference = recalled.turn.recalledMemories.find(
      (memory) => memory.memoryId === durable[0]!.memory_id,
    );
    assert.deepEqual(durableReference?.candidatePaths, ['pinned_anchor'],
      'the durable relationship memory should identify the separately pinned path');
    assert.deepEqual(replay.turn.recalledMemories, recalled.turn.recalledMemories,
      'an idempotent replay must expose the exact recorded memory references');

    const stored = await query<{ structured_outcome: unknown }>(
      `SELECT structured_outcome FROM world_conversation_turns
        WHERE world_id = $1 AND turn_id = $2`,
      [ref.worldId, recalled.turn.turnId],
    );
    const storedJson = JSON.stringify(stored[0]!.structured_outcome);
    assert.deepEqual(
      (stored[0]!.structured_outcome as {
        recalledMemories: typeof recalled.turn.recalledMemories;
      }).recalledMemories,
      recalled.turn.recalledMemories,
      'the structured outcome must persist the memory IDs and candidate paths',
    );
    assert.doesNotMatch(storedJson, /embedding|systemPrompt|userPrompt|recalledMemoryText/);

    const attachedIds = recalled.turn.recalledMemories.map((memory) => memory.memoryId);
    const attached = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_memories
        WHERE world_id = $1 AND memory_id = ANY($2::UUID[])`,
      [ref.worldId, attachedIds],
    );
    assert.equal(attached[0]!.count, attachedIds.length,
      'every persisted reference must resolve inside the same world');
    assert.ok(Array.isArray(prompt.knowledgeItems));
    assert.doesNotMatch(userPrompt, /audibleWitnesses/);
    assert.equal(prompt.latestPlayerUtterance, 'Do you remember me?');
    const accesses = await query<{ accessed_tick: number }>(
      `SELECT accessed_tick FROM memory_accesses
        WHERE world_id = $1 AND memory_id = $2 ORDER BY accessed_tick DESC LIMIT 1`,
      [ref.worldId, durable[0]!.memory_id],
    );
    assert.equal(accesses[0]?.accessed_tick, 27);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('a fresh NPC skips empty memory retrieval before answering', async () => {
    const ref = await freshWorld(713);
    const stub = createStubClient();
    let embeddingCalls = 0;
    let completionCalls = 0;
    const observing = {
      ...stub,
      async embed(texts: readonly string[]) {
        embeddingCalls++;
        return stub.embed(texts);
      },
      async complete(request: Parameters<typeof stub.complete>[0]) {
        completionCalls++;
        return stub.complete(request);
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const result = await takeConversationTurn({
      ...ref, conversationId: started.conversationId,
      text: 'Good evening.', idempotencyKey: 'turn', inference: observing,
    });
    assert.equal(result.turn.fallback, false);
    assert.deepEqual(result.turn.recalledMemories, []);
    assert.equal(embeddingCalls, 0, 'an empty memory set needs no query embedding');
    assert.equal(completionCalls, 1);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('a turn records one recalled memory and every path that supplied it', async () => {
    const ref = await freshWorld(717);
    const stub = createStubClient();
    const [agent] = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
      [ref.worldId, ref.agentKey],
    );
    const content = 'A single grounded observation about the outsider.';
    const vector = (await stub.embed([content])).vectors[0]!;
    await query(
      `INSERT INTO world_memories
         (world_id, agent_id, tick, seq, kind, content, embedding, importance)
       VALUES ($1, $2, 0, 9900001, 'observation', $3, $4, 5000)`,
      [ref.worldId, agent!.agent_id, content, `[${vector.join(',')}]`],
    );

    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const result = await takeConversationTurn({
      ...ref,
      conversationId: started.conversationId,
      text: 'What do you recall?',
      idempotencyKey: 'turn',
      inference: stub,
    });

    assert.equal(result.turn.recalledMemories.length, 1);
    assert.deepEqual(result.turn.recalledMemories[0]!.candidatePaths,
      ['ann', 'importance', 'recency']);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('the final inference slot is usable only when memory retrieval is unnecessary', async () => {
    const stub = createStubClient();
    const fresh = await freshWorld(715);
    await query(`UPDATE world_budget SET inference_calls = $2 WHERE world_id = $1`,
      [fresh.worldId, COGNITION.callBudget - 1]);
    let freshEmbeddings = 0;
    let freshCompletions = 0;
    const freshInference = {
      ...stub,
      async embed(texts: readonly string[]) {
        freshEmbeddings++;
        return stub.embed(texts);
      },
      async complete(request: Parameters<typeof stub.complete>[0]) {
        freshCompletions++;
        return stub.complete(request);
      },
    };
    const freshConversation = await startConversation({ ...fresh, idempotencyKey: 'start' });
    const admitted = await takeConversationTurn({
      ...fresh, conversationId: freshConversation.conversationId,
      text: 'Can you answer one question?', idempotencyKey: 'turn', inference: freshInference,
    });
    assert.equal(admitted.turn.fallback, false);
    assert.equal(freshEmbeddings, 0);
    assert.equal(freshCompletions, 1);

    const remembered = await freshWorld(716);
    const agent = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
      [remembered.worldId, remembered.agentKey],
    );
    const vector = (await stub.embed(['A prior grounded observation.'])).vectors[0]!;
    await query(
      `INSERT INTO world_memories
         (world_id, agent_id, tick, seq, kind, content, embedding, importance)
       VALUES ($1, $2, 0, 9900000, 'observation', $3, $4, 5000)`,
      [remembered.worldId, agent[0]!.agent_id, 'A prior grounded observation.',
        `[${vector.join(',')}]`],
    );
    await query(`UPDATE world_budget SET inference_calls = $2 WHERE world_id = $1`,
      [remembered.worldId, COGNITION.callBudget - 1]);
    let rememberedEmbeddings = 0;
    let rememberedCompletions = 0;
    const rememberedInference = {
      ...stub,
      async embed(texts: readonly string[]) {
        rememberedEmbeddings++;
        return stub.embed(texts);
      },
      async complete(request: Parameters<typeof stub.complete>[0]) {
        rememberedCompletions++;
        return stub.complete(request);
      },
    };
    const rememberedConversation = await startConversation({
      ...remembered, idempotencyKey: 'start',
    });
    const refused = await takeConversationTurn({
      ...remembered, conversationId: rememberedConversation.conversationId,
      text: 'Can you remember me?', idempotencyKey: 'turn', inference: rememberedInference,
    });
    assert.equal(refused.turn.fallback, true);
    assert.equal(rememberedEmbeddings, 0, 'retrieval must not spend the final slot by itself');
    assert.equal(rememberedCompletions, 0);

    await query(`DELETE FROM worlds WHERE world_id = ANY($1::UUID[])`,
      [[fresh.worldId, remembered.worldId]]);
  });

  test('ordinary capitalized sentence openers do not discard grounded replies', async () => {
    const ref = await freshWorld(714);
    const stub = createStubClient();
    const replies = [
      'Oh, sweetie, thank you for asking. Folks have been worried.',
      'Seen? Oh—folk pass faster than the tide.',
    ];
    let replyIndex = 0;
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        return { ...base, text: JSON.stringify({
          reply: replies[replyIndex++]!, speechAct: 'smalltalk', disclosure: null,
          hearingResponse: null, referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const first = await takeConversationTurn({
      ...ref, conversationId: started.conversationId,
      text: 'How are you?', idempotencyKey: 'turn-1', inference: scripted,
    });
    const second = await takeConversationTurn({
      ...ref, conversationId: started.conversationId,
      text: 'Did you see anyone?', idempotencyKey: 'turn-2', inference: scripted,
    });
    assert.equal(first.turn.fallback, false);
    assert.equal(first.turn.reply, replies[0]);
    assert.equal(second.turn.fallback, false);
    assert.equal(second.turn.reply, replies[1]);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('unsupported named people do not enter the authoritative transcript', async () => {
    const ref = await freshWorld(711);
    const stub = createStubClient();
    const tasks: string[] = [];
    const turnPrompts: string[] = [];
    const inventedReplies = [
      'I heard it from Marla while she polished the lantern glass.',
      'Yesterday, Marla told me the same story.',
    ];
    let replyIndex = 0;
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        tasks.push(request.task);
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        turnPrompts.push(request.user);
        return { ...base, text: JSON.stringify({
          reply: inventedReplies[replyIndex++]!,
          speechAct: 'inquire', disclosure: 'deflect', hearingResponse: null,
          referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const result = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      text: 'Who told you?', idempotencyKey: 'turn', inference: scripted,
    });
    assert.equal(result.turn.fallback, true);
    assert.doesNotMatch(result.turn.reply, /Marla/);
    const leadingName = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      text: 'What did she say?', idempotencyKey: 'turn-2', inference: scripted,
    });
    assert.equal(leadingName.turn.fallback, true);
    assert.doesNotMatch(leadingName.turn.reply, /Marla/);
    assert.doesNotMatch(turnPrompts[1]!, /Marla/,
      'a rejected provider reply must not be fed into the next turn');

    await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      idempotencyKey: 'close', inference: scripted,
    });
    assert.deepEqual(tasks, ['conversation_turn', 'conversation_turn'],
      'closing must not ask a model to rewrite durable memory');
    const memories = await query<{ content: string }>(
      `SELECT content FROM world_memories WHERE world_id = $1 AND kind = 'dialogue'`,
      [ref.worldId],
    );
    assert.ok(memories.length > 0);
    assert.ok(memories.some((memory) => memory.content.includes('Who told you?')),
      'durable dialogue memory is built from player speech, not rejected provider text');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('player-introduced names are echoable without bypassing cast grounding', async () => {
    const ref = await freshWorld(717);
    assert.notEqual(ref.agentKey, 'jenna_ryle');
    const stub = createStubClient();
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        const prompt = JSON.parse(request.user) as { latestPlayerUtterance: string };
        const name = prompt.latestPlayerUtterance.includes('Jenna Ryle') ? 'Jenna Ryle' : 'Marla';
        return { ...base, text: JSON.stringify({
          reply: `I have not met ${name}.`, speechAct: 'inform', disclosure: null,
          hearingResponse: null, referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const unknown = await takeConversationTurn({
      ...ref, conversationId: started.conversationId,
      text: 'Have you met Marla?', idempotencyKey: 'turn-1', inference: scripted,
    });
    assert.equal(unknown.turn.fallback, false);
    assert.match(unknown.turn.reply, /Marla/);

    const castMember = await takeConversationTurn({
      ...ref, conversationId: started.conversationId,
      text: 'Have you met Jenna Ryle?', idempotencyKey: 'turn-2', inference: scripted,
    });
    assert.equal(castMember.turn.fallback, true,
      'player text must not bypass the stricter known-cast allowlist');
    assert.doesNotMatch(castMember.turn.reply, /Jenna Ryle/);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('the player prompt hides every claim historically planted by the instigator', async () => {
    const sessionId = `conversation-scheme-history-${Date.now()}`;
    const world = await instantiateWorld({ scenarioVersionId, seed: 710, sessionId });
    const culprit = await query<{
      agent_id: string; agent_key: string; location_id: string;
    }>(
      `SELECT agent.agent_id, agent.agent_key, agent.location_id
         FROM world_culprit marker
         JOIN world_agents agent
           ON agent.world_id = marker.world_id AND agent.agent_id = marker.agent_id
        WHERE marker.world_id = $1`,
      [world.worldId],
    );
    const claims = await query<{ claim_id: string; text: string }>(
      `SELECT claim_id, text FROM world_claims
        WHERE world_id = $1 AND NOT locked ORDER BY claim_key LIMIT 3`,
      [world.worldId],
    );
    const historical = claims[0]!;
    const future = claims[1]!;
    const current = claims[2]!;
    await query(`UPDATE world_players SET location_id = $2 WHERE world_id = $1`,
      [world.worldId, culprit[0]!.location_id]);
    await query(`UPDATE world_scheme_state SET claim_id = $2 WHERE world_id = $1`,
      [world.worldId, current.claim_id]);
    await query(
      `INSERT INTO cognition_records
         (world_id, tick, agent_id, task, input_hash, decision, model_id, prompt_version)
       VALUES
         ($1, 0, $2, 'strategy', 'historical-player-scheme-claim', $3,
          'deterministic-fallback', 'strategy-v2'),
         ($1, 20, $2, 'strategy', 'future-player-scheme-claim', $4,
          'deterministic-fallback', 'strategy-v2')`,
      [world.worldId, culprit[0]!.agent_id,
        JSON.stringify({ claimId: historical.claim_id }),
        JSON.stringify({ claimId: future.claim_id })],
    );
    await query(
      `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
       VALUES ($1, $2, $3, -7200, 0), ($1, $2, $4, 3500, 0)
       ON CONFLICT (world_id, agent_id, claim_id)
       DO UPDATE SET confidence = excluded.confidence, updated_tick = excluded.updated_tick`,
      [world.worldId, culprit[0]!.agent_id, historical.claim_id, future.claim_id],
    );
    const started = await startConversation({
      worldId: world.worldId,
      sessionId,
      agentKey: culprit[0]!.agent_key,
      idempotencyKey: 'start',
    });
    const stub = createStubClient();
    let captured = '';
    const inference = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        if (request.task === 'conversation_turn') captured = request.user;
        return stub.complete(request);
      },
    };
    await takeConversationTurn({
      worldId: world.worldId,
      sessionId,
      conversationId: started.conversationId,
      text: 'What have you heard?',
      idempotencyKey: 'turn',
      inference,
    });
    const prompt = JSON.parse(captured) as {
      knowledgeItems: { claim: string }[];
    };
    assert.ok(!prompt.knowledgeItems.some((belief) => belief.claim === historical.text));
    assert.ok(prompt.knowledgeItems.some((belief) => belief.claim === future.text),
      'a strategy record from a future tick must not affect the current prompt');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('structured inquiry records engine-owned provenance and names the real source', async () => {
    const ref = await freshWorld(706);
    const target = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
      [ref.worldId, ref.agentKey],
    );
    const source = await query<{ agent_id: string; name: string }>(
      `SELECT agent_id, name FROM world_agents
        WHERE world_id = $1 AND agent_key != $2 ORDER BY agent_key LIMIT 1`,
      [ref.worldId, ref.agentKey],
    );
    const rumor = await query<{ rumor_id: string; claim_id: string; text: string }>(
      `SELECT r.rumor_id, r.claim_id, c.text FROM world_rumors r
         JOIN world_claims c ON c.world_id = r.world_id AND c.claim_id = r.claim_id
        WHERE r.world_id = $1 ORDER BY c.claim_key LIMIT 1`, [ref.worldId],
    );
    await query(
      `INSERT INTO world_rumor_tellings
         (world_id, rumor_id, claim_id, from_agent_id, to_agent_id, tick, seq, channel)
       VALUES ($1, $2, $3, $4, $5, 0, 900000, 'gossip')`,
      [ref.worldId, rumor[0]!.rumor_id, rumor[0]!.claim_id,
        source[0]!.agent_id, target[0]!.agent_id],
    );
    const stub = createStubClient();
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        return { ...base, text: JSON.stringify({
          reply: 'I can tell you who gave me the story.', speechAct: 'inquire',
          disclosure: 'name_them', hearingResponse: null, referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const result = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      text: `Who told you this: ${rumor[0]!.text}?`, idempotencyKey: 'turn', inference: scripted,
    });
    assert.match(result.turn.reply, new RegExp(source[0]!.name));
    const evidence = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_player_evidence
        WHERE world_id = $1 AND kind = 'provenance'`, [ref.worldId],
    );
    assert.equal(evidence[0]!.count, 1);
    await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId,
      conversationId: started.conversationId, idempotencyKey: 'close', inference: scripted,
    });
    const summary = await query<{ summary: string }>(
      `SELECT summary FROM world_conversation_sessions
        WHERE world_id = $1 AND conversation_id = $2`,
      [ref.worldId, started.conversationId],
    );
    assert.match(summary[0]!.summary, new RegExp(rumor[0]!.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('a structured summons creates a commitment to the hearing destination', async () => {
    const ref = await freshWorld(707);
    const stub = createStubClient();
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        return { ...base, text: JSON.stringify({
          reply: 'I will come.', speechAct: 'summon', disclosure: null,
          hearingResponse: 'come', referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      text: 'Come to a hearing at the chapel.', idempotencyKey: 'turn', inference: scripted,
    });
    const commitment = await query<{ hearing_location: string; commitment_location: string }>(
      `SELECT h.location_id::STRING AS hearing_location,
              c.location_id::STRING AS commitment_location
         FROM world_agent_commitments c
         JOIN world_hearings h ON h.world_id = c.world_id AND h.hearing_id = c.hearing_id
        WHERE c.world_id = $1`, [ref.worldId],
    );
    assert.equal(commitment.length, 1);
    assert.equal(commitment[0]!.commitment_location, commitment[0]!.hearing_location);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });

  test('a declined summons records and states the refusal consistently', async () => {
    const ref = await freshWorld(709);
    const stub = createStubClient();
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        return { ...base, text: JSON.stringify({
          reply: 'I have made my decision.', speechAct: 'summon', disclosure: null,
          hearingResponse: 'decline', referencedClaimKeys: [],
        }) };
      },
    };
    const started = await startConversation({ ...ref, idempotencyKey: 'start' });
    const result = await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      text: 'Come to a hearing at the chapel.', idempotencyKey: 'turn', inference: scripted,
    });
    assert.match(result.turn.reply, /will not answer the summons/i);
    const commitments = await query<{ response: string }>(
      `SELECT response FROM world_agent_commitments WHERE world_id = $1`, [ref.worldId],
    );
    assert.deepEqual(commitments.map((row) => row.response), ['decline']);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
  });
});
