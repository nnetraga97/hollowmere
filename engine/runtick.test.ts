/**
 * The full tick pipeline.
 *
 * These are the acceptance tests the whole engine exists to pass: that an
 * unattended town destroys itself inside the canonical window, that two
 * schedulers racing one world cannot double-apply a tick, that two worlds
 * cannot touch each other, and that the same seed produces the same town twice.
 *
 * The canonical-arc test runs a few hundred ticks against a real database and
 * takes a couple of minutes. That is the price of testing the property that
 * actually matters, and it is why it is one test rather than twenty.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query } from './db.ts';
import { TIME } from './config.ts';
import { createStubClient } from './inference/index.ts';
import { runTick } from './runtick.ts';
import { stageIndex } from './tension.ts';
import { acquireLease, findSchedulableWorlds, releaseLease, renewLease } from './lease.ts';
import { dayForTick, nextHop, phaseForTick, type RouteGraph } from './movement.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { slowTest } from './slow-tests.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');
const HAS_DB = Boolean(process.env.DATABASE_URL);

/** The window the plan fixes for an unattended run, in ticks. */
const CANONICAL_MIN = 192;
const CANONICAL_MAX = 288;

describe('in-world time', () => {
  test('divides into four phases and ninety-six ticks a day', () => {
    assert.equal(phaseForTick(0), 'morning');
    assert.equal(phaseForTick(TIME.ticksPerPhase), 'midday');
    assert.equal(phaseForTick(TIME.ticksPerPhase * 2), 'evening');
    assert.equal(phaseForTick(TIME.ticksPerPhase * 3), 'night');
    assert.equal(phaseForTick(TIME.ticksPerPhase * 4), 'morning');
    assert.equal(dayForTick(TIME.ticksPerPhase * 4 - 1), 0);
    assert.equal(dayForTick(TIME.ticksPerPhase * 4), 1);
  });
});

describe('pathfinding', () => {
  /** a —1— b —1— c, plus an expensive shortcut a —5— c. */
  const graph: RouteGraph = {
    edges: new Map([
      ['a', [{ to: 'b', cost: 1 }, { to: 'c', cost: 5 }]],
      ['b', [{ to: 'a', cost: 1 }, { to: 'c', cost: 1 }]],
      ['c', [{ to: 'b', cost: 1 }, { to: 'a', cost: 5 }]],
    ]),
    keyById: new Map([['a', 'a'], ['b', 'b'], ['c', 'c']]),
    idByKey: new Map([['a', 'a'], ['b', 'b'], ['c', 'c']]),
  };

  test('takes the cheapest route, not the one with fewest hops', () => {
    assert.equal(nextHop(graph, 'a', 'c'), 'b');
  });

  test('returns nothing when already there', () => {
    assert.equal(nextHop(graph, 'a', 'a'), null);
  });

  test('returns nothing when there is no road', () => {
    const island: RouteGraph = {
      edges: new Map([['a', [{ to: 'b', cost: 1 }]], ['b', [{ to: 'a', cost: 1 }]]]),
      keyById: new Map(), idByKey: new Map(),
    };
    assert.equal(nextHop(island, 'a', 'z'), null);
  });
});

describe('the tick against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    scenarioVersionId = (await publishScenario(scenario)).scenarioVersionId;
  });

  after(async () => {
    await closePool();
  });

  const freshWorld = async (seed: number, isolated = true): Promise<string> => {
    const world = await instantiateWorld({
      scenarioVersionId, seed, sessionId: `tick-${seed}-${Date.now()}-${Math.trunc(seed * 7)}`,
    });
    if (isolated) {
      const leased = await acquireLease(world.worldId, {
        owner: `runtick-test-${process.pid}`,
        ttlMs: 60 * 60 * 1_000,
      });
      assert.equal(leased, true, 'the fixture world must be isolated from a live scheduler');
    }
    return world.worldId;
  };

  test('a tick advances time, moves people, and commits exactly one row', async () => {
    const worldId = await freshWorld(201);
    const inference = createStubClient();

    const report = await runTick({ worldId, inference, allowDistortion: false });
    assert.equal(report.committed, true);
    assert.equal(report.tick, 1);
    assert.ok(report.movements > 0, 'the town should be walking to work');

    const commits = await query<{ tick: number }>(
      `SELECT tick FROM world_tick_commits WHERE world_id = $1 ORDER BY tick`, [worldId]);
    assert.deepEqual(commits.map((c) => c.tick), [1]);

    const world = await query<{ current_tick: number }>(
      `SELECT current_tick FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(world[0]!.current_tick, 1);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('two schedulers racing one tick produce one commit and one set of effects', async () => {
    const worldId = await freshWorld(202);
    const inference = createStubClient();

    // Both are told to run tick 1. Whoever loses the race to claim the row must
    // apply nothing at all — not a duplicate event, not a second belief update.
    const [first, second] = await Promise.all([
      runTick({ worldId, inference, tick: 1, allowDistortion: false }),
      runTick({ worldId, inference, tick: 1, allowDistortion: false }),
    ]);

    const committed = [first, second].filter((r) => r.committed);
    const skipped = [first, second].filter((r) => r.skipped === 'already_committed');
    assert.equal(committed.length, 1, 'exactly one scheduler may commit a tick');
    assert.equal(skipped.length, 1, 'the loser must report why it did nothing');

    const commits = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_tick_commits WHERE world_id = $1 AND tick = 1`,
      [worldId]);
    assert.equal(commits[0]!.count, 1);

    // The real risk is not two commit rows, it is one commit row and two copies
    // of the tick's effects.
    const duplicates = await query<{ tick: number; seq: number; count: number }>(
      `SELECT tick, seq, count(*)::INT8 AS count FROM world_events
        WHERE world_id = $1 GROUP BY tick, seq HAVING count(*) > 1`, [worldId]);
    assert.deepEqual(duplicates, [], 'no event position may be occupied twice');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('activity in one world changes nothing in another', async () => {
    const active = await freshWorld(203);
    const quiet = await freshWorld(204);
    const inference = createStubClient();

    const fingerprint = async (worldId: string) => {
      const rows = await query<{ table_name: string; count: number }>(
        `SELECT 'events' AS table_name, count(*)::INT8 AS count FROM world_events WHERE world_id = $1
         UNION ALL SELECT 'beliefs', count(*)::INT8 FROM agent_beliefs WHERE world_id = $1
         UNION ALL SELECT 'spread', count(*)::INT8 FROM world_rumor_spread WHERE world_id = $1
         UNION ALL SELECT 'memories', count(*)::INT8 FROM world_memories WHERE world_id = $1
         UNION ALL SELECT 'tension', global_tension::INT8 FROM world_state WHERE world_id = $1
         ORDER BY table_name`, [worldId]);
      return rows;
    };

    const before = await fingerprint(quiet);
    for (let tick = 1; tick <= 12; tick++) {
      await runTick({ worldId: active, inference, allowDistortion: false });
    }
    const after = await fingerprint(quiet);

    assert.deepEqual(after, before, 'a busy world must not touch its neighbour');

    await query(`DELETE FROM worlds WHERE world_id IN ($1, $2)`, [active, quiet]);
  });

  test('the same seed produces the same town twice', async () => {
    const inference = createStubClient();

    const run = async (seed: number) => {
      const worldId = await freshWorld(seed);
      for (let tick = 1; tick <= 24; tick++) {
        await runTick({ worldId, inference, allowDistortion: false });
      }

      // Compared by key rather than by id: ids are random per world, and it is
      // the story that must be identical, not the primary keys.
      const events = await query<{ tick: number; kind: string; description: string }>(
        `SELECT tick, kind, description FROM world_events
          WHERE world_id = $1 AND kind != 'movement' ORDER BY tick, seq`, [worldId]);
      const beliefs = await query<{ agent_key: string; claim_key: string; confidence: number }>(
        `SELECT a.agent_key, c.claim_key, b.confidence
           FROM agent_beliefs b
           JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
           JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
          WHERE b.world_id = $1 ORDER BY a.agent_key, c.claim_key`, [worldId]);
      const tension = await query<{ tick: number; global_tension: number; escalation_stage: string }>(
        `SELECT tick, global_tension, escalation_stage FROM world_state_history
          WHERE world_id = $1 ORDER BY tick`, [worldId]);

      await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
      return { events, beliefs, tension };
    };

    const first = await run(4242);
    const second = await run(4242);

    assert.deepEqual(second.tension, first.tension, 'the tension curve must replay exactly');
    assert.deepEqual(second.beliefs, first.beliefs, 'every agent must end up believing the same');
    assert.deepEqual(second.events, first.events, 'the chronicle must be identical');

    const different = await run(9999);
    assert.notDeepEqual(
      different.tension, first.tension,
      'a different seed must produce a different town, or the seed does nothing',
    );
  });

  test('an unattended town destroys itself inside the canonical window', slowTest, async () => {
    const worldId = await freshWorld(42);
    const inference = createStubClient();

    let endedAt: number | null = null;
    let previousStage = 'calm';
    const stageEntries: { stage: string; tick: number }[] = [];

    for (let tick = 1; tick <= TIME.maxTicks; tick++) {
      const report = await runTick({ worldId, inference, allowDistortion: false });
      if (!report.committed) break;

      assert.ok(
        stageIndex(report.stage) >= stageIndex(report.previousStage),
        `stage went backwards at tick ${tick}: ${report.previousStage} -> ${report.stage}`,
      );
      if (report.stage !== previousStage) {
        stageEntries.push({ stage: report.stage, tick });
        previousStage = report.stage;
      }
      if (report.ending) {
        endedAt = tick;
        assert.equal(report.ending, 'war', 'left alone, this town goes to war');
        break;
      }
    }

    assert.ok(endedAt !== null, 'the town must reach an ending within the tick ceiling');
    assert.ok(
      endedAt! >= CANONICAL_MIN && endedAt! <= CANONICAL_MAX,
      `war at tick ${endedAt} is outside the canonical ${CANONICAL_MIN}–${CANONICAL_MAX} window`,
    );

    // The arc has to be legible, not merely to arrive: every stage in turn.
    assert.deepEqual(
      stageEntries.map((e) => e.stage),
      ['suspicion', 'accusations', 'trials', 'first_blood', 'war'],
      'the town must pass through every stage on its way down',
    );

    const world = await query<{ status: string; ending: string }>(
      `SELECT status, ending FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(world[0]!.status, 'ended');
    assert.equal(world[0]!.ending, 'war');

    // A world that has ended stays ended.
    const after = await runTick({ worldId, inference });
    assert.equal(after.committed, false);
    assert.equal(after.skipped, 'not_active');

    // Misinformation is the headline claim, so assert it rather than trusting it:
    // a claim the engine knows to be false must have taken hold anyway.
    const falseBelief = await query<{ claim_key: string; believers: number }>(
      `SELECT c.claim_key, count(*)::INT8 AS believers
         FROM world_claims c
         JOIN agent_beliefs b ON b.world_id = c.world_id AND b.claim_id = c.claim_id
        WHERE c.world_id = $1 AND c.truth = 'false' AND b.confidence >= 4500
        GROUP BY c.claim_key ORDER BY c.claim_key`, [worldId]);
    assert.ok(
      falseBelief.some((row) => row.believers > 5),
      'a false claim should have convinced a good part of the town',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('an exhausted budget degrades cognition instead of failing', async () => {
    const worldId = await freshWorld(205);
    const inference = createStubClient();

    // Spend the world's whole allowance before it has thought at all.
    await query(
      `UPDATE world_budget SET inference_calls = 100000 WHERE world_id = $1`, [worldId]);

    for (let tick = 1; tick <= 8; tick++) {
      const report = await runTick({ worldId, inference, allowDistortion: false });
      assert.equal(report.committed, true, 'a spent budget must not stop the town');
    }

    const records = await query<{ model_id: string }>(
      `SELECT model_id FROM cognition_records WHERE world_id = $1 ORDER BY tick`, [worldId]);
    assert.ok(records.length > 0, 'agents should still be deciding what to do');
    assert.ok(
      records.every((r) => r.model_id === 'deterministic-fallback'),
      'every decision must have come from the rules, not the model',
    );

    // No embedding call means no memory could honestly be formed.
    const memories = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_memories WHERE world_id = $1`, [worldId]);
    assert.equal(memories[0]!.count, 0);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a lease is exclusive, renewable, and releasable', async () => {
    // This case exercises lease acquisition itself, so it deliberately opts out
    // of the fixture lease used to keep a development scheduler away.
    const worldId = await freshWorld(206, false);

    assert.equal(await acquireLease(worldId, { owner: 'worker-a', ttlMs: 60_000 }), true);
    assert.equal(
      await acquireLease(worldId, { owner: 'worker-b', ttlMs: 60_000 }), false,
      'a live lease must exclude everyone else',
    );
    assert.equal(await acquireLease(worldId, { owner: 'worker-a', ttlMs: 60_000 }), true,
      're-taking our own lease is how renewal after a restart works');
    assert.equal(await renewLease(worldId, { owner: 'worker-a', ttlMs: 60_000 }), true);
    assert.equal(await renewLease(worldId, { owner: 'worker-b', ttlMs: 60_000 }), false);

    const held = await findSchedulableWorlds(50);
    assert.ok(!held.includes(worldId), 'a leased world is not up for grabs');

    await releaseLease(worldId, 'worker-a');
    assert.equal(await acquireLease(worldId, { owner: 'worker-b', ttlMs: 60_000 }), true,
      'a released world is immediately available');

    // An expired lease is as good as no lease.
    await query(
      `UPDATE worlds SET lease_expires_at = now() - INTERVAL '1 minute' WHERE world_id = $1`,
      [worldId]);
    assert.equal(await acquireLease(worldId, { owner: 'worker-c', ttlMs: 60_000 }), true);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });
});
