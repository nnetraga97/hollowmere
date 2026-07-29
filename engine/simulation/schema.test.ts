/**
 * Schema conformance.
 *
 * These are the "Conventions" acceptance tests from the plan. They exist
 * because every convention here fails *silently* if unenforced: a float column
 * still stores numbers, a missing composite FK still accepts writes, and a
 * scenario row can be edited without complaint. Each test asserts the database
 * itself refuses the bad case.
 *
 * Requires a running cluster with the schema applied:
 *   npm run db:up && DATABASE_URL=... node scripts/migrate.ts --fresh
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { closePool, query, withSerializable } from '../database/db.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suite = HAS_DB ? describe : describe.skip;

suite('schema conformance', () => {
  before(async () => {
    // Fail loudly if the schema was never applied, rather than reporting a
    // confusing cascade of missing-table errors.
    const tables = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM information_schema.tables
       WHERE table_schema = 'public'`,
    );
    assert.ok((tables[0]?.count ?? 0) > 20, 'schema does not appear to be applied');
  });

  after(async () => {
    await closePool();
  });

  test('no float or decimal columns exist outside VECTOR embeddings', async () => {
    const rows = await query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (data_type ILIKE '%float%' OR data_type ILIKE '%decimal%'
               OR data_type ILIKE '%numeric%' OR data_type ILIKE '%real%')
        ORDER BY table_name, column_name`,
    );
    assert.deepEqual(rows, [], 'simulation values must be fixed-point INT8');
  });

  test('every per-world table carries world_id in its primary key', async () => {
    // Any table with a world_id column is world-scoped and must be keyed by it,
    // otherwise rows from two worlds could collide or leak.
    const rows = await query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.column_name = 'world_id'
          AND NOT EXISTS (
            SELECT 1
              FROM information_schema.key_column_usage k
              JOIN information_schema.table_constraints t
                ON t.constraint_name = k.constraint_name
               AND t.table_name = k.table_name
             WHERE k.table_name = c.table_name
               AND k.column_name = 'world_id'
               AND t.constraint_type = 'PRIMARY KEY'
          )
        ORDER BY c.table_name`,
    );
    assert.deepEqual(rows, [], 'these world-scoped tables are missing world_id from their PK');
  });

  test('append-only history tables carry a (tick, seq) total order', async () => {
    const historyTables = ['world_events', 'world_memories', 'belief_updates'];
    for (const table of historyTables) {
      const rows = await query<{ count: number }>(
        `SELECT count(*)::INT8 AS count
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND column_name IN ('tick', 'seq')`,
        [table],
      );
      assert.equal(rows[0]?.count, 2, `${table} must have both tick and seq`);
    }
  });

  test('a cross-world reference is rejected by the database', async () => {
    const scenarioId = await seedMinimalScenario();
    const worldA = await createWorld(scenarioId);
    const worldB = await createWorld(scenarioId);

    const [locA] = await query<{ location_id: string }>(
      `SELECT location_id FROM world_locations WHERE world_id = $1`,
      [worldA],
    );
    assert.ok(locA, 'world A should have a location');

    // Point a row in world B at world A's location. The composite FK must
    // refuse this — it is the structural guarantee behind world isolation.
    await assert.rejects(
      query(
        `INSERT INTO world_players (world_id, session_id, location_id)
         VALUES ($1, $2, $3)`,
        [worldB, `cross-world-${Date.now()}`, locA.location_id],
      ),
      /foreign key|violates/i,
      'composite FK should prevent referencing another world',
    );

    await cleanupWorlds([worldA, worldB]);
  });

  test('a published scenario row cannot be silently duplicated', async () => {
    const scenarioId = await seedMinimalScenario();
    await assert.rejects(
      query(
        `INSERT INTO faction_templates
           (scenario_version_id, faction_key, name, ideology, leader_agent_key)
         VALUES ($1, 'ember', 'Duplicate', 'dup', 'a1')`,
        [scenarioId],
      ),
      /duplicate key|unique/i,
      'scenario content is immutable once published',
    );
  });

  test('fixed-point CHECK constraints reject out-of-range values', async () => {
    const scenarioId = await seedMinimalScenario();
    const worldId = await createWorld(scenarioId);

    await assert.rejects(
      query(`UPDATE world_state SET global_tension = 10001 WHERE world_id = $1`, [worldId]),
      /violates check|check constraint/i,
      'tension must stay within [0, 10000]',
    );

    await cleanupWorlds([worldId]);
  });

  test('escalation stage is constrained to the known ladder', async () => {
    const scenarioId = await seedMinimalScenario();
    const worldId = await createWorld(scenarioId);

    await assert.rejects(
      query(`UPDATE world_state SET escalation_stage = 'apocalypse' WHERE world_id = $1`, [worldId]),
      /violates check|check constraint/i,
    );

    await cleanupWorlds([worldId]);
  });

  test('two writers cannot commit the same tick', async () => {
    const scenarioId = await seedMinimalScenario();
    const worldId = await createWorld(scenarioId);

    const commitTick = async (): Promise<'ok' | 'rejected'> => {
      try {
        await withSerializable(async (client) => {
          await client.query(
            `INSERT INTO world_tick_commits (world_id, tick) VALUES ($1, 7)`,
            [worldId],
          );
        });
        return 'ok';
      } catch {
        return 'rejected';
      }
    };

    const results = await Promise.all([commitTick(), commitTick()]);
    assert.equal(
      results.filter((r) => r === 'ok').length,
      1,
      'exactly one writer may commit a given tick',
    );

    await cleanupWorlds([worldId]);
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let cachedScenarioId: string | undefined;

/**
 * The smallest scenario that satisfies every foreign key: one faction, one
 * district, one location, one agent.
 */
async function seedMinimalScenario(): Promise<string> {
  if (cachedScenarioId) return cachedScenarioId;

  const existing = await query<{ scenario_version_id: string }>(
    `SELECT scenario_version_id FROM scenario_versions WHERE version = 'test-minimal'`,
  );
  if (existing[0]) {
    cachedScenarioId = existing[0].scenario_version_id;
    return cachedScenarioId;
  }

  const [row] = await query<{ scenario_version_id: string }>(
    `INSERT INTO scenario_versions (version, name, checksum, schema_version)
     VALUES ('test-minimal', 'Test Minimal', 'checksum-test-minimal', 1)
     RETURNING scenario_version_id`,
  );
  const scenarioId = row!.scenario_version_id;

  await query(
    `INSERT INTO faction_templates
       (scenario_version_id, faction_key, name, ideology, leader_agent_key)
     VALUES ($1, 'ember', 'The Ember', 'tradition', 'a1')`,
    [scenarioId],
  );
  await query(
    `INSERT INTO district_templates
       (scenario_version_id, district_key, name, controlling_faction_key)
     VALUES ($1, 'market', 'Market Square', 'ember')`,
    [scenarioId],
  );
  await query(
    `INSERT INTO location_templates
       (scenario_version_id, location_key, district_key, name, x, y, gossip_bonus)
     VALUES ($1, 'market_square', 'market', 'Market Square', 10, 10, 2000)`,
    [scenarioId],
  );
  await query(
    `INSERT INTO agent_templates
       (scenario_version_id, agent_key, name, faction_key, home_location_key,
        work_location_key, persona, routine, credulity, talkativeness)
     VALUES ($1, 'a1', 'Test Agent', 'ember', 'market_square', 'market_square',
             '{"summary":"a test agent"}', '{"morning":"market_square"}', 5000, 5000)`,
    [scenarioId],
  );

  cachedScenarioId = scenarioId;
  return scenarioId;
}

/** Instantiate a world with one faction, one location, and world_state. */
async function createWorld(scenarioId: string): Promise<string> {
  const [world] = await query<{ world_id: string }>(
    `INSERT INTO worlds (scenario_version_id, seed) VALUES ($1, 1) RETURNING world_id`,
    [scenarioId],
  );
  const worldId = world!.world_id;

  const [faction] = await query<{ faction_id: string }>(
    `INSERT INTO world_factions (world_id, faction_key, name, ideology)
     VALUES ($1, 'ember', 'The Ember', 'tradition') RETURNING faction_id`,
    [worldId],
  );
  await query(
    `INSERT INTO world_locations
       (world_id, location_key, district_key, name, x, y, controlling_faction_id)
     VALUES ($1, 'market_square', 'market', 'Market Square', 10, 10, $2)`,
    [worldId, faction!.faction_id],
  );
  await query(`INSERT INTO world_state (world_id) VALUES ($1)`, [worldId]);

  return worldId;
}

async function cleanupWorlds(worldIds: readonly string[]): Promise<void> {
  for (const worldId of worldIds) {
    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  }
}
