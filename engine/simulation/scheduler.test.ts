/**
 * The scheduler loop and world lifecycle.
 *
 * The property worth protecting is that two schedulers pointed at the same
 * database advance each world exactly once between them — not that a single
 * scheduler works, which is the easy case.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query } from '../database/db.ts';
import { createStubClient } from '../inference/index.ts';
import { IDLE_PAUSE_MS, MAX_ACTIVE_RUNTIME_MS, addActiveRuntime, resumeWorld, sweepWorlds } from '../database/lifecycle.ts';
import { createScheduler } from '../../scheduler/loop.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe('the scheduler against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    scenarioVersionId = (await publishScenario(scenario)).scenarioVersionId;
  });

  after(async () => {
    await closePool();
  });

  const freshWorld = async (seed: number): Promise<string> => {
    const world = await instantiateWorld({
      scenarioVersionId, seed, sessionId: `sched-${seed}-${Date.now()}`,
    });
    return world.worldId;
  };

  test('two schedulers on one world commit each tick exactly once', async () => {
    const worldId = await freshWorld(401);
    const inference = createStubClient();
    const silence = (): void => {};

    // Both are pointed at the same database with the same settings, and told to
    // run as fast as they can. This is the split-brain rehearsal.
    const schedulers = ['worker-a', 'worker-b'].map((owner) => createScheduler({
      inference, owner, tickIntervalMs: 0, pollIntervalMs: 10,
      leaseTtlMs: 5_000, maxWorlds: 5, log: silence,
      // Scoped to this world: an unscoped worker would also claim the worlds
      // other suites are stepping by hand, and advance them underneath.
      only: [worldId],
    }));

    for (const scheduler of schedulers) scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await Promise.all(schedulers.map((scheduler) => scheduler.stop()));

    const commits = await query<{ tick: number; count: number }>(
      `SELECT tick, count(*)::INT8 AS count FROM world_tick_commits
        WHERE world_id = $1 GROUP BY tick ORDER BY tick`, [worldId]);
    assert.ok(commits.length > 1, 'the world should have advanced at all');
    for (const commit of commits) {
      assert.equal(commit.count, 1, `tick ${commit.tick} committed more than once`);
    }

    // Ticks must also be contiguous: a gap would mean a tick was claimed and
    // then lost rather than applied.
    const ticks = commits.map((c) => c.tick);
    assert.deepEqual(ticks, ticks.map((_, index) => index + 1), 'ticks must be gapless');

    const duplicates = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM (
         SELECT tick, seq FROM world_events WHERE world_id = $1
          GROUP BY tick, seq HAVING count(*) > 1)`, [worldId]);
    assert.equal(duplicates[0]!.count, 0, 'no tick may have applied its effects twice');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('an idle world is paused and can be resumed where it left off', async () => {
    const worldId = await freshWorld(402);

    await query(
      `UPDATE worlds SET last_activity_at = now() - ($2 || ' milliseconds')::INTERVAL
        WHERE world_id = $1`, [worldId, IDLE_PAUSE_MS + 60_000]);

    // Another scheduler may win this idempotent update while this suite shares
    // the integration database. The contract is the durable state, not which
    // worker reports the transition in its local sweep count.
    await sweepWorlds();

    const paused = await query<{ status: string }>(
      `SELECT status FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(paused[0]!.status, 'paused');

    assert.equal(await resumeWorld(worldId), true);
    const resumed = await query<{ status: string }>(
      `SELECT status FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(resumed[0]!.status, 'active');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a world that has used its runtime allowance is ended, not merely paused', async () => {
    const worldId = await freshWorld(403);

    // Keep an unscoped integration worker from advancing this fixture between
    // setup and the lifecycle sweep. Exhaustion intentionally applies to both
    // active and paused worlds.
    await query(`UPDATE worlds SET status = 'paused' WHERE world_id = $1`, [worldId]);

    const total = await addActiveRuntime(worldId, MAX_ACTIVE_RUNTIME_MS);
    assert.ok(total >= MAX_ACTIVE_RUNTIME_MS);

    await sweepWorlds();

    const world = await query<{ status: string; ending: string }>(
      `SELECT status, ending FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(world[0]!.status, 'ended');
    assert.equal(world[0]!.ending, 'expired', 'the cap ends a world without deciding its story');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });
});
