/**
 * Gossip diffusion and belief formation.
 *
 * The properties worth protecting here are the ones that make the simulation
 * say something rather than merely run: that belief hardens gradually, that the
 * two houses polarise rather than converge, and that a claim the engine knows
 * to be false can still take hold of the town.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, getPool, query, withSerializable, type Client } from '../database/db.ts';
import { BELIEF, GOSSIP } from '../core/config.ts';
import { SCALE, fromPercent } from '../core/fixedpoint.ts';
import { createStubClient } from '../inference/index.ts';
import { acquireLease } from '../database/lease.ts';
import { createRng, tickRng } from '../core/rng.ts';
import { createSeq } from '../core/seq.ts';
import {
  alignmentFactor,
  getBeliefAtTick,
  getMisinformationIndex,
  rebuildBeliefProjection,
  shiftConfidence,
} from './beliefs.ts';
import { runGossip, seedRumor, transmissionChance, type Transmission } from './gossip.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');

describe('belief shifting', () => {
  const base = {
    current: 0, credulity: fromPercent(60), trust: fromPercent(60), heat: fromPercent(80),
  };

  test('rivals believe more readily than housemates', () => {
    const rival = shiftConfidence({ ...base, alignment: 'rival' });
    const unaligned = shiftConfidence({ ...base, alignment: 'unaligned' });
    const same = shiftConfidence({ ...base, alignment: 'same' });

    assert.ok(rival > unaligned, 'a rival should believe more than a bystander');
    assert.ok(unaligned > same, 'a bystander should believe more than a housemate');
  });

  test('alignment factors are ordered', () => {
    assert.ok(alignmentFactor('rival') > alignmentFactor('unaligned'));
    assert.ok(alignmentFactor('unaligned') > alignmentFactor('same'));
  });

  test('confidence approaches certainty without ever saturating', () => {
    let confidence = 0;
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      confidence = shiftConfidence({ ...base, current: confidence, alignment: 'rival' });
      seen.push(confidence);
    }

    assert.ok(confidence > fromPercent(70), `belief should harden over time, reached ${confidence}`);
    assert.ok(confidence <= SCALE, 'confidence must stay in range');

    // Diminishing returns: the first retelling moves further than the tenth.
    const firstStep = seen[0]! - 0;
    const laterStep = seen[10]! - seen[9]!;
    assert.ok(firstStep > laterStep, 'each retelling should move belief less than the last');
  });

  test('a sceptic barely moves', () => {
    const sceptic = shiftConfidence({
      current: 0, credulity: fromPercent(10), trust: fromPercent(10),
      heat: fromPercent(80), alignment: 'same',
    });
    const believer = shiftConfidence({
      current: 0, credulity: fromPercent(95), trust: fromPercent(95),
      heat: fromPercent(80), alignment: 'rival',
    });
    assert.ok(sceptic < believer / 4, `sceptic ${sceptic} vs believer ${believer}`);
  });

  test('results are always integers', () => {
    for (let heat = 0; heat <= SCALE; heat += 977) {
      const result = shiftConfidence({ ...base, heat, alignment: 'rival' });
      assert.ok(Number.isInteger(result), `heat ${heat} produced ${result}`);
    }
  });
});

describe('transmission probability', () => {
  const base = { heat: SCALE, talkativeness: SCALE, trust: SCALE, colocated: true };

  test('proximity dominates', () => {
    const near = transmissionChance(base);
    const far = transmissionChance({ ...base, colocated: false });
    assert.ok(near > far * 4, `co-located ${near} should far exceed remote ${far}`);
  });

  test('distrust silences the teller entirely', () => {
    assert.equal(transmissionChance({ ...base, trust: fromPercent(5) }), 0);
  });

  test('a cold rumor barely travels', () => {
    const cold = transmissionChance({ ...base, heat: fromPercent(5) });
    assert.ok(cold < fromPercent(5), `cold rumor should rarely spread, got ${cold}`);
  });

  test('probability stays within range', () => {
    for (let heat = 0; heat <= SCALE; heat += 613) {
      const p = transmissionChance({ ...base, heat });
      assert.ok(p >= 0 && p <= SCALE && Number.isInteger(p));
    }
  });
});

// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);
const dbSuite = HAS_DB ? describe : describe.skip;

dbSuite('gossip against CockroachDB', () => {
  let scenarioVersionId: string;

  before(async () => {
    const published = await publishScenario(await loadScenarioFile(SCENARIO_PATH));
    scenarioVersionId = published.scenarioVersionId;
  });

  after(async () => {
    await closePool();
  });

  async function freshWorld(seed = 1): Promise<string> {
    const world = await instantiateWorld({
      scenarioVersionId, seed, sessionId: `gossip-${seed}-${Date.now()}-${Math.random()}`,
    });
    const leased = await acquireLease(world.worldId, {
      owner: `gossip-test-${process.pid}`,
      ttlMs: 60 * 60 * 1_000,
    });
    assert.equal(leased, true, 'the fixture world must be isolated from a live scheduler');
    return world.worldId;
  }

  async function agentIdOf(worldId: string, agentKey: string): Promise<string> {
    const rows = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = $2`,
      [worldId, agentKey],
    );
    return rows[0]!.agent_id;
  }

  async function claimIdOf(worldId: string, claimKey: string): Promise<string> {
    const rows = await query<{ claim_id: string }>(
      `SELECT claim_id FROM world_claims WHERE world_id = $1 AND claim_key = $2`,
      [worldId, claimKey],
    );
    return rows[0]!.claim_id;
  }

  /** Put everyone in one place so transmission is driven by trust, not geography. */
  async function gatherTown(worldId: string): Promise<void> {
    await query(
      `UPDATE world_agents SET location_id = (
         SELECT location_id FROM world_locations
          WHERE world_id = $1 AND location_key = 'market_square'
       ) WHERE world_id = $1`,
      [worldId],
    );
  }

  /**
   * Note the world already carries the scenario's opening rumors, so counts
   * must be filtered by claim rather than taken in aggregate.
   */
  async function runTicks(
    worldId: string, ticks: number, seed = 99,
  ): Promise<{ transmissions: Transmission[]; tension: number }> {
    const inference = createStubClient();
    const transmissions: Transmission[] = [];
    let tension = 0;

    for (let tick = 1; tick <= ticks; tick++) {
      await withSerializable(async (client: Client) => {
        const result = await runGossip(client, {
          worldId, tick,
          rng: createRng(seed + tick),
          seq: createSeq(tick * 1000),
          inference,
          allowDistortion: false,
        });
        transmissions.push(...result.transmissions);
        tension += result.tensionDelta;
      });
    }
    return { transmissions, tension };
  }

  test('a seeded rumor spreads through the town', async () => {
    const worldId = await freshWorld(11);
    await gatherTown(worldId);

    const claimId = await claimIdOf(worldId, 'corvane_ordered_death');
    const origin = await agentIdOf(worldId, 'widow_sable');

    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(90), valence: -fromPercent(80),
        text: 'House Corvane ordered the prince killed.',
      });
    });

    const { transmissions } = await runTicks(worldId, 6);
    const mine = transmissions.filter((t) => t.claimId === claimId);
    assert.ok(mine.length > 0, 'the rumor should have travelled');

    const [holders] = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_rumor_spread s
         JOIN world_rumors r ON r.world_id = s.world_id AND r.rumor_id = s.rumor_id
        WHERE s.world_id = $1 AND r.claim_id = $2`,
      [worldId, claimId],
    );
    assert.ok((holders?.count ?? 0) > 3, `expected several holders, got ${holders?.count}`);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('the two houses polarise rather than converge', async () => {
    const worldId = await freshWorld(12);
    await gatherTown(worldId);

    // A claim against a Corvane. Aldreth should believe it more than Corvane does.
    const claimId = await claimIdOf(worldId, 'corvane_ordered_death');
    const origin = await agentIdOf(worldId, 'widow_sable');

    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(95), valence: -fromPercent(85),
        text: 'House Corvane ordered the prince killed.',
      });
    });

    await runTicks(worldId, 10);

    const byFaction = await query<{ faction_key: string; avg_confidence: number; n: number }>(
      `SELECT f.faction_key,
              COALESCE(avg(b.confidence), 0)::INT8 AS avg_confidence,
              count(*)::INT8 AS n
         FROM agent_beliefs b
         JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
         JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
        WHERE b.world_id = $1 AND b.claim_id = $2
        GROUP BY f.faction_key ORDER BY f.faction_key`,
      [worldId, claimId],
    );

    const aldreth = byFaction.find((r) => r.faction_key === 'aldreth');
    const corvane = byFaction.find((r) => r.faction_key === 'corvane');

    assert.ok(aldreth && corvane, `both houses should have heard it: ${JSON.stringify(byFaction)}`);
    assert.ok(
      aldreth.avg_confidence > corvane.avg_confidence,
      `the accused house should resist: aldreth ${aldreth.avg_confidence} vs corvane ${corvane.avg_confidence}`,
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a claim the engine knows is FALSE still takes hold of the town', async () => {
    // The headline misinformation result. Ground truth is recorded separately
    // from belief precisely so this can be demonstrated rather than asserted.
    const worldId = await freshWorld(13);
    await gatherTown(worldId);

    const claimId = await claimIdOf(worldId, 'millers_poison_grain');
    const [truth] = await query<{ truth: string }>(
      `SELECT truth FROM world_claims WHERE world_id = $1 AND claim_id = $2`,
      [worldId, claimId],
    );
    assert.equal(truth?.truth, 'false', 'fixture assumption: this claim is false');

    const origin = await agentIdOf(worldId, 'ned_quilley');
    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(95), valence: -fromPercent(90),
        text: 'The millers have been mixing blight into the grain.',
      });
    });

    await runTicks(worldId, 12);

    const believers = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM agent_beliefs
        WHERE world_id = $1 AND claim_id = $2 AND confidence >= $3`,
      [worldId, claimId, BELIEF.actionableConfidence],
    );
    assert.ok(
      (believers[0]?.count ?? 0) > 0,
      'a falsehood should be able to reach actionable belief — that is the point',
    );

    const index = await withSerializable(async (client) =>
      getMisinformationIndex(client, worldId));
    assert.ok(index.value.falseClaimBelief > 0, 'the misinformation index should register it');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('belief history is reconstructible by tick', async () => {
    const worldId = await freshWorld(14);
    await gatherTown(worldId);

    const claimId = await claimIdOf(worldId, 'rowan_at_the_quay');
    const origin = await agentIdOf(worldId, 'coran_pell');

    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(70), valence: -fromPercent(50),
        text: 'Rowan was at the quay.',
      });
    });
    await runTicks(worldId, 8);

    const client = await getPool().connect();
    try {
      // Someone who heard it late should have believed nothing at tick 0.
      const holder = await query<{ agent_id: string; received_tick: number }>(
        `SELECT s.agent_id, s.received_tick
           FROM world_rumor_spread s
           JOIN world_rumors r ON r.world_id = s.world_id AND r.rumor_id = s.rumor_id
          WHERE s.world_id = $1 AND r.claim_id = $2 AND s.received_tick > 1
          ORDER BY s.received_tick DESC LIMIT 1`,
        [worldId, claimId],
      );

      if (holder[0]) {
        const before = await getBeliefAtTick(client, worldId, holder[0].agent_id, claimId, 0);
        const after = await getBeliefAtTick(client, worldId, holder[0].agent_id, claimId, 999);
        assert.equal(before, 0, 'belief before hearing should be nothing');
        assert.ok(after > 0, 'belief after hearing should be positive');
      }
    } finally {
      client.release();
    }

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('the belief projection matches a rebuild from history', async () => {
    // If this fails, something wrote agent_beliefs without a belief_updates row,
    // and the belief inspector would disagree with what actually happened.
    const worldId = await freshWorld(15);
    await gatherTown(worldId);

    const claimId = await claimIdOf(worldId, 'physician_was_paid');
    const origin = await agentIdOf(worldId, 'hester_lowe');
    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(85), valence: -fromPercent(70),
        text: 'The physician was paid to keep quiet.',
      });
    });
    await runTicks(worldId, 8);

    const snapshot = async () => query<{ agent_id: string; claim_id: string; confidence: number }>(
      `SELECT agent_id, claim_id, confidence FROM agent_beliefs
        WHERE world_id = $1 ORDER BY agent_id, claim_id`,
      [worldId],
    );

    const live = await snapshot();
    assert.ok(live.length > 0, 'there should be beliefs to compare');

    await withSerializable(async (client) => rebuildBeliefProjection(client, worldId));
    const rebuilt = await snapshot();

    assert.deepEqual(rebuilt, live, 'projection must be reproducible from append-only history');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('gossip is deterministic under a fixed seed', async () => {
    const runOnce = async (seed: number): Promise<string[]> => {
      const worldId = await freshWorld(seed);
      await gatherTown(worldId);
      const claimId = await claimIdOf(worldId, 'granary_books_false');
      const origin = await agentIdOf(worldId, 'jenna_ryle');

      await withSerializable(async (client) => {
        await seedRumor(client, {
          worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
          heat: fromPercent(80), valence: -fromPercent(60),
          text: 'The granary books were false.',
        });
      });

      const inference = createStubClient();
      const order: string[] = [];
      for (let tick = 1; tick <= 5; tick++) {
        await withSerializable(async (client) => {
          const result = await runGossip(client, {
            worldId, tick,
            // Same coordinates regardless of world, so only the rules vary.
            rng: tickRng('fixed-world', tick, 'gossip'),
            seq: createSeq(tick * 1000),
            inference,
            allowDistortion: false,
          });
          for (const t of result.transmissions) order.push(`${t.fromAgentKey}->${t.toAgentKey}`);
        });
      }
      await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
      return order;
    };

    const first = await runOnce(21);
    const second = await runOnce(22);
    assert.ok(first.length > 0, 'the run should produce transmissions to compare');
    assert.deepEqual(second, first, 'identical seeds must produce identical spread');
  });

  test('cold rumors stop spreading', async () => {
    const worldId = await freshWorld(16);
    await gatherTown(worldId);

    // Must be a claim the scenario does NOT seed at the opening, or seedRumor
    // will correctly reheat the existing hot rumor instead of creating a cold one.
    const claimId = await claimIdOf(worldId, 'shipwrights_smuggle_arms');
    const origin = await agentIdOf(worldId, 'father_ansel');
    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: GOSSIP.minHeat - 1, valence: 0,
        text: 'There were crates landed after dark.',
      });
    });

    const { transmissions } = await runTicks(worldId, 5);
    // Only this claim must stay silent — the scenario's opening rumors are
    // still circulating in the same world and should be unaffected.
    const mine = transmissions.filter((t) => t.claimId === claimId);
    assert.equal(mine.length, 0, 'a rumor below the heat floor should not travel');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('re-seeding a claim reheats it rather than forking a second rumor', async () => {
    const worldId = await freshWorld(17);
    const claimId = await claimIdOf(worldId, 'maren_welcomed_it');
    const a = await agentIdOf(worldId, 'widow_sable');
    const b = await agentIdOf(worldId, 'coran_pell');

    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: a,
        heat: fromPercent(40), valence: -fromPercent(50), text: 'Maren welcomed it.',
      });
      await seedRumor(client, {
        worldId, tick: 1, seq: createSeq(100), claimId, originAgentId: b,
        heat: fromPercent(90), valence: -fromPercent(50), text: 'Maren welcomed it.',
      });
    });

    const rumors = await query<{ rumor_id: string; heat: number }>(
      `SELECT rumor_id, heat FROM world_rumors WHERE world_id = $1 AND claim_id = $2`,
      [worldId, claimId],
    );
    assert.equal(rumors.length, 1, 'one claim should have exactly one rumor');
    assert.equal(rumors[0]?.heat, fromPercent(90), 'the hotter retelling should win');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('hostile rumors crossing the faction line generate tension', async () => {
    const worldId = await freshWorld(18);
    await gatherTown(worldId);

    const claimId = await claimIdOf(worldId, 'corvane_ordered_death');
    const origin = await agentIdOf(worldId, 'wyn_thatcher');
    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId, originAgentId: origin,
        heat: fromPercent(95), valence: -fromPercent(90),
        text: 'Corvane ordered it.',
      });
    });

    const { tension } = await runTicks(worldId, 8);
    assert.ok(tension > 0, 'cross-faction accusation should raise tension');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });
});
