import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../database/db.ts';
import {
  getAgentDetail, getGameSync, queuePlayerMove, queueTimeScale, SessionAccessError,
  upgradeLegacyWorldInferenceProfile,
} from './game-api.ts';
import {
  closeConversation, startConversation, takeConversationTurn,
} from './conversation.ts';
import { createStubClient } from '../inference/index.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const here = dirname(fileURLToPath(import.meta.url));

describe('session game API against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId = '';
  let nextSeed = 7_100;
  const worlds: string[] = [];

  before(async () => {
    const scenario = await loadScenarioFile(join(here, '..', '..', 'scenario', 'hollowmere-v2.json'));
    scenarioVersionId = (await publishScenario(scenario)).scenarioVersionId;
  });

  after(async () => {
    for (const worldId of worlds) await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
    await closePool();
  });

  async function freshWorld() {
    const seed = nextSeed++;
    const sessionId = `game-api-${seed}-${Date.now()}`;
    const world = await instantiateWorld({
      scenarioVersionId,
      seed,
      sessionId,
      playerLocationKey: 'high_row',
    });
    worlds.push(world.worldId);
    return { worldId: world.worldId, sessionId };
  }

  async function adjacentLocation(ref: { worldId: string; sessionId: string }) {
    const rows = await query<{ location_key: string }>(
      `SELECT destination.location_key
         FROM world_players player
         JOIN world_routes route
           ON route.world_id = player.world_id
          AND route.from_location_id = player.location_id
         JOIN world_locations destination
           ON destination.world_id = route.world_id
          AND destination.location_id = route.to_location_id
        WHERE player.world_id = $1 AND player.session_id = $2
        ORDER BY destination.location_key
        LIMIT 1`,
      [ref.worldId, ref.sessionId],
    );
    assert.ok(rows[0]);
    return rows[0].location_key;
  }

  test('sync is session-scoped and rejects a foreign session', async () => {
    const ref = await freshWorld();
    const sync = await getGameSync(ref);
    assert.equal(sync.world.worldId, ref.worldId);
    assert.equal(sync.player.locationKey, 'high_row');
    await assert.rejects(
      getGameSync({ ...ref, sessionId: 'not-the-owner' }),
      SessionAccessError,
    );
  });

  test('a player can adopt a live provider for a legacy stub world only once', async () => {
    const ref = await freshWorld();
    assert.equal(await upgradeLegacyWorldInferenceProfile(ref, 'azure_sol'), true);
    assert.equal(await upgradeLegacyWorldInferenceProfile(ref, 'azure_terra'), false);
    assert.equal(await upgradeLegacyWorldInferenceProfile(
      { ...ref, sessionId: 'not-the-owner' }, 'azure_terra',
    ), false);
    const profile = await query<{ inference_profile: string }>(
      `SELECT inference_profile FROM worlds WHERE world_id = $1`, [ref.worldId],
    );
    assert.equal(profile[0]?.inference_profile, 'azure_sol');
  });

  test('agent detail exposes a bounded world-scoped memory trace with recall paths', async () => {
    const ref = await freshWorld();
    const [target] = await query<{ agent_id: string; agent_key: string }>(
      `SELECT agent.agent_id, agent.agent_key
         FROM world_agents agent
         JOIN world_players player
           ON player.world_id = agent.world_id AND player.location_id = agent.location_id
        WHERE player.world_id = $1 AND player.session_id = $2
        ORDER BY agent.agent_key LIMIT 1`,
      [ref.worldId, ref.sessionId],
    );
    assert.ok(target);
    const inference = createStubClient();
    const first = await startConversation({
      ...ref, agentKey: target.agent_key, idempotencyKey: crypto.randomUUID(),
    });
    const firstTurn = await takeConversationTurn({
      ...ref,
      conversationId: first.conversationId,
      text: 'Remember that I warned you about the chapel ledger.',
      idempotencyKey: crypto.randomUUID(),
      inference,
    });
    await closeConversation({
      ...ref,
      conversationId: first.conversationId,
      idempotencyKey: crypto.randomUUID(),
      inference,
    });
    const [formed] = await query<{ memory_id: string }>(
      `SELECT memory.memory_id
         FROM world_memories memory
         JOIN memory_source_edges edge
           ON edge.world_id = memory.world_id AND edge.memory_id = memory.memory_id
        WHERE memory.world_id = $1 AND memory.agent_id = $2
          AND edge.source_turn_id = $3`,
      [ref.worldId, target.agent_id, firstTurn.turn.turnId],
    );
    assert.ok(formed);

    const second = await startConversation({
      ...ref, agentKey: target.agent_key, idempotencyKey: crypto.randomUUID(),
    });
    const recalled = await takeConversationTurn({
      ...ref,
      conversationId: second.conversationId,
      text: 'What did I ask you to remember?',
      idempotencyKey: crypto.randomUUID(),
      inference,
    });

    const foreign = await freshWorld();
    const [foreignAgent] = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
      [foreign.worldId, target.agent_key],
    );
    const [foreignEvent] = await query<{ event_id: string }>(
      `SELECT event_id FROM world_events WHERE world_id = $1 ORDER BY tick, seq LIMIT 1`,
      [foreign.worldId],
    );
    const foreignContent = 'FOREIGN WORLD MEMORY MUST NEVER APPEAR';
    const foreignVector = (await inference.embed([foreignContent])).vectors[0]!;
    const foreignMemoryId = crypto.randomUUID();
    await query(
      `INSERT INTO world_memories
         (world_id, memory_id, agent_id, tick, seq, kind, content, embedding, importance)
       VALUES ($1, $2, $3, 0, 9900002, 'observation', $4, $5, 10000)`,
      [foreign.worldId, foreignMemoryId, foreignAgent!.agent_id, foreignContent,
        `[${foreignVector.join(',')}]`],
    );
    await query(
      `INSERT INTO memory_source_edges
         (world_id, edge_id, memory_id, source_kind, source_event_id)
       VALUES ($1, $2, $3, 'event', $4)`,
      [foreign.worldId, crypto.randomUUID(), foreignMemoryId, foreignEvent!.event_id],
    );

    const detail = await getAgentDetail(ref, target.agent_key);
    assert.ok(detail.memoryTrace.length > 0 && detail.memoryTrace.length <= 5);
    const memory = detail.memoryTrace.find((item) => item.memoryId === formed.memory_id);
    assert.ok(memory);
    assert.equal(memory.sourceKind, 'turn');
    assert.equal(memory.sourceId, firstTurn.turn.turnId);
    assert.equal(memory.recalledByTurnId, recalled.turn.turnId);
    assert.ok(memory.candidatePaths.length > 0);
    assert.ok(memory.formedTick >= 0);
    assert.ok(memory.lastAccessedTick != null);
    assert.ok(memory.excerpt.length > 0 && memory.excerpt.length <= 220);
    const serialized = JSON.stringify(detail.memoryTrace);
    assert.doesNotMatch(serialized, /FOREIGN WORLD MEMORY|embedding|systemPrompt|userPrompt/);
  });

  test('movement applies immediately, records its tick, and replays idempotently', async () => {
    const ref = await freshWorld();
    const locationKey = await adjacentLocation(ref);
    const idempotencyKey = crypto.randomUUID();
    const before = await getGameSync(ref);

    const moved = await queuePlayerMove(ref, locationKey, idempotencyKey);
    const replayed = await queuePlayerMove(ref, locationKey, idempotencyKey);
    const after = await getGameSync(ref);
    const commands = await query<{ applied_tick: number; count: number }>(
      `SELECT min(applied_tick)::INT8 AS applied_tick, count(*)::INT8 AS count
         FROM world_commands
        WHERE world_id = $1 AND idempotency_key = $2`,
      [ref.worldId, idempotencyKey],
    );

    assert.notEqual(before.player.locationKey, locationKey);
    assert.equal(after.player.locationKey, locationKey);
    assert.equal(after.player.pendingMove, null);
    assert.equal(moved.locationKey, locationKey);
    assert.equal(moved.appliedTick, before.world.currentTick);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.commandId, moved.commandId);
    assert.equal(replayed.locationKey, locationKey);
    assert.equal(commands[0]?.count, 1);
    assert.equal(commands[0]?.applied_tick, moved.appliedTick);
  });

  test('concurrent duplicate movement produces one applied command', async () => {
    const ref = await freshWorld();
    const locationKey = await adjacentLocation(ref);
    const idempotencyKey = crypto.randomUUID();
    const results = await Promise.all([
      queuePlayerMove(ref, locationKey, idempotencyKey),
      queuePlayerMove(ref, locationKey, idempotencyKey),
    ]);
    const commands = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_commands
        WHERE world_id = $1 AND idempotency_key = $2`,
      [ref.worldId, idempotencyKey],
    );
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(new Set(results.map((result) => result.commandId)).size, 1);
    assert.equal(commands[0]?.count, 1);
  });

  test('a validated legacy pending move upgrades once but not after the world pauses', async () => {
    const active = await freshWorld();
    const activeDestination = await adjacentLocation(active);
    const activeKey = crypto.randomUUID();
    await insertLegacyCommand(active, 'move_player', activeKey, { locationKey: activeDestination });
    const upgraded = await queuePlayerMove(active, activeDestination, activeKey);
    assert.equal(upgraded.replayed, true);
    assert.equal(upgraded.locationKey, activeDestination);
    assert.equal((await getGameSync(active)).player.locationKey, activeDestination);

    const paused = await freshWorld();
    const pausedDestination = await adjacentLocation(paused);
    const pausedKey = crypto.randomUUID();
    await insertLegacyCommand(paused, 'move_player', pausedKey, { locationKey: pausedDestination });
    await query(`UPDATE worlds SET status = 'paused' WHERE world_id = $1`, [paused.worldId]);
    await assert.rejects(
      queuePlayerMove(paused, pausedDestination, pausedKey),
      /world is not active/,
    );
    const pending = await query<{ applied_tick: number | null }>(
      `SELECT applied_tick FROM world_commands WHERE world_id = $1 AND idempotency_key = $2`,
      [paused.worldId, pausedKey],
    );
    assert.equal(pending[0]?.applied_tick, null);
    assert.equal((await getGameSync(paused)).player.locationKey, 'high_row');
  });

  test('movement rejects non-adjacent destinations and open conversations', async () => {
    const nonAdjacent = await freshWorld();
    const locations = await query<{ location_key: string }>(
      `SELECT location.location_key
         FROM world_locations location
         JOIN world_players player ON player.world_id = location.world_id
        WHERE player.world_id = $1 AND player.session_id = $2
          AND location.location_id != player.location_id
          AND NOT EXISTS (
            SELECT 1 FROM world_routes route
             WHERE route.world_id = player.world_id
               AND route.from_location_id = player.location_id
               AND route.to_location_id = location.location_id
          )
        ORDER BY location.location_key LIMIT 1`,
      [nonAdjacent.worldId, nonAdjacent.sessionId],
    );
    assert.ok(locations[0]);
    await assert.rejects(
      queuePlayerMove(nonAdjacent, locations[0].location_key, crypto.randomUUID()),
      /destination is not adjacent/,
    );

    const held = await freshWorld();
    const agents = await query<{ agent_key: string }>(
      `SELECT agent.agent_key
         FROM world_agents agent
         JOIN world_players player
           ON player.world_id = agent.world_id AND player.location_id = agent.location_id
        WHERE player.world_id = $1 AND player.session_id = $2
        ORDER BY agent.agent_key LIMIT 1`,
      [held.worldId, held.sessionId],
    );
    assert.ok(agents[0]);
    await startConversation({
      ...held,
      agentKey: agents[0].agent_key,
      idempotencyKey: crypto.randomUUID(),
    });
    await assert.rejects(
      queuePlayerMove(held, await adjacentLocation(held), crypto.randomUUID()),
      /end the conversation before travelling/,
    );
  });

  test('time scale applies immediately and a paused legacy command stays pending', async () => {
    const active = await freshWorld();
    const activeKey = crypto.randomUUID();
    const changed = await queueTimeScale(active, 20_000, activeKey);
    const world = await query<{ time_scale: number; applied_tick: number }>(
      `SELECT world.time_scale, command.applied_tick
         FROM worlds world
         JOIN world_commands command ON command.world_id = world.world_id
        WHERE world.world_id = $1 AND command.command_id = $2`,
      [active.worldId, changed.commandId],
    );
    assert.equal(world[0]?.time_scale, 20_000);
    assert.equal(typeof world[0]?.applied_tick, 'number');
    assert.equal((await queueTimeScale(active, 20_000, activeKey)).replayed, true);

    const paused = await freshWorld();
    const pausedKey = crypto.randomUUID();
    await insertLegacyCommand(paused, 'set_time_scale', pausedKey, { timeScale: 40_000 });
    await query(`UPDATE worlds SET status = 'paused' WHERE world_id = $1`, [paused.worldId]);
    await assert.rejects(queueTimeScale(paused, 40_000, pausedKey), /world is not active/);
    const unchanged = await query<{ time_scale: number; applied_tick: number | null }>(
      `SELECT world.time_scale, command.applied_tick
         FROM worlds world
         JOIN world_commands command ON command.world_id = world.world_id
        WHERE world.world_id = $1 AND command.idempotency_key = $2`,
      [paused.worldId, pausedKey],
    );
    assert.equal(unchanged[0]?.time_scale, 10_000);
    assert.equal(unchanged[0]?.applied_tick, null);
  });

  async function insertLegacyCommand(
    ref: { worldId: string; sessionId: string },
    kind: 'move_player' | 'set_time_scale',
    idempotencyKey: string,
    payload: { locationKey: string } | { timeScale: number },
  ) {
    const players = await query<{ player_id: string }>(
      `SELECT player_id FROM world_players WHERE world_id = $1 AND session_id = $2`,
      [ref.worldId, ref.sessionId],
    );
    const sequences = await query<{ command_seq: number }>(
      `UPDATE worlds SET command_seq = command_seq + 1
        WHERE world_id = $1 RETURNING command_seq`,
      [ref.worldId],
    );
    const body = kind === 'move_player'
      ? { playerId: players[0]?.player_id, ...payload }
      : payload;
    await query(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [ref.worldId, idempotencyKey, sequences[0]?.command_seq, kind, JSON.stringify(body)],
    );
  }
});
