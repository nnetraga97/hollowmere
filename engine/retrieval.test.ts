/**
 * Retrieval scoring and indexing.
 *
 * The plan assertion here is not ceremony. A retrieval query that ignores the
 * vector index still returns correct rows, so every result-based test passes
 * while the thing being tested — indexed ANN search scoped to one world — has
 * quietly stopped happening. The plan is the only observable difference.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, getPool, query, withSerializable, type Client } from './db.ts';
import { stubEmbed } from './inference/index.ts';
import { SCALE } from './fixedpoint.ts';
import {
  DEFAULT_WEIGHTS,
  recall,
  recordAccesses,
  relevanceFromDistance,
  retrieveMemories,
  toVectorLiteral,
} from './retrieval.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');
const DIMS = 1024;

describe('distance conversion', () => {
  test('maps cosine distance onto a fixed-point similarity', () => {
    assert.equal(relevanceFromDistance(0), SCALE);      // identical
    assert.equal(relevanceFromDistance(1), SCALE / 2);  // orthogonal
    assert.equal(relevanceFromDistance(2), 0);          // opposite
  });

  test('clamps values outside the theoretical range', () => {
    assert.equal(relevanceFromDistance(-0.001), SCALE);
    assert.equal(relevanceFromDistance(2.5), 0);
  });

  test('always yields an integer, so no float reaches the rules', () => {
    for (let d = 0; d <= 2; d += 0.017) {
      assert.ok(Number.isInteger(relevanceFromDistance(d)), `distance ${d} produced a float`);
    }
  });
});

describe('vector literal', () => {
  test('renders pgvector textual form', () => {
    assert.equal(toVectorLiteral([1, 0.5, -0.25]), '[1,0.5,-0.25]');
  });
});

// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);
const dbSuite = HAS_DB ? describe : describe.skip;

dbSuite('retrieval against CockroachDB', () => {
  let worldId: string;
  let agentId: string;
  let otherAgentId: string;

  before(async () => {
    const published = await publishScenario(await loadScenarioFile(SCENARIO_PATH));
    const world = await instantiateWorld({
      scenarioVersionId: published.scenarioVersionId,
      seed: 4242,
      sessionId: `retrieval-${Date.now()}`,
    });
    worldId = world.worldId;

    const agents = await query<{ agent_id: string; agent_key: string }>(
      `SELECT agent_id, agent_key FROM world_agents
        WHERE world_id = $1 AND agent_key IN ('wyn_thatcher', 'edda_lyle')
        ORDER BY agent_key`,
      [worldId],
    );
    otherAgentId = agents[0]!.agent_id;  // edda_lyle
    agentId = agents[1]!.agent_id;       // wyn_thatcher

    await seedMemories();

    // Without statistics the optimizer ignores the vector index entirely.
    await query('ANALYZE world_memories');
  });

  after(async () => {
    if (worldId) await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
    await closePool();
  });

  /**
   * A corpus with deliberate structure: several memories about the quay, a few
   * about bread, and one high-importance but lexically distant memory, so each
   * scoring component can be isolated.
   */
  async function seedMemories(): Promise<void> {
    const corpus: { content: string; importance: number; tick: number; agent: 'main' | 'other' }[] = [
      { content: 'rowan corvane was seen near the quay that night', importance: 7000, tick: 1, agent: 'main' },
      { content: 'the quay was dark and the ferryman said nothing', importance: 5000, tick: 2, agent: 'main' },
      { content: 'someone crossed the quay before dawn', importance: 4000, tick: 3, agent: 'main' },
      { content: 'edda lyle sells bread in the market square', importance: 3000, tick: 4, agent: 'main' },
      { content: 'the bread was stale on market day', importance: 2000, tick: 5, agent: 'main' },
      { content: 'the granary books were being audited', importance: 9500, tick: 6, agent: 'main' },
      { content: 'rowan corvane was seen near the quay that night', importance: 7000, tick: 7, agent: 'other' },
    ];

    await withSerializable(async (client) => {
      let seq = 100;
      for (const entry of corpus) {
        await insertMemory(client, {
          worldId,
          agentId: entry.agent === 'main' ? agentId : otherAgentId,
          tick: entry.tick,
          seq: seq++,
          content: entry.content,
          importance: entry.importance,
        });
      }

      // Bulk filler. An agent in a real run accumulates hundreds of memories,
      // and on a seven-row table the optimizer reasonably prefers a scan — so a
      // realistic corpus is required for the plan assertion to mean anything.
      const chatter = [
        'the tide came in late today', 'a cart lost a wheel on the mill road',
        'the chapel bell rang twice at dusk', 'salt prices rose again this week',
        'a stranger asked directions to the plaza', 'the nets need mending before winter',
      ];
      for (let i = 0; i < 240; i++) {
        await insertMemory(client, {
          worldId,
          agentId,
          tick: 8 + Math.floor(i / 4),
          seq: seq++,
          content: `${chatter[i % chatter.length]} (${i})`,
          importance: 500 + (i % 40) * 10,
        });
      }
    });
  }

  test('ranks lexically related memories above unrelated ones', async () => {
    const client = await getPool().connect();
    try {
      const results = await retrieveMemories(client, {
        worldId, agentId, tick: 10, limit: 3,
        queryVector: stubEmbed('who was at the quay that night', DIMS),
        // Isolate relevance so recency and importance cannot mask it.
        weights: { recency: 0, importance: 0, relevance: SCALE },
      });

      assert.equal(results.length, 3);
      for (const result of results) {
        assert.match(result.content, /quay/, `unrelated memory ranked into top 3: ${result.content}`);
      }
      assert.ok(
        (results[0]?.relevance ?? 0) > (results[2]?.relevance ?? 0),
        'relevance should be strictly ordered',
      );
    } finally {
      client.release();
    }
  });

  test('importance lifts a lexically distant memory', async () => {
    const client = await getPool().connect();
    try {
      const byImportance = await retrieveMemories(client, {
        worldId, agentId, tick: 10, limit: 1,
        queryVector: stubEmbed('who was at the quay that night', DIMS),
        weights: { recency: 0, importance: SCALE, relevance: 0 },
      });
      assert.match(
        byImportance[0]?.content ?? '',
        /granary books/,
        'the most important memory should win when only importance counts',
      );
    } finally {
      client.release();
    }
  });

  test('recency decays with elapsed ticks', async () => {
    const client = await getPool().connect();
    try {
      const fresh = await retrieveMemories(client, {
        worldId, agentId, tick: 7, limit: 6,
        queryVector: stubEmbed('quay', DIMS),
        weights: DEFAULT_WEIGHTS,
      });
      const stale = await retrieveMemories(client, {
        worldId, agentId, tick: 400, limit: 6,
        queryVector: stubEmbed('quay', DIMS),
        weights: DEFAULT_WEIGHTS,
      });

      const freshest = fresh.find((m) => m.content.includes('granary'));
      const stalest = stale.find((m) => m.content.includes('granary'));
      assert.ok(freshest && stalest);
      assert.ok(
        stalest.recency < freshest.recency,
        `recency should fall over time: ${freshest.recency} -> ${stalest.recency}`,
      );
    } finally {
      client.release();
    }
  });

  test('never returns another agent\'s memories', async () => {
    const client = await getPool().connect();
    try {
      const results = await retrieveMemories(client, {
        worldId, agentId, tick: 10, limit: 20,
        queryVector: stubEmbed('rowan corvane quay night', DIMS),
      });
      // Both agents hold an identical memory; only one copy may come back.
      const matches = results.filter((m) => m.content === 'rowan corvane was seen near the quay that night');
      assert.equal(matches.length, 1, 'memories must not leak between agents');
    } finally {
      client.release();
    }
  });

  test('ordering is deterministic across repeated runs', async () => {
    const client = await getPool().connect();
    try {
      const run = async () =>
        (await retrieveMemories(client, {
          worldId, agentId, tick: 10, limit: 5,
          queryVector: stubEmbed('the quay at night', DIMS),
        })).map((m) => m.memoryId);

      assert.deepEqual(await run(), await run());
      assert.deepEqual(await run(), await run());
    } finally {
      client.release();
    }
  });

  test('scores are integers throughout', async () => {
    const client = await getPool().connect();
    try {
      const results = await retrieveMemories(client, {
        worldId, agentId, tick: 10, limit: 6,
        queryVector: stubEmbed('quay', DIMS),
      });
      for (const result of results) {
        for (const [label, value] of Object.entries({
          score: result.score, recency: result.recency,
          relevance: result.relevance, importance: result.importance,
        })) {
          assert.ok(Number.isInteger(value), `${label} was not an integer: ${value}`);
        }
      }
    } finally {
      client.release();
    }
  });

  test('the ANN query uses the world-scoped vector index', async () => {
    // The load-bearing test. Mirrors the candidate query in retrieval.ts.
    const plan = await query<{ info: string }>(
      `EXPLAIN
       SELECT memory_id, embedding <=> $3 AS distance
         FROM world_memories
        WHERE world_id = $1 AND agent_id = $2
        ORDER BY embedding <=> $3
        LIMIT 48`,
      [worldId, agentId, toVectorLiteral(stubEmbed('the quay at night', DIMS))],
    );
    const text = plan.map((row) => row.info).join('\n');

    assert.match(text, /vector search/, `expected an indexed vector search, got:\n${text}`);
    assert.match(text, /world_memories_embedding_idx/, 'should use the cosine vector index');
    assert.match(text, /prefix spans/, 'ANN search must be scoped to a single world');
  });

  test('recall appends accesses without mutating memories', async () => {
    const client = await getPool().connect();
    try {
      const before = await query<{ count: number }>(
        `SELECT count(*)::INT8 AS count FROM world_memories WHERE world_id = $1`,
        [worldId],
      );

      const recalled = await recall(client, {
        worldId, agentId, tick: 42, limit: 3,
        queryVector: stubEmbed('quay', DIMS),
      });
      assert.equal(recalled.length, 3);

      const after = await query<{ count: number }>(
        `SELECT count(*)::INT8 AS count FROM world_memories WHERE world_id = $1`,
        [worldId],
      );
      assert.equal(after[0]?.count, before[0]?.count, 'memories are append-only');

      const accesses = await query<{ count: number }>(
        `SELECT count(*)::INT8 AS count FROM memory_accesses
          WHERE world_id = $1 AND accessed_tick = 42`,
        [worldId],
      );
      assert.equal(accesses[0]?.count, 3, 'each recalled memory should record an access');
    } finally {
      client.release();
    }
  });

  test('a recalled memory becomes more recent', async () => {
    const client = await getPool().connect();
    try {
      const target = await query<{ memory_id: string }>(
        `SELECT memory_id FROM world_memories
          WHERE world_id = $1 AND agent_id = $2 AND content LIKE '%stale%'`,
        [worldId, agentId],
      );
      const memoryId = target[0]!.memory_id;

      const scoreAt = async (tick: number): Promise<number> => {
        const results = await retrieveMemories(client, {
          worldId, agentId, tick, limit: 20,
          queryVector: stubEmbed('bread market', DIMS),
        });
        return results.find((m) => m.memoryId === memoryId)?.recency ?? -1;
      };

      const before = await scoreAt(200);
      await recordAccesses(client, worldId, [memoryId], 199);
      const after = await scoreAt(200);

      assert.ok(after > before, `recall should refresh recency: ${before} -> ${after}`);
    } finally {
      client.release();
    }
  });

  test('an empty corpus returns nothing rather than throwing', async () => {
    const client = await getPool().connect();
    try {
      const [loner] = await query<{ agent_id: string }>(
        `SELECT agent_id FROM world_agents
          WHERE world_id = $1 AND agent_key = 'jenna_ryle'`,
        [worldId],
      );
      const results = await retrieveMemories(client, {
        worldId, agentId: loner!.agent_id, tick: 10,
        queryVector: stubEmbed('anything at all', DIMS),
      });
      assert.deepEqual(results, []);
    } finally {
      client.release();
    }
  });
});

async function insertMemory(
  client: Client,
  memory: {
    worldId: string; agentId: string; tick: number; seq: number;
    content: string; importance: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO world_memories
       (world_id, agent_id, tick, seq, kind, content, embedding, importance)
     VALUES ($1, $2, $3, $4, 'observation', $5, $6, $7)`,
    [
      memory.worldId, memory.agentId, memory.tick, memory.seq,
      memory.content, toVectorLiteral(stubEmbed(memory.content, DIMS)), memory.importance,
    ],
  );
}
