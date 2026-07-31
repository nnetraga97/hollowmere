import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../database/db.ts';
import { createStubClient } from '../inference/index.ts';
import { runTick } from '../simulation/runtick.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { closeConversation, startConversation, takeConversationTurn } from './conversation.ts';
import { assertSession, getAgentDetail, queuePlayerMove } from './game-api.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const here = dirname(fileURLToPath(import.meta.url));

describe('canonical public memory demo', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId = '';
  const worlds: string[] = [];

  before(async () => {
    const scenario = await loadScenarioFile(
      join(here, '..', '..', 'scenario', 'hollowmere-v2.json'),
    );
    scenarioVersionId = (await publishScenario(scenario)).scenarioVersionId;
  });

  after(async () => {
    for (const worldId of worlds) await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
    await closePool();
  });

  async function freshWorld(seed: number, playerLocationKey?: string) {
    const sessionId = `canonical-demo-${seed}-${Date.now()}`;
    const world = await instantiateWorld({
      scenarioVersionId,
      seed,
      sessionId,
      ...(playerLocationKey ? { playerLocationKey } : {}),
    });
    worlds.push(world.worldId);
    return { worldId: world.worldId, sessionId };
  }

  async function moveToAgent(
    ref: { worldId: string; sessionId: string },
    agentKey: string,
  ): Promise<string[]> {
    const [positions, routes] = await Promise.all([
      query<{ player_location: string; agent_location: string }>(
        `SELECT player_location.location_key AS player_location,
                agent_location.location_key AS agent_location
           FROM world_players player
           JOIN world_locations player_location
             ON player_location.world_id = player.world_id
            AND player_location.location_id = player.location_id
           JOIN world_agents agent
             ON agent.world_id = player.world_id AND agent.agent_key = $3
           JOIN world_locations agent_location
             ON agent_location.world_id = agent.world_id
            AND agent_location.location_id = agent.location_id
          WHERE player.world_id = $1 AND player.session_id = $2`,
        [ref.worldId, ref.sessionId, agentKey],
      ),
      query<{ from_key: string; to_key: string }>(
        `SELECT source.location_key AS from_key, destination.location_key AS to_key
           FROM world_routes route
           JOIN world_locations source
             ON source.world_id = route.world_id AND source.location_id = route.from_location_id
           JOIN world_locations destination
             ON destination.world_id = route.world_id AND destination.location_id = route.to_location_id
          WHERE route.world_id = $1`,
        [ref.worldId],
      ),
    ]);
    const position = positions[0];
    assert.ok(position, `agent ${agentKey} should exist`);

    const pending: string[] = [position.player_location];
    const previous = new Map<string, string | null>([[position.player_location, null]]);
    while (pending.length > 0 && !previous.has(position.agent_location)) {
      const current = pending.shift()!;
      for (const route of routes.filter((candidate) => candidate.from_key === current)) {
        if (previous.has(route.to_key)) continue;
        previous.set(route.to_key, current);
        pending.push(route.to_key);
      }
    }
    assert.ok(previous.has(position.agent_location), `no route to ${agentKey}`);

    const path: string[] = [];
    for (let cursor = position.agent_location; cursor !== position.player_location;) {
      path.unshift(cursor);
      cursor = previous.get(cursor)!;
    }
    for (const [index, locationKey] of path.entries()) {
      const move = await queuePlayerMove(ref, locationKey, `canonical-move-${index}`);
      assert.equal(move.locationKey, locationKey);
    }
    return path;
  }

  async function createClaimMemory(
    ref: { worldId: string; sessionId: string },
    keyPrefix: string,
  ) {
    const inference = createStubClient();
    const conversation = await startConversation({
      ...ref,
      agentKey: 'tobias_reeve',
      idempotencyKey: `${keyPrefix}-start`,
    });
    const result = await takeConversationTurn({
      ...ref,
      conversationId: conversation.conversationId,
      text: 'The accused House ordered Edryc\'s murder. Its leaders are guilty.',
      idempotencyKey: `${keyPrefix}-turn`,
      inference,
    });
    await closeConversation({
      ...ref,
      conversationId: conversation.conversationId,
      idempotencyKey: `${keyPrefix}-close`,
      inference,
    });
    return result.turn;
  }

  test('moves, persists, reconnects, recalls through ANN, and produces a downstream consequence', async () => {
    const ref = await freshWorld(303);
    const path = await moveToAgent(ref, 'tobias_reeve');
    assert.ok(path.length > 0, 'the public movement command path should reach Tobias');

    const firstTurn = await createClaimMemory(ref, 'canonical-first');
    assert.ok(firstTurn.referencedClaimKeys.includes('target_house_ordered_murder'));

    const immediate = await query<{ rumor_id: string; claim_id: string; agent_id: string }>(
      `SELECT rumor.rumor_id, rumor.claim_id, spread.agent_id
         FROM world_rumors rumor
         JOIN world_claims claim
           ON claim.world_id = rumor.world_id AND claim.claim_id = rumor.claim_id
         JOIN world_rumor_spread spread
           ON spread.world_id = rumor.world_id AND spread.rumor_id = rumor.rumor_id
         JOIN world_agents agent
           ON agent.world_id = spread.world_id AND agent.agent_id = spread.agent_id
        WHERE rumor.world_id = $1 AND claim.claim_key = 'target_house_ordered_murder'
          AND agent.agent_key = 'tobias_reeve'
        ORDER BY rumor.created_tick, rumor.rumor_id LIMIT 1`,
      [ref.worldId],
    );
    assert.ok(immediate[0], 'the first public turn should visibly seed Tobias with the rumor');

    const memories = await query<{ memory_id: string; claim_key: string; source_turn_id: string }>(
      `SELECT source.memory_id, source.claim_key, source.source_id AS source_turn_id
         FROM archivist_memory_sources source
        WHERE source.world_id = $1 AND source.agent_key = 'tobias_reeve'
          AND source.claim_key = 'target_house_ordered_murder' AND source.source_kind = 'turn'
        ORDER BY source.memory_tick, source.memory_id, source.edge_id`,
      [ref.worldId],
    );
    const memory = memories.find((row) => row.source_turn_id === firstTurn.turnId);
    assert.ok(memory, 'closing should write a claim-linked durable memory and source edge');

    // Closing and reopening the pool simulates a new web process handling the
    // same signed-session identity; ownership must be recovered from CockroachDB.
    await closePool();
    const resumed = await assertSession(ref);
    assert.equal(resumed.worldStatus, 'active');

    const inference = createStubClient();
    const laterConversation = await startConversation({
      ...ref,
      agentKey: 'tobias_reeve',
      idempotencyKey: 'canonical-later-start',
    });
    const later = await takeConversationTurn({
      ...ref,
      conversationId: laterConversation.conversationId,
      text: 'Do you remember what I said about the accused House ordering Edryc\'s murder?',
      idempotencyKey: 'canonical-later-turn',
      inference,
    });
    const recalled = later.turn.recalledMemories.find(
      (candidate) => candidate.memoryId === memory.memory_id,
    );
    assert.ok(recalled, 'the later turn should name the durable memory');
    assert.ok(recalled.candidatePaths.includes('ann'), 'the memory must enter through ANN/vector recall');

    const accesses = await query<{ access_id: string; accessed_tick: number }>(
      `SELECT access_id, accessed_tick FROM archivist_memory_accesses
        WHERE world_id = $1 AND memory_id = $2 ORDER BY accessed_tick, access_id`,
      [ref.worldId, memory.memory_id],
    );
    assert.ok(accesses.length > 0, 'retrieval should append an access record');

    const outcomes = await query<{ outcome_id: string; recalled_memories: unknown }>(
      `SELECT outcome_id, recalled_memories FROM archivist_cognition
        WHERE world_id = $1 AND outcome_kind = 'conversation_turn' AND outcome_id = $2`,
      [ref.worldId, later.turn.turnId],
    );
    assert.deepEqual(outcomes[0]?.recalled_memories, later.turn.recalledMemories);

    const detail = await getAgentDetail(ref, 'tobias_reeve');
    const trace = detail.memoryTrace.find((item) => item.memoryId === memory.memory_id);
    assert.equal(trace?.recalledByTurnId, later.turn.turnId);
    assert.ok(trace?.candidatePaths.includes('ann'));

    await closeConversation({
      ...ref,
      conversationId: laterConversation.conversationId,
      idempotencyKey: 'canonical-later-close',
      inference,
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      const spread = await query<{ count: number }>(
        `SELECT count(*)::INT8 AS count
           FROM world_rumor_spread spread
           JOIN world_rumors rumor
             ON rumor.world_id = spread.world_id AND rumor.rumor_id = spread.rumor_id
          WHERE rumor.world_id = $1 AND rumor.rumor_id = $2`,
        [ref.worldId, immediate[0].rumor_id],
      );
      if ((spread[0]?.count ?? 0) > 1) break;
      await runTick({ worldId: ref.worldId, inference, allowDistortion: false });
    }
    const consequence = await query<{
      rumor_id: string; recipient_id: string; recipient_key: string; received_tick: number;
    }>(
      `SELECT spread.rumor_id, spread.agent_id AS recipient_id,
              recipient.agent_key AS recipient_key, spread.received_tick
         FROM world_rumor_spread spread
         JOIN world_agents recipient
           ON recipient.world_id = spread.world_id AND recipient.agent_id = spread.agent_id
        WHERE spread.world_id = $1 AND spread.rumor_id = $2
          AND recipient.agent_key != 'tobias_reeve'
        ORDER BY spread.received_tick, recipient.agent_key LIMIT 1`,
      [ref.worldId, immediate[0].rumor_id],
    );
    assert.ok(consequence[0], 'a later tick should carry the demonstrated rumor to another agent');

    const other = await freshWorld(8_207);
    await moveToAgent(other, 'tobias_reeve');
    await createClaimMemory(other, 'canonical-other');
    const scoped = await query<{ world_id: string }>(
      `SELECT world_id FROM archivist_memory_sources
        WHERE world_id = $1 AND claim_key = 'target_house_ordered_murder'`,
      [ref.worldId],
    );
    assert.ok(scoped.length > 0);
    assert.ok(scoped.every((row) => row.world_id === ref.worldId),
      'an explicit world filter must never return another private world');
  });
});
