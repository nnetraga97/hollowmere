/**
 * Scenario validation and world instantiation.
 *
 * The validator is the boundary where authored content becomes trusted, so
 * these tests concentrate on what it must refuse: dangling references, an
 * unreachable map, a war without exactly two sides, and anything outside the
 * allowlisted trigger grammar.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query } from './db.ts';
import { ScenarioError, resolveRoutine, validateScenario } from '../scenario/schema.ts';
import { checksumOf, loadScenarioFile, publishScenario } from '../scenario/publish.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v1.json');

const HAS_DB = Boolean(process.env.DATABASE_URL);

/** A minimal but complete scenario, mutated per test to isolate one failure. */
function baseScenario(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: 'unit-test',
    name: 'Unit Test',
    factions: [
      { key: 'a', name: 'A', ideology: 'a', leader: 'a1', belligerent: true },
      { key: 'b', name: 'B', ideology: 'b', leader: 'b1', belligerent: true },
    ],
    districts: [{ key: 'd', name: 'D', controlledBy: null }],
    locations: [
      { key: 'l1', district: 'd', name: 'L1', x: 0, y: 0, gossipBonus: 0 },
      { key: 'l2', district: 'd', name: 'L2', x: 1, y: 0, gossipBonus: 0 },
    ],
    routes: [{ from: 'l1', to: 'l2', cost: 1 }],
    routineStyles: {
      basic: { morning: '@work', midday: '@work', evening: '@home', night: '@home' },
    },
    agents: [
      { key: 'a1', name: 'A One', faction: 'a', home: 'l1', work: 'l2', routine: 'basic',
        summary: 's', traits: [], credulity: 5000, talkativeness: 5000 },
      { key: 'b1', name: 'B One', faction: 'b', home: 'l2', work: 'l1', routine: 'basic',
        summary: 's', traits: [], credulity: 5000, talkativeness: 5000 },
    ],
    claims: [
      { key: 'c1', text: 'c', subject: 'a1', truth: 'unknown', severity: 5000 },
    ],
    triggers: [
      { key: 't1', condition: { fact: 'tick', op: 'gte', value: 5 },
        effects: [{ verb: 'add_global_tension', amount: 100 }], priority: 1, once: true },
    ],
    opening: { location: 'l1', description: 'd', seedRumors: [{ claim: 'c1', heat: 5000, valence: 0 }] },
  };
}

describe('scenario validation', () => {
  test('accepts the base scenario', async () => {
    assert.doesNotThrow(() => validateScenario(baseScenario()));
  });

  test('the shipped Hollowmere scenario is valid', async () => {
    const raw = JSON.parse(await readFile(SCENARIO_PATH, 'utf8'));
    const scenario = validateScenario(raw);
    assert.equal(scenario.agents.length, 40, 'the town should have forty souls');
    assert.equal(scenario.factions.filter((f) => f.belligerent).length, 2);
  });

  test('rejects an unknown faction reference', async () => {
    const s = baseScenario();
    (s.agents as { faction: string }[])[0]!.faction = 'ghost';
    assert.throws(() => validateScenario(s), (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.match(error.issues.join('\n'), /unknown faction "ghost"/);
      return true;
    });
  });

  test('rejects a war without exactly two sides', async () => {
    const s = baseScenario();
    (s.factions as { belligerent: boolean }[])[1]!.belligerent = false;
    assert.throws(() => validateScenario(s), /exactly two factions must be belligerent/);
  });

  test('rejects an unreachable location', async () => {
    const s = baseScenario();
    (s.locations as unknown[]).push(
      { key: 'island', district: 'd', name: 'Island', x: 99, y: 99, gossipBonus: 0 },
    );
    assert.throws(() => validateScenario(s), /unreachable/);
  });

  test('rejects a routine style referencing an unknown location', async () => {
    const s = baseScenario();
    (s.routineStyles as Record<string, Record<string, string>>).basic!.evening = 'nowhere';
    assert.throws(() => validateScenario(s), /unknown location "nowhere"/);
  });

  test('rejects an out-of-range fixed-point value', async () => {
    const s = baseScenario();
    (s.agents as { credulity: number }[])[0]!.credulity = 20_000;
    assert.throws(() => validateScenario(s), /credulity out of range/);
  });

  test('rejects duplicate keys', async () => {
    const s = baseScenario();
    (s.claims as unknown[]).push(
      { key: 'c1', text: 'dup', subject: 'a1', truth: 'true', severity: 1 },
    );
    assert.throws(() => validateScenario(s), /duplicate claim key: c1/);
  });

  test('reports every issue at once rather than one per run', async () => {
    const s = baseScenario();
    (s.agents as { faction: string }[])[0]!.faction = 'ghost';
    (s.agents as { home: string }[])[1]!.home = 'nowhere';
    assert.throws(() => validateScenario(s), (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.ok(error.issues.length >= 2, `expected several issues, got ${error.issues.length}`);
      return true;
    });
  });

  describe('trigger DSL is a closed grammar', () => {
    test('rejects an unknown condition fact', async () => {
      const s = baseScenario();
      (s.triggers as { condition: unknown }[])[0]!.condition =
        { fact: 'process.env', op: 'eq', value: 1 };
      assert.throws(() => validateScenario(s), /unknown condition fact/);
    });

    test('rejects an unknown effect verb', async () => {
      const s = baseScenario();
      (s.triggers as { effects: unknown[] }[])[0]!.effects = [{ verb: 'exec', cmd: 'rm -rf /' }];
      assert.throws(() => validateScenario(s), /unknown effect verb "exec"/);
    });

    test('rejects an unknown escalation stage', async () => {
      const s = baseScenario();
      (s.triggers as { effects: unknown[] }[])[0]!.effects = [
        { verb: 'set_stage', stage: 'apocalypse' },
      ];
      assert.throws(() => validateScenario(s), /set_stage requires a valid stage/);
    });

    test('validates nested all/any/not branches', async () => {
      const s = baseScenario();
      (s.triggers as { condition: unknown }[])[0]!.condition = {
        all: [
          { fact: 'tick', op: 'gte', value: 1 },
          { not: { any: [{ fact: 'bogus', op: 'eq', value: 1 }] } },
        ],
      };
      assert.throws(() => validateScenario(s), /unknown condition fact "bogus"/);
    });

    test('requires a known faction for faction-scoped facts', async () => {
      const s = baseScenario();
      (s.triggers as { condition: unknown }[])[0]!.condition =
        { fact: 'faction_tension', faction: 'ghost', op: 'gte', value: 1 };
      assert.throws(() => validateScenario(s), /faction_tension requires a known faction/);
    });
  });
});

describe('routine resolution', () => {
  test('expands @home and @work per agent', () => {
    const resolved = resolveRoutine(
      { morning: '@work', midday: 'market', evening: '@home', night: '@home' },
      'cottage', 'forge',
    );
    assert.deepEqual(resolved, {
      morning: 'forge', midday: 'market', evening: 'cottage', night: 'cottage',
    });
  });
});

describe('checksum', () => {
  test('is stable regardless of key order', () => {
    const a = validateScenario(baseScenario());
    // Rebuild with the insertion order reversed. Canonicalisation should make
    // this identical, so reformatting the source file is not a content change.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    assert.equal(checksumOf(a), checksumOf(reordered));
  });

  test('changes when content changes', async () => {
    const a = validateScenario(baseScenario());
    const b = validateScenario({ ...(baseScenario()), name: 'Different' });
    assert.notEqual(checksumOf(a), checksumOf(b));
  });
});

// ---------------------------------------------------------------------------

const dbSuite = HAS_DB ? describe : describe.skip;

dbSuite('publish and instantiate', () => {
  let scenarioVersionId: string;

  before(async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const published = await publishScenario(scenario);
    scenarioVersionId = published.scenarioVersionId;
  });

  after(async () => {
    await closePool();
  });

  test('publishing is idempotent by checksum', async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const again = await publishScenario(scenario);
    assert.equal(again.scenarioVersionId, scenarioVersionId);
    assert.equal(again.created, false);
  });

  test('republishing changed content under the same version is refused', async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const tampered = { ...scenario, name: `${scenario.name} (tampered)` };
    await assert.rejects(
      publishScenario(tampered),
      /already published with different content/,
    );
  });

  test('instantiates a complete world', async () => {
    const world = await instantiateWorld({
      scenarioVersionId, seed: 7, sessionId: `test-${Date.now()}-a`,
    });

    const [counts] = await query<{
      agents: number; relationships: number; factions: number;
      claims: number; rumors: number; faction_state: number;
    }>(
      `SELECT
         (SELECT count(*)::INT8 FROM world_agents WHERE world_id = $1) AS agents,
         (SELECT count(*)::INT8 FROM world_relationships WHERE world_id = $1) AS relationships,
         (SELECT count(*)::INT8 FROM world_factions WHERE world_id = $1) AS factions,
         (SELECT count(*)::INT8 FROM world_claims WHERE world_id = $1) AS claims,
         (SELECT count(*)::INT8 FROM world_rumors WHERE world_id = $1) AS rumors,
         (SELECT count(*)::INT8 FROM world_faction_state WHERE world_id = $1) AS faction_state`,
      [world.worldId],
    );

    assert.equal(counts?.agents, 40);
    assert.equal(counts?.factions, 3);
    // Every ordered pair, so gossip weighting always has a defined edge.
    assert.equal(counts?.relationships, 40 * 39);
    assert.equal(counts?.claims, 10);
    assert.equal(counts?.rumors, 3);
    assert.equal(counts?.faction_state, 3);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('faction leaders resolve to real agents', async () => {
    const world = await instantiateWorld({
      scenarioVersionId, seed: 8, sessionId: `test-${Date.now()}-b`,
    });

    const leaders = await query<{ faction_key: string; leader: string }>(
      `SELECT f.faction_key, a.agent_key AS leader
         FROM world_factions f
         JOIN world_agents a
           ON a.world_id = f.world_id AND a.agent_id = f.leader_agent_id
        WHERE f.world_id = $1
        ORDER BY f.faction_key`,
      [world.worldId],
    );
    assert.equal(leaders.length, 3, 'every faction should have a resolved leader');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('rival factions start hostile and allies start warm', async () => {
    const world = await instantiateWorld({
      scenarioVersionId, seed: 9, sessionId: `test-${Date.now()}-c`,
    });

    const [rival] = await query<{ sentiment: number }>(
      `SELECT r.sentiment FROM world_relationships r
         JOIN world_agents src ON src.world_id = r.world_id AND src.agent_id = r.src_agent_id
         JOIN world_agents dst ON dst.world_id = r.world_id AND dst.agent_id = r.dst_agent_id
        WHERE r.world_id = $1 AND src.agent_key = 'maren_aldreth' AND dst.agent_key = 'alric_corvane'`,
      [world.worldId],
    );
    const [ally] = await query<{ sentiment: number }>(
      `SELECT r.sentiment FROM world_relationships r
         JOIN world_agents src ON src.world_id = r.world_id AND src.agent_id = r.src_agent_id
         JOIN world_agents dst ON dst.world_id = r.world_id AND dst.agent_id = r.dst_agent_id
        WHERE r.world_id = $1 AND src.agent_key = 'maren_aldreth' AND dst.agent_key = 'tobias_reeve'`,
      [world.worldId],
    );

    assert.ok((rival?.sentiment ?? 0) < 0, 'rival houses should start hostile');
    assert.ok((ally?.sentiment ?? 0) > 0, 'housemates should start warm');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('two worlds from one scenario are fully isolated', async () => {
    const a = await instantiateWorld({
      scenarioVersionId, seed: 1, sessionId: `test-${Date.now()}-iso-a`,
    });
    const b = await instantiateWorld({
      scenarioVersionId, seed: 2, sessionId: `test-${Date.now()}-iso-b`,
    });

    // Mutating world A must leave world B byte-identical.
    const beforeB = await snapshotTension(b.worldId);
    await query(
      `UPDATE world_state SET global_tension = 7777, escalation_stage = 'trials'
        WHERE world_id = $1`,
      [a.worldId],
    );
    const afterB = await snapshotTension(b.worldId);
    assert.deepEqual(afterB, beforeB, 'world B must be unaffected by writes to world A');

    // And their agent sets share no identifiers at all.
    const [shared] = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_agents x
         JOIN world_agents y ON x.agent_id = y.agent_id
        WHERE x.world_id = $1 AND y.world_id = $2`,
      [a.worldId, b.worldId],
    );
    assert.equal(shared?.count, 0, 'agent ids must not be shared across worlds');

    await query(`DELETE FROM worlds WHERE world_id IN ($1, $2)`, [a.worldId, b.worldId]);
  });
});

async function snapshotTension(worldId: string): Promise<unknown[]> {
  return query(
    `SELECT global_tension, escalation_stage, peace_streak
       FROM world_state WHERE world_id = $1`,
    [worldId],
  );
}
