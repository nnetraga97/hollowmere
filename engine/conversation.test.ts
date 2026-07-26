import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeConversation, ConversationRateLimitError, startConversation,
  parseTurn, sweepExpiredConversations, takeConversationTurn,
} from './conversation.ts';
import { closePool, query } from './db.ts';
import { createStubClient } from './inference/index.ts';
import { runTick } from './runtick.ts';
import { rewindWorld } from './rewind.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe('player conversation output parsing', () => {
  test('accepts only the structured allowlists', () => {
    assert.deepEqual(parseTurn(JSON.stringify({
      reply: 'I have heard enough.', speechAct: 'inquire',
      disclosure: 'deflect', hearingResponse: null,
      referencedClaimKeys: ['rowan_at_the_quay'],
    }), new Set(['rowan_at_the_quay'])), {
      reply: 'I have heard enough.', speechAct: 'inquire',
      disclosure: 'deflect', hearingResponse: null,
      referencedClaimKeys: ['rowan_at_the_quay'],
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
});

describe('durable conversations', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    scenarioVersionId = (await publishScenario(
      await loadScenarioFile(join(here, '..', 'scenario', 'hollowmere-v2.json')),
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
    // and maximally important but have no player-turn provenance, so the pinned
    // relationship slot must still carry the threat into the next prompt.
    const fillerTexts = Array.from({ length: 12 }, (_, index) =>
      `Routine market observation number ${index + 1}.`);
    const fillerVectors = await stub.embed(fillerTexts);
    for (const [index, text] of fillerTexts.entries()) {
      await query(
        `INSERT INTO world_memories
           (world_id, agent_id, tick, seq, kind, content, embedding, importance)
         VALUES ($1, $2, $3, $4, 'observation', $5, $6, 10000)`,
        [ref.worldId, durable[0]!.agent_id, index + 1, 8_000_000 + index,
          text, `[${fillerVectors.vectors[index]!.join(',')}]`],
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
      async complete(request: Parameters<typeof stub.complete>[0]) {
        if (request.task === 'conversation_turn') {
          systemPrompt = request.system;
          userPrompt = request.user;
          speechActChoices = request.choices?.speechActs ?? [];
        }
        return stub.complete(request);
      },
    };
    await takeConversationTurn({
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

  test('unsupported named people fall back and cannot enter durable memory', async () => {
    const ref = await freshWorld(711);
    const stub = createStubClient();
    const tasks: string[] = [];
    const scripted = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        tasks.push(request.task);
        const base = await stub.complete(request);
        if (request.task !== 'conversation_turn') return base;
        return { ...base, text: JSON.stringify({
          reply: 'I heard it from Marla while she polished the lantern glass.',
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

    await closeConversation({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: started.conversationId,
      idempotencyKey: 'close', inference: scripted,
    });
    assert.deepEqual(tasks, ['conversation_turn'], 'closing must not ask a model to rewrite durable memory');
    const memories = await query<{ content: string }>(
      `SELECT content FROM world_memories WHERE world_id = $1 AND kind = 'dialogue'`,
      [ref.worldId],
    );
    assert.ok(memories.length > 0);
    assert.ok(memories.every((memory) => !memory.content.includes('Marla')));
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
