import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeConversation, startConversation, sweepExpiredConversations, takeConversationTurn,
} from './conversation.ts';
import { closePool, query } from './db.ts';
import { createStubClient } from './inference/index.ts';
import { runTick } from './runtick.ts';
import { rewindWorld } from './rewind.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const HAS_DB = Boolean(process.env.DATABASE_URL);

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

    const second = await startConversation({ ...ref, idempotencyKey: 'start-2' });
    let prompt = '';
    const observing = {
      ...stub,
      async complete(request: Parameters<typeof stub.complete>[0]) {
        if (request.task === 'conversation_turn') prompt = request.user;
        return stub.complete(request);
      },
    };
    await takeConversationTurn({
      worldId: ref.worldId, sessionId: ref.sessionId, conversationId: second.conversationId,
      text: 'Do you remember me?', idempotencyKey: 'turn-2', inference: observing,
    });
    assert.match(prompt, /Lasting impression.*threat/i);
    assert.match(prompt, /What you remember:/);
    await query(`DELETE FROM worlds WHERE world_id = $1`, [ref.worldId]);
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
          disclosure: 'name_them', hearingResponse: null,
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
          hearingResponse: 'come',
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
});
