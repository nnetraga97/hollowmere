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

import { closePool, query, withSerializable } from '../database/db.ts';
import { ScenarioError, resolveRoutine, validateScenario } from '../../scenario/schema.ts';
import { checksumOf, loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import { instantiateWorld, selectCase, selectCulprit } from '../../scenario/instantiate.ts';
import { createSeq } from '../core/seq.ts';
import { maybeUnlockExposure, evaluateExposureEnding } from './exposure.ts';
import { accuseByClaimKey } from '../agents/accusations.ts';
import { recordCaseEvidenceForInquiry } from '../social/evidence.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', '..', 'scenario', 'hollowmere-v2.json');

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
    assert.equal(scenario.agents.length, 30, 'the town should have thirty souls');
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

  test('rejects opening relationship overrides outside the authored town', () => {
    const s = baseScenario();
    (s.opening as { relationshipOverrides?: unknown[] }).relationshipOverrides = [
      { src: 'ghost', dst: 'a1', sentiment: 5000, trust: 5000 },
    ];
    assert.throws(() => validateScenario(s), (error: unknown) => {
      assert.ok(error instanceof ScenarioError);
      assert.match(error.issues.join('\n'), /invalid edge "ghost"/);
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

describe('culprit selection', () => {
  const profile = {
    targetFactions: ['other'], targetsByFaction: { other: ['target'] },
    notebookMethod: 'removed' as const, murderLocation: 'l',
    tamperTiming: 'after_staging' as const, evidence: [],
  };
  const candidates = [
    { culprit_key: 'c', motive_key: 'm', profit_claim_key: 'p', record_claim_key: 'r', claim_truth: {}, case_profile: profile },
    { culprit_key: 'a', motive_key: 'm', profit_claim_key: 'p', record_claim_key: 'r', claim_truth: {}, case_profile: profile },
    { culprit_key: 'b', motive_key: 'm', profit_claim_key: 'p', record_claim_key: 'r', claim_truth: {}, case_profile: profile },
  ];

  test('depends on seed and scenario version, not authored array order', () => {
    const first = selectCulprit(42, 'scenario-id', candidates)?.culprit_key;
    const reversed = selectCulprit(42, 'scenario-id', [...candidates].reverse())?.culprit_key;
    assert.equal(first, reversed);
    assert.ok(new Set(Array.from({ length: 20 }, (_, seed) =>
      selectCulprit(seed, 'scenario-id', candidates)?.culprit_key)).size > 1);
  });

  test('case selection depends on stable scenario version, not a database UUID', () => {
    const first = selectCase(42, 'hollowmere-v4', candidates);
    const repeated = selectCase(42, 'hollowmere-v4', [...candidates].reverse());
    assert.deepEqual(first, repeated);
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
  let stableScenarioVersion: string;
  let candidates: Parameters<typeof selectCase>[2];

  before(async () => {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    stableScenarioVersion = scenario.version;
    const published = await publishScenario(scenario);
    scenarioVersionId = published.scenarioVersionId;
    candidates = await query<Parameters<typeof selectCase>[2][number]>(
      `SELECT culprit_key, motive_key, profit_claim_key, record_claim_key,
              claim_truth, case_profile
         FROM culprit_templates WHERE scenario_version_id = $1 ORDER BY culprit_key`,
      [scenarioVersionId],
    );
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
      inferenceProfile: 'azure_terra',
    });

    const [counts] = await query<{
      agents: number; relationships: number; factions: number;
      claims: number; rumors: number; belief_updates: number; faction_state: number;
      case_evidence: number; opening_evidence: number; inference_profile: string;
      player_location: string;
    }>(
      `SELECT
         (SELECT count(*)::INT8 FROM world_agents WHERE world_id = $1) AS agents,
         (SELECT count(*)::INT8 FROM world_relationships WHERE world_id = $1) AS relationships,
         (SELECT count(*)::INT8 FROM world_factions WHERE world_id = $1) AS factions,
         (SELECT count(*)::INT8 FROM world_claims WHERE world_id = $1) AS claims,
         (SELECT count(*)::INT8 FROM world_rumors WHERE world_id = $1) AS rumors,
         (SELECT count(*)::INT8 FROM belief_updates WHERE world_id = $1) AS belief_updates,
         (SELECT count(*)::INT8 FROM world_case_evidence WHERE world_id = $1) AS case_evidence,
         (SELECT count(*)::INT8 FROM world_player_evidence
           WHERE world_id = $1 AND role = 'tamper_sign') AS opening_evidence,
         (SELECT count(*)::INT8 FROM world_faction_state WHERE world_id = $1) AS faction_state,
         (SELECT inference_profile FROM worlds WHERE world_id = $1) AS inference_profile,
         (SELECT location.location_key FROM world_players player
           JOIN world_locations location
             ON location.world_id = player.world_id AND location.location_id = player.location_id
          WHERE player.world_id = $1) AS player_location`,
      [world.worldId],
    );

    assert.equal(counts?.agents, 30);
    assert.equal(counts?.factions, 3);
    // Every ordered pair, so gossip weighting always has a defined edge.
    assert.equal(counts?.relationships, 30 * 29);
    assert.equal(counts?.claims, 22);
    assert.equal(counts?.rumors, 1);
    assert.ok((counts?.belief_updates ?? 0) >= 10);
    assert.equal(counts?.case_evidence, 5);
    assert.equal(counts?.opening_evidence, 1);
    assert.equal(counts?.faction_state, 3);
    assert.equal(counts?.inference_profile, 'azure_terra');
    assert.equal(counts?.player_location, 'chapel');

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

  test('all six selected cases resolve coherent world truth and five breadcrumbs', async () => {
    const seedByCulprit = new Map<string, number>();
    for (let seed = 0; seed < 500 && seedByCulprit.size < 6; seed++) {
      const selected = selectCase(seed, stableScenarioVersion, candidates);
      if (selected) seedByCulprit.set(selected.culprit.culprit_key, seed);
    }
    assert.deepEqual([...seedByCulprit.keys()].sort(), [
      'alric_corvane', 'ambrose_kyte', 'father_ansel',
      'hollis_barrow', 'rusk_baelen', 'sella_dorn',
    ]);

    for (const [culpritKey, seed] of seedByCulprit) {
      const world = await instantiateWorld({
        scenarioVersionId, seed, sessionId: `case-${culpritKey}-${Date.now()}`,
      });
      const rows = await query<{
        culprit_key: string; culprit_faction: string; target_faction: string;
        evidence_count: number; unresolved_text: number; victim_faction: string;
      }>(
        `SELECT culprit.agent_key AS culprit_key, faction.faction_key AS culprit_faction,
                marker.case_state->>'targetFactionKey' AS target_faction,
                (SELECT count(*)::INT8 FROM world_case_evidence
                  WHERE world_id = $1) AS evidence_count,
                (SELECT count(*)::INT8 FROM world_claims
                  WHERE world_id = $1 AND text LIKE '%{%') AS unresolved_text,
                (SELECT victim_faction.faction_key FROM world_agents victim
                   JOIN world_factions victim_faction
                     ON victim_faction.world_id = victim.world_id
                    AND victim_faction.faction_id = victim.faction_id
                  WHERE victim.world_id = $1 AND victim.agent_key = 'edryc_aldreth') AS victim_faction
           FROM world_culprit marker
           JOIN world_agents culprit
             ON culprit.world_id = marker.world_id AND culprit.agent_id = marker.agent_id
           JOIN world_factions faction
             ON faction.world_id = culprit.world_id AND faction.faction_id = culprit.faction_id
          WHERE marker.world_id = $1`,
        [world.worldId],
      );
      const row = rows[0]!;
      assert.equal(row.culprit_key, culpritKey);
      assert.equal(row.evidence_count, 5);
      assert.equal(row.unresolved_text, 0);
      assert.equal(row.victim_faction, 'unaligned');
      if (row.culprit_faction === 'aldreth') assert.equal(row.target_faction, 'corvane');
      if (row.culprit_faction === 'corvane') assert.equal(row.target_faction, 'aldreth');
      await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
    }
  });

  test('five genuine roles unlock both verdicts, including an unaligned culprit', async () => {
    const seed = Array.from({ length: 500 }, (_, value) => value).find((value) =>
      selectCase(value, stableScenarioVersion, candidates)?.culprit.culprit_key === 'father_ansel');
    assert.notEqual(seed, undefined);
    const world = await instantiateWorld({
      scenarioVersionId, seed: seed!, sessionId: `case-proof-${Date.now()}`,
    });
    const [player] = await query<{ player_id: string }>(
      `SELECT player_id FROM world_players WHERE world_id = $1`, [world.worldId],
    );
    const definitions = await query<{ role: string; holder_agent_id: string }>(
      `SELECT role, holder_agent_id FROM world_case_evidence
        WHERE world_id = $1 AND role IN ('tamper_comparator', 'escalation_provenance')`,
      [world.worldId],
    );
    const [openingEvent] = await query<{ event_id: string }>(
      `SELECT event_id FROM world_events WHERE world_id = $1 ORDER BY tick, seq LIMIT 1`,
      [world.worldId],
    );
    const comparator = definitions.find((row) => row.role === 'tamper_comparator')!;
    const discovered = await withSerializable((client) => recordCaseEvidenceForInquiry(client, {
      worldId: world.worldId, playerId: player!.player_id,
      agentId: comparator.holder_agent_id, eventId: openingEvent!.event_id, tick: 1,
    }));
    assert.equal(discovered.value, 'tamper_comparator');
    await query(
      `INSERT INTO world_player_evidence
         (world_id, player_id, kind, role, claim_id, accused_id, genuine, found_tick)
       SELECT definition.world_id, $2, definition.kind, definition.role,
              definition.claim_id, definition.accused_id, true, 1
         FROM world_case_evidence definition
        WHERE definition.world_id = $1
          AND definition.role NOT IN ('tamper_sign', 'tamper_comparator', 'escalation_provenance')
       ON CONFLICT DO NOTHING`,
      [world.worldId, player!.player_id],
    );
    const incomplete = await withSerializable((client) => maybeUnlockExposure(client, {
      worldId: world.worldId, playerId: player!.player_id, tick: 1, seq: createSeq(1),
    }));
    assert.equal(incomplete.value, false, 'one missing role must keep the verdicts locked');
    const escalation = definitions.find((row) => row.role === 'escalation_provenance')!;
    const provenance = await withSerializable((client) => recordCaseEvidenceForInquiry(client, {
      worldId: world.worldId, playerId: player!.player_id,
      agentId: escalation.holder_agent_id, eventId: openingEvent!.event_id, tick: 1,
    }));
    assert.equal(provenance.value, 'escalation_provenance');
    const unlocked = await withSerializable((client) => maybeUnlockExposure(client, {
      worldId: world.worldId, playerId: player!.player_id, tick: 1, seq: createSeq(1),
    }));
    assert.equal(unlocked.value, true);
    const verdicts = await query<{ claim_key: string; locked: boolean }>(
      `SELECT claim_key, locked FROM world_claims WHERE world_id = $1
        AND claim_key IN ('instigator_altered_notebook', 'instigator_murdered_for_war')
        ORDER BY claim_key`, [world.worldId],
    );
    assert.equal(verdicts.length, 2);
    assert.ok(verdicts.every((claim) => !claim.locked));

    const [speaker] = await query<{ agent_id: string }>(
      `SELECT agent_id FROM world_agents WHERE world_id = $1 AND agent_key = 'alric_corvane'`,
      [world.worldId],
    );
    const accusation = await withSerializable((client) => accuseByClaimKey(client, {
      worldId: world.worldId, tick: 1, seq: createSeq(100),
      accuserId: speaker!.agent_id, claimKey: 'instigator_murdered_for_war',
    }));
    assert.equal(accusation.value?.rise, 0, 'resolution may spread without House tension');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('an unavailable neutral authority selects the explicit war fallback', async () => {
    const world = await instantiateWorld({
      scenarioVersionId, seed: 77, sessionId: `case-fallback-${Date.now()}`,
    });
    await query(
      `UPDATE world_agents SET status = 'missing'
        WHERE world_id = $1 AND agent_key = 'veranne_thule'`, [world.worldId],
    );
    const result = await withSerializable((client) => evaluateExposureEnding(client, {
      worldId: world.worldId, tick: 1, seq: createSeq(1),
    }));
    assert.equal(result.value, 'war');
    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });
});

async function snapshotTension(worldId: string): Promise<unknown[]> {
  return query(
    `SELECT global_tension, escalation_stage, peace_streak
       FROM world_state WHERE world_id = $1`,
    [worldId],
  );
}
