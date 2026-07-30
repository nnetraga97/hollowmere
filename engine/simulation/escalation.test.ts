/**
 * Tension, stages, peace, and triggers.
 *
 * The properties under test are the ones the story depends on: that the town
 * can be slowed but never rewound, that peace is something the rules conclude
 * rather than something a model announces, and that the trigger language cannot
 * express anything outside its allowlist.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query, withSerializable } from '../database/db.ts';
import { ACCUSATION, TENSION } from '../core/config.ts';
import { SCALE, fromPercent } from '../core/fixedpoint.ts';
import { createSeq } from '../core/seq.ts';
import { createRng } from '../core/rng.ts';
import { seedRumor } from '../social/gossip.ts';
import { runAccusations } from '../agents/accusations.ts';
import {
  applyEscalation, decayTension, maxStage, nextTension, readWorldState,
  stageForTension, stageIndex,
} from './tension.ts';
import { allConditionsMet, endWorld, evaluatePeace, setNegotiationWillingness } from './peace.ts';
import {
  evaluateCondition, loadTriggerFacts, loadTriggerKeyMaps, runTriggers, type TriggerFacts,
} from './triggers.ts';
import { ESCALATION_STAGES } from '../../scenario/schema.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { slowTest } from '../testing/slow-tests.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', '..', 'scenario', 'hollowmere-v2.json');
const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure rule logic
// ---------------------------------------------------------------------------

describe('stage thresholds', () => {
  test('map tension onto the escalation ladder in order', () => {
    assert.equal(stageForTension(0), 'calm');
    assert.equal(stageForTension(TENSION.stageThresholds.suspicion), 'suspicion');
    assert.equal(stageForTension(TENSION.stageThresholds.accusations), 'accusations');
    assert.equal(stageForTension(TENSION.stageThresholds.trials), 'trials');
    assert.equal(stageForTension(TENSION.stageThresholds.first_blood), 'first_blood');
    assert.equal(stageForTension(SCALE), 'war');
  });

  test('are strictly increasing, so no stage is unreachable', () => {
    const ordered = [
      TENSION.stageThresholds.suspicion,
      TENSION.stageThresholds.accusations,
      TENSION.stageThresholds.trials,
      TENSION.stageThresholds.first_blood,
      TENSION.stageThresholds.war,
    ];
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(ordered[i]! > ordered[i - 1]!, 'thresholds must strictly increase');
    }
  });

  test('maxStage never moves the town backwards', () => {
    for (const from of ESCALATION_STAGES) {
      for (const to of ESCALATION_STAGES) {
        const result = maxStage(from, to);
        assert.ok(
          stageIndex(result) >= stageIndex(from),
          `${from} + ${to} produced ${result}, which is earlier than ${from}`,
        );
      }
    }
  });
});

describe('tension arithmetic', () => {
  test('decays, but far slower than a single accusation raises it', () => {
    const start = fromPercent(50);
    const bleed = start - decayTension(start);
    assert.ok(bleed > 0, 'tension must cool at all');
    assert.ok(
      bleed < TENSION.publicAccusation,
      'a town that cools faster than it inflames will never reach war unattended',
    );
  });

  test('caps how far one tick can move the town', () => {
    const enormous = nextTension(0, SCALE);
    assert.equal(enormous, TENSION.maxRisePerTick);
  });

  test('stays inside the unsigned range under any input', () => {
    for (const start of [0, fromPercent(50), SCALE]) {
      for (const rise of [-SCALE, 0, 17, SCALE]) {
        const next = nextTension(start, rise);
        assert.ok(next >= 0 && next <= SCALE, `${next} escaped [0, ${SCALE}]`);
      }
    }
  });
});

describe('the trigger condition language', () => {
  const facts: TriggerFacts = {
    tick: 40,
    globalTension: fromPercent(50),
    stage: 'accusations',
    peaceStreak: 3,
    maxRumorHeat: fromPercent(60),
    factionTension: new Map([['aldreth', fromPercent(30)]]),
    agentStatus: new Map([['maren_aldreth', 'alive']]),
  };

  test('compares numeric facts', () => {
    assert.equal(evaluateCondition({ fact: 'tick', op: 'gte', value: 40 }, facts), true);
    assert.equal(evaluateCondition({ fact: 'tick', op: 'gt', value: 40 }, facts), false);
    assert.equal(
      evaluateCondition({ fact: 'global_tension', op: 'lt', value: fromPercent(60) }, facts),
      true,
    );
  });

  test('orders stages by escalation, not alphabetically', () => {
    // "trials" sorts before "war" as a string but after "accusations" — which
    // is backwards for every comparison an author would want to write.
    assert.equal(evaluateCondition({ fact: 'stage', op: 'gte', value: 'suspicion' }, facts), true);
    assert.equal(evaluateCondition({ fact: 'stage', op: 'gte', value: 'trials' }, facts), false);
    assert.equal(evaluateCondition({ fact: 'stage', op: 'neq', value: 'war' }, facts), true);
  });

  test('combines with all, any, and not', () => {
    assert.equal(
      evaluateCondition({
        all: [
          { fact: 'tick', op: 'gte', value: 10 },
          { any: [
            { fact: 'stage', op: 'eq', value: 'war' },
            { fact: 'peace_streak', op: 'lt', value: 5 },
          ] },
          { not: { fact: 'max_rumor_heat', op: 'gt', value: fromPercent(90) } },
        ],
      }, facts),
      true,
    );
  });

  test('treats a fact about something this world lacks as false, not an error', () => {
    assert.equal(
      evaluateCondition({ fact: 'faction_tension', faction: 'ghosts', op: 'gt', value: 0 }, facts),
      false,
    );
    assert.equal(
      evaluateCondition({ fact: 'agent_status', agent: 'nobody', op: 'eq', value: 'dead' }, facts),
      false,
    );
  });
});

describe('peace conditions', () => {
  test('require all four, and any one missing is enough to stop it', () => {
    const all = {
      leadersWilling: true, tensionLow: true, rumorsCool: true, stageOpen: true,
    };
    assert.equal(allConditionsMet(all), true);
    for (const key of Object.keys(all) as (keyof typeof all)[]) {
      assert.equal(allConditionsMet({ ...all, [key]: false }), false, `${key} must be required`);
    }
  });
});

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

describe('escalation against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
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
      scenarioVersionId, seed, sessionId: `escalation-${seed}-${Date.now()}`,
    });
    return world.worldId;
  };

  const stateOf = (worldId: string) => withSerializable((client) => readWorldState(client, worldId));

  test('a rising tension advances the stage and records the crossing', async () => {
    const worldId = await freshWorld(101);

    const result = await withSerializable((client) => applyEscalation(client, {
      worldId, tick: 1, seq: createSeq(0),
      globalRise: TENSION.stageThresholds.suspicion,
    }));

    // The rise is capped per tick, so one enormous accusation does not vault
    // the town up the ladder — it takes sustained pressure.
    assert.equal(result.value.globalTension, TENSION.maxRisePerTick);
    assert.equal(result.value.stage, 'calm');

    // Push it up over many ticks and the stage follows.
    for (let tick = 2; tick <= 60; tick++) {
      await withSerializable((client) => applyEscalation(client, {
        worldId, tick, seq: createSeq(0), globalRise: SCALE,
      }));
    }

    const state = await stateOf(worldId);
    assert.ok(stageIndex(state.value.stage) >= stageIndex('suspicion'));

    const history = await query<{ tick: number; global_tension: number }>(
      `SELECT tick, global_tension FROM world_state_history
        WHERE world_id = $1 ORDER BY tick`, [worldId]);
    // Ticks 1..60, plus the tick-0 row instantiation writes for the opening.
    assert.equal(history.length, 61, 'every tick must leave exactly one history row');
    for (let i = 1; i < history.length; i++) {
      assert.ok(
        history[i]!.global_tension >= history[i - 1]!.global_tension,
        'tension rose every tick here, so the recorded curve must too',
      );
    }

    const events = await query<{ description: string; payload: { to: string } }>(
      `SELECT description, payload FROM world_events
        WHERE world_id = $1 AND kind = 'escalation' AND payload ? 'to'
        ORDER BY tick, seq`, [worldId]);
    assert.ok(events.length > 0, 'crossing a stage must be announced in the chronicle');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('the stage never reverses, however far tension falls', slowTest, async () => {
    const worldId = await freshWorld(102);

    for (let tick = 1; tick <= 120; tick++) {
      await withSerializable((client) => applyEscalation(client, {
        worldId, tick, seq: createSeq(0), globalRise: SCALE,
      }));
    }
    const peak = await stateOf(worldId);
    assert.ok(stageIndex(peak.value.stage) >= stageIndex('accusations'));

    // Now let it cool for a long time with nothing happening at all.
    for (let tick = 121; tick <= 400; tick++) {
      await withSerializable((client) => applyEscalation(client, {
        worldId, tick, seq: createSeq(0), globalRise: 0,
      }));
    }

    const cooled = await stateOf(worldId);
    assert.ok(cooled.value.globalTension < peak.value.globalTension, 'tension should have bled off');
    assert.equal(cooled.value.stage, peak.value.stage, 'the stage must not fall back');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a hard trigger jumps straight to war from suspicion', async () => {
    const worldId = await freshWorld(103);

    // Get the town to suspicion, and no further.
    for (let tick = 1; tick <= 40; tick++) {
      await withSerializable((client) => applyEscalation(client, {
        worldId, tick, seq: createSeq(0), globalRise: SCALE,
      }));
    }
    const before = await stateOf(worldId);
    assert.equal(before.value.stage, 'suspicion');

    // The scenario's authored hard trigger: the Aldreth heir is killed.
    await query(
      `UPDATE world_agents SET status = 'dead'
        WHERE world_id = $1 AND agent_key = 'maren_aldreth'`, [worldId]);

    const fired = await withSerializable(async (client) => {
      const state = await readWorldState(client, worldId);
      const facts = await loadTriggerFacts(client, {
        worldId, tick: 41, globalTension: state.globalTension,
        stage: state.stage, peaceStreak: state.peaceStreak,
      });
      const keyMaps = await loadTriggerKeyMaps(client, worldId);
      const outcome = await runTriggers(client, {
        worldId, tick: 41, seq: createSeq(100), facts,
        factionIds: keyMaps.factionIds, claimIds: keyMaps.claimIds,
      });
      const escalation = await applyEscalation(client, {
        worldId, tick: 41, seq: createSeq(200),
        globalRise: outcome.globalRise,
        stageFloor: outcome.stageFloor ?? undefined,
      });
      return { outcome, escalation };
    });

    assert.ok(fired.value.outcome.fired.includes('aldreth_heir_slain'));
    assert.equal(fired.value.escalation.stage, 'war', 'a murder is not survivable by degree');
    assert.ok(
      fired.value.escalation.globalTension < TENSION.stageThresholds.war,
      'war was reached by the event, not by the tension curve — that is the point',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a once trigger fires exactly once', async () => {
    const worldId = await freshWorld(104);

    const runOnce = async (tick: number) => withSerializable(async (client) => {
      const state = await readWorldState(client, worldId);
      const facts = await loadTriggerFacts(client, {
        worldId, tick, globalTension: state.globalTension,
        stage: state.stage, peaceStreak: state.peaceStreak,
      });
      const keyMaps = await loadTriggerKeyMaps(client, worldId);
      return runTriggers(client, {
        worldId, tick, seq: createSeq(tick * 100), facts,
        factionIds: keyMaps.factionIds, claimIds: keyMaps.claimIds,
      });
    });

    // "prince_laid_to_rest" fires at tick 24 and is authored `once`.
    const first = await runOnce(24);
    assert.ok(first.value.fired.includes('prince_laid_to_rest'));
    const second = await runOnce(25);
    assert.ok(!second.value.fired.includes('prince_laid_to_rest'));

    const firings = await query<{ trigger_key: string }>(
      `SELECT trigger_key FROM trigger_firings
        WHERE world_id = $1 AND trigger_key = 'prince_laid_to_rest'`, [worldId]);
    assert.equal(firings.length, 1);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('peace needs a sustained streak, and one bad tick resets it', async () => {
    const worldId = await freshWorld(105);

    // Set up the conditions: both Houses willing, nothing hot, tension low.
    await withSerializable(async (client) => {
      const factions = await client.query<{ faction_id: string }>(
        `SELECT s.faction_id FROM world_faction_state s
           JOIN world_factions f ON f.world_id = s.world_id AND f.faction_id = s.faction_id
          WHERE s.world_id = $1 AND f.belligerent ORDER BY f.faction_key`, [worldId]);
      for (const row of factions.rows) {
        await setNegotiationWillingness(client, {
          worldId, tick: 1, factionId: row.faction_id, willing: true,
        });
      }
      await client.query(`UPDATE world_rumors SET heat = 0 WHERE world_id = $1`, [worldId]);
    });

    let streak = 0;
    for (let tick = 1; tick < TENSION.peaceStreakRequired; tick++) {
      const result = await withSerializable((client) => evaluatePeace(client, {
        worldId, tick, seq: createSeq(0), globalTension: 0,
        stage: 'trials', previousStreak: streak,
      }));
      streak = result.value.streak;
      assert.equal(result.value.declared, false, 'peace must not be declared early');
    }

    // One hot hostile rumor, and the town has to start again.
    await query(
      `UPDATE world_rumors SET heat = $2, valence = -5000
        WHERE world_id = $1 AND rumor_id IN (
          SELECT rumor_id FROM world_rumors WHERE world_id = $1 ORDER BY rumor_id LIMIT 1)`,
      [worldId, TENSION.peaceMaxRumorHeat + 1]);

    const interrupted = await withSerializable((client) => evaluatePeace(client, {
      worldId, tick: 50, seq: createSeq(0), globalTension: 0,
      stage: 'trials', previousStreak: streak,
    }));
    assert.equal(interrupted.value.streak, 0, 'a hot accusation breaks the streak');
    assert.equal(interrupted.value.conditions.rumorsCool, false);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('peace is closed off after first blood', async () => {
    const worldId = await freshWorld(106);

    await withSerializable(async (client) => {
      const factions = await client.query<{ faction_id: string }>(
        `SELECT faction_id FROM world_faction_state WHERE world_id = $1 ORDER BY faction_id`,
        [worldId]);
      for (const row of factions.rows) {
        await setNegotiationWillingness(client, {
          worldId, tick: 1, factionId: row.faction_id, willing: true,
        });
      }
      await client.query(`UPDATE world_rumors SET heat = 0 WHERE world_id = $1`, [worldId]);
    });

    const open = await withSerializable((client) => evaluatePeace(client, {
      worldId, tick: 1, seq: createSeq(0), globalTension: 0,
      stage: 'trials', previousStreak: 0,
    }));
    assert.equal(open.value.met, true, 'the same conditions hold at trials');

    const closed = await withSerializable((client) => evaluatePeace(client, {
      worldId, tick: 2, seq: createSeq(0), globalTension: 0,
      stage: 'first_blood', previousStreak: 5,
    }));
    assert.equal(closed.value.met, false, 'first blood is the point of no return');
    assert.equal(closed.value.conditions.stageOpen, false);
    assert.equal(closed.value.streak, 0);

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('a world ends exactly once, whichever ending arrives first', async () => {
    const worldId = await freshWorld(107);

    const first = await withSerializable((client) => endWorld(client, {
      worldId, tick: 10, seq: createSeq(0), ending: 'peace',
    }));
    assert.equal(first.value, true);

    const second = await withSerializable((client) => endWorld(client, {
      worldId, tick: 10, seq: createSeq(50), ending: 'war',
    }));
    assert.equal(second.value, false, 'a second ending must not overwrite the first');

    const world = await query<{ status: string; ending: string }>(
      `SELECT status, ending FROM worlds WHERE world_id = $1`, [worldId]);
    assert.equal(world[0]!.status, 'ended');
    assert.equal(world[0]!.ending, 'peace');

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('only believers of cross-house claims accuse, and never more than the cap', async () => {
    const worldId = await freshWorld(108);

    // Convince the whole town of a claim against the other House.
    const claim = await query<{ claim_id: string }>(
      `SELECT claim_id FROM world_claims WHERE world_id = $1 AND claim_key = 'corvane_ordered_death'`,
      [worldId]);
    const claimId = claim[0]!.claim_id;

    await withSerializable(async (client) => {
      await client.query(
        `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
         SELECT $1, agent_id, $2, 9000, 0 FROM world_agents WHERE world_id = $1
         ON CONFLICT (world_id, agent_id, claim_id) DO UPDATE SET confidence = 9000`,
        [worldId, claimId]);
    });

    const result = await withSerializable((client) => runAccusations(client, {
      worldId, tick: 5, seq: createSeq(0),
      rng: createRng(99), stage: 'trials',
    }));

    assert.ok(result.value.accusations.length <= ACCUSATION.maxPerTick);
    assert.ok(result.value.accusations.length > 0, 'convinced rivals should speak');
    assert.ok(result.value.tensionDelta > 0);

    // The magistrate, the priest, and the physician hold beliefs but are not a
    // side in the war, so they must never be the ones raising tension.
    const unaligned = await query<{ agent_key: string }>(
      `SELECT a.agent_key FROM world_agents a
         JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
        WHERE a.world_id = $1 AND NOT f.belligerent`, [worldId]);
    const unalignedKeys = new Set(unaligned.map((row) => row.agent_key));
    for (const accusation of result.value.accusations) {
      assert.ok(
        !unalignedKeys.has(accusation.accuserKey),
        `${accusation.accuserKey} is not a side in this war and must not push it along`,
      );
    }

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });

  test('an accusation puts a cooling rumor back into circulation', async () => {
    const worldId = await freshWorld(109);

    const claim = await query<{ claim_id: string }>(
      `SELECT claim_id FROM world_claims WHERE world_id = $1 AND claim_key = 'physician_was_paid'`,
      [worldId]);
    const claimId = claim[0]!.claim_id;
    const accuser = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = 'tobias_reeve'`,
      [worldId]);

    await withSerializable(async (client) => {
      await seedRumor(client, {
        worldId, tick: 0, seq: createSeq(0), claimId,
        originAgentId: accuser[0]!.agent_id,
        heat: fromPercent(20), valence: -fromPercent(60),
        text: 'The physician was paid.',
      });
      await client.query(
        `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
         SELECT $1, agent_id, $2, 9000, 0 FROM world_agents WHERE world_id = $1
         ON CONFLICT (world_id, agent_id, claim_id) DO UPDATE SET confidence = 9000`,
        [worldId, claimId]);
    });

    const before = await query<{ heat: number }>(
      `SELECT heat FROM world_rumors WHERE world_id = $1 AND claim_id = $2`, [worldId, claimId]);

    await withSerializable((client) => runAccusations(client, {
      worldId, tick: 5, seq: createSeq(0), rng: createRng(5), stage: 'war',
    }));

    const after = await query<{ heat: number }>(
      `SELECT heat FROM world_rumors WHERE world_id = $1 AND claim_id = $2`, [worldId, claimId]);
    assert.ok(
      after[0]!.heat >= before[0]!.heat,
      'saying it again must not let the story cool further',
    );

    await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
  });
});
