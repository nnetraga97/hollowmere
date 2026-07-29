/**
 * Replay: re-running a recorded world with no model calls.
 *
 * This is the mechanism that makes real inference affordable. A run costs money
 * once; every rehearsal after that — the resilience demo, the observability
 * work, the video — reads decisions back out of `cognition_records`. That is
 * only true if a recording is *exact*, so what is tested here is mostly the
 * refusals: a recording that no longer matches its inputs must fail loudly
 * rather than produce a plausible run that is quietly wrong.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query } from '../database/db.ts';
import { createStubClient } from '../inference/index.ts';
import { runTick } from './runtick.ts';
import { rewindWorld } from './rewind.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe('replay', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    scenarioVersionId = (await publishScenario(scenario)).scenarioVersionId;
  });

  after(async () => {
    await closePool();
  });

  /** Runs a world far enough for at least one cognition round to be recorded. */
  const recordedWorld = async (
    seed: number, ticks = 12,
  ): Promise<{ worldId: string; tick: number }> => {
    const world = await instantiateWorld({
      scenarioVersionId, seed, sessionId: `replay-${seed}-${Date.now()}`,
    });
    const inference = createStubClient();

    let recordedTick = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      await runTick({ worldId: world.worldId, inference, allowDistortion: false });
      const records = await query<{ tick: number }>(
        `SELECT tick FROM cognition_records WHERE world_id = $1 ORDER BY tick LIMIT 1`,
        [world.worldId]);
      if (records[0] && !recordedTick) recordedTick = records[0].tick;
    }
    assert.ok(recordedTick > 0, 'the world should have thought at least once');
    return { worldId: world.worldId, tick: recordedTick };
  };

  interface Snapshot {
    tick: number; tension: number; stage: string; memories: number; records: number;
  }

  const snapshot = async (worldId: string): Promise<Snapshot> => {
    const [state] = await query<{ tick: number; tension: number; stage: string }>(
      `SELECT w.current_tick AS tick, s.global_tension AS tension,
              s.escalation_stage AS stage
         FROM worlds w JOIN world_state s ON s.world_id = w.world_id
        WHERE w.world_id = $1`, [worldId]);
    const [counts] = await query<{ memories: number; records: number }>(
      `SELECT (SELECT count(*) FROM world_memories WHERE world_id = $1)::INT8 AS memories,
              (SELECT count(*) FROM cognition_records WHERE world_id = $1)::INT8 AS records`,
      [worldId]);
    return { ...state!, ...counts! };
  };

  /** Refuses every call of every kind — what a replay must be able to run against. */
  const strictReplayClient = (): { client: unknown; calls: () => number } => {
    let calls = 0;
    const stub = createStubClient();
    return {
      client: {
        ...stub,
        complete: async () => { calls++; throw new Error('replay made a reasoning call'); },
        stream: async function* (): AsyncGenerator<string, never, void> {
          calls++;
          throw new Error('replay made a reasoning call');
        },
        embed: async () => { calls++; throw new Error('replay made an embedding call'); },
      },
      calls: () => calls,
    };
  };

  /**
   * Refuses every *reasoning* call, and counts embedding calls rather than
   * refusing them.
   *
   * Refusing embeddings would be the stronger client to test against, and §11 of
   * the plan does promise replay runs with "zero Bedrock calls". It does not,
   * today: `think` embeds the situation texts and the round's new memories
   * before and after consulting the record, so a replayed round still costs two
   * embedding calls. The counter below pins that number so the gap is measured
   * rather than assumed, and so closing it shows up here as a failure to update.
   */
  const makeReplayClient = (): { client: unknown; embedCalls: () => number } => {
    const stub = createStubClient();
    let embedCalls = 0;
    return {
      client: {
        ...stub,
        complete: async () => { throw new Error('replay made a reasoning call'); },
        stream: async function* (): AsyncGenerator<string, never, void> {
          throw new Error('replay made a reasoning call');
        },
        embed: async (texts: readonly string[]) => {
          embedCalls++;
          return stub.embed(texts);
        },
      },
      embedCalls: () => embedCalls,
    };
  };

  /**
   * Documents the gap that stops replay working at all, so it is not rediscovered.
   *
   * §11 promises "replay from `cognition_records` reproduces a real-model run with
   * zero Bedrock calls". Two things are missing before that can be true:
   *
   *  1. **No rewind.** `runTick({ tick })` forces the tick *number* but does not
   *     restore world state to it. Replaying tick 6 of a world now at tick 12
   *     re-runs spotlight selection, situation text and beliefs against tick-12
   *     state, so it selects agents that have no record at tick 6 — which is the
   *     refusal this test asserts. Replay needs either a rewind, or to run into a
   *     fresh world with the recorded agent ids mapped across.
   *  2. **Embeddings are still called.** `think` embeds situation texts and the
   *     round's new memories either side of consulting the record, so a replayed
   *     round costs two embedding calls even when no reasoning call is made. A
   *     recording therefore cannot be replayed without a live embedding provider,
   *     which is precisely what replay exists to avoid.
   *
   * Neither was visible before the input hash was narrowed: replay used to warn
   * on drift and carry on, so it would have returned decisions made from entirely
   * different inputs and looked like it worked.
   */
  test('replaying a world that has moved past the recorded tick is refused', async () => {
    const { worldId, tick } = await recordedWorld(401);

    const recorded = await query<{ model_id: string }>(
      `SELECT model_id FROM cognition_records
        WHERE world_id = $1 AND tick = $2 ORDER BY record_id`, [worldId, tick]);
    assert.ok(recorded.length > 0, 'the world recorded decisions to replay');

    const { client } = makeReplayClient();
    await assert.rejects(
      () => runTick({
        worldId, tick, replay: true, allowDistortion: false, inference: client as never,
      }),
      /^Error: replay:/,
      'without a rewind, replay must refuse rather than reconstruct a different run',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a rewound world replays its recording with no model calls at all', async () => {
    const TICKS = 14;
    const { worldId } = await recordedWorld(410, TICKS);

    const live = await snapshot(worldId);
    assert.ok(live.records > 0, 'the world thought at least once');
    assert.ok(live.memories > 0, 'and formed memories while it did');
    const liveDialogueMemories = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_memories
        WHERE world_id = $1 AND kind = 'dialogue'`, [worldId],
    );
    assert.ok((liveDialogueMemories[0]?.count ?? 0) > 0,
      'the live recording must contain NPC dialogue memories, or vector replay is untested');

    const rewound = await rewindWorld(worldId);
    assert.equal(rewound.fromTick, TICKS);
    assert.equal(rewound.recordsKept, live.records, 'the recording survives the rewind');

    const cleared = await snapshot(worldId);
    assert.equal(cleared.tick, 0, 'the world is back at the start');
    assert.equal(cleared.memories, 0, 'and has forgotten everything it learned');
    assert.equal(cleared.tension, 0);
    assert.equal(cleared.stage, 'calm');

    // The whole point: no reasoning call, no embedding call, for any tick.
    const { client, calls } = strictReplayClient();
    for (let tick = 1; tick <= TICKS; tick++) {
      await runTick({ worldId, replay: true, inference: client as never });
    }
    assert.equal(calls(), 0, 'a replay must reach no model, of any kind');

    const replayed = await snapshot(worldId);
    assert.equal(replayed.tick, TICKS);
    assert.equal(replayed.stage, live.stage, 'the same stage was reached');
    assert.equal(replayed.tension, live.tension, 'along the same tension curve');
    assert.equal(replayed.memories, live.memories, 'and the same memories were formed');
    const replayedDialogueMemories = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_memories
        WHERE world_id = $1 AND kind = 'dialogue'`, [worldId],
    );
    assert.equal(replayedDialogueMemories[0]?.count, liveDialogueMemories[0]?.count,
      'both NPC dialogue vectors and memories survive the recording round-trip');

    // Vectors come from the record, so the memories are genuinely retrievable —
    // not rows with a NULL embedding that would silently fall out of every ANN
    // query later.
    const unembedded = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_memories
        WHERE world_id = $1 AND embedding IS NULL`, [worldId]);
    assert.equal(unembedded[0]!.count, 0, 'every replayed memory kept its vector');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('budget-degraded recordings replay without inventing model work', async () => {
    const TICKS = 8;
    const world = await instantiateWorld({
      scenarioVersionId, seed: 411, sessionId: `replay-degraded-${Date.now()}`,
    });
    const worldId = world.worldId;
    await query(
      `UPDATE world_budget SET inference_calls = 100000 WHERE world_id = $1`, [worldId]);

    for (let tick = 1; tick <= TICKS; tick++) {
      await runTick({ worldId, inference: createStubClient(), allowDistortion: false });
    }
    const live = await snapshot(worldId);
    const records = await query<{ degraded: boolean; model_id: string }>(
      `SELECT (decision->>'degraded')::BOOL AS degraded, model_id
         FROM cognition_records
        WHERE world_id = $1 AND task = 'plan'
        ORDER BY tick, record_id`, [worldId]);
    assert.ok(records.length > 0, 'the exhausted world still records rule decisions');
    assert.ok(records.every((row) => row.degraded && row.model_id === 'deterministic-fallback'));

    await rewindWorld(worldId);
    const { client, calls } = strictReplayClient();
    for (let tick = 1; tick <= TICKS; tick++) {
      await runTick({ worldId, replay: true, inference: client as never });
    }

    assert.equal(calls(), 0, 'degraded replay must consume neither RNG-dependent AI nor embeddings');
    const replayed = await snapshot(worldId);
    assert.equal(replayed.tick, live.tick);
    assert.equal(replayed.stage, live.stage);
    assert.equal(replayed.tension, live.tension);
    assert.equal(replayed.memories, live.memories);
    assert.equal(replayed.records, live.records, 'replay does not duplicate its source records');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('replay refuses a recording whose inputs no longer match', async () => {
    const { worldId, tick } = await recordedWorld(402);

    // Stand in for a diverged world. Every input to this hash is a
    // deterministic rule output, so a mismatch is a real difference — which is
    // exactly why it must now be an error. Before, this warned and carried on,
    // and the run looked fine.
    await query(
      `UPDATE cognition_records SET input_hash = $3 WHERE world_id = $1 AND tick = $2`,
      [worldId, tick, 'f'.repeat(64)]);

    await assert.rejects(
      () => runTick({
        worldId, tick, replay: true, allowDistortion: false,
        inference: makeReplayClient().client as never,
      }),
      /^Error: replay:/,
      'a diverged world must fail loudly, not replay approximately',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('replay refuses a recording made under a different prompt', async () => {
    const { worldId, tick } = await recordedWorld(403);

    // A changed prompt is the failure the old hash could never report on its
    // own: it moves the hash, and the hash could not be trusted, so it warned.
    await query(
      `UPDATE cognition_records SET prompt_version = 'plan-v0-ancient'
        WHERE world_id = $1 AND tick = $2`, [worldId, tick]);

    await assert.rejects(
      () => runTick({
        worldId, tick, replay: true, allowDistortion: false,
        inference: makeReplayClient().client as never,
      }),
      /^Error: replay:/,
      'a recording from older prompts cannot stand in for these ones',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });
});
