import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from './db.ts';
import {
  getGameSync, queuePlayerMove, queueTimeScale, SessionAccessError,
} from './game-api.ts';
import { startConversation } from './conversation.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const here = dirname(fileURLToPath(import.meta.url));

describe('session game API against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId = '';
  let nextSeed = 7_100;
  const worlds: string[] = [];

  before(async () => {
    const scenario = await loadScenarioFile(join(here, '..', 'scenario', 'hollowmere-v2.json'));
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
