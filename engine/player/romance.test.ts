import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../database/db.ts';
import { chooseRomanceMoment, getRomanceArcs } from './romance.ts';
import {
  ROMANCE_AGENT_KEYS, ROMANCE_CANDIDATES, epilogueFor, isCrisisStage,
  romanceStatusAfterChoice,
} from './romance-content.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';

describe('romance content', () => {
  test('provides exactly two independent, full-length routes', () => {
    assert.deepEqual([...ROMANCE_AGENT_KEYS], ['maren_aldreth', 'rowan_corvane']);
    for (const key of ROMANCE_AGENT_KEYS) {
      const candidate = ROMANCE_CANDIDATES[key];
      assert.equal(candidate.scenes.length, 6);
      assert.equal(new Set(candidate.scenes.map((scene) => scene.key)).size, 6);
      assert.ok(candidate.profile.centralWound.length > 100);
      assert.ok(candidate.profile.affectionStyle.length > 100);
      assert.ok(candidate.profile.boundaries.length >= 3);
      assert.ok(candidate.profile.actionLogic.length >= 3);
    }
  });

  test('every scene has pressure-aware prose and three meaningful paths', () => {
    for (const candidate of Object.values(ROMANCE_CANDIDATES)) {
      for (const [index, scene] of candidate.scenes.entries()) {
        assert.equal(scene.chapter, index + 1);
        assert.ok(scene.crisisNarration);
        assert.ok(scene.crisisOpening);
        assert.equal(scene.choices.length, 3);
        assert.equal(new Set(scene.choices.map((choice) => choice.key)).size, 3);
        for (const choice of scene.choices) {
          assert.ok(choice.response.length > 80);
          assert.ok(choice.crisisResponse && choice.crisisResponse.length > 80);
          assert.ok(choice.aftermath.length > 50);
          assert.ok(choice.flag.startsWith(keyPrefix(candidate.agentKey)));
        }
      }
    }
  });

  test('both routes alter investigation or faction state', () => {
    for (const candidate of Object.values(ROMANCE_CANDIDATES)) {
      const effects = candidate.scenes.flatMap((scene) => scene.choices.map((choice) => choice.effects));
      assert.ok(effects.some((effect) => effect.revealClaimKeys?.length));
      assert.ok(effects.some((effect) => effect.rumorHeat));
      assert.ok(effects.some((effect) => effect.negotiation));
      assert.ok(effects.some((effect) => effect.globalTension));
      assert.ok(effects.some((effect) => effect.status === 'committed'));
      assert.ok(effects.some((effect) => effect.status === 'platonic'));
      assert.ok(effects.some((effect) => effect.status === 'strained'));
    }
  });

  test('status progression never consults or locks the other route', () => {
    const marenChoice = ROMANCE_CANDIDATES.maren_aldreth.scenes[4]!.choices[0]!;
    const rowanChoice = ROMANCE_CANDIDATES.rowan_corvane.scenes[4]!.choices[0]!;
    assert.equal(romanceStatusAfterChoice('growing', marenChoice, 5), 'courting');
    assert.equal(romanceStatusAfterChoice('growing', rowanChoice, 5), 'courting');
    assert.equal(romanceStatusAfterChoice('committed', rowanChoice, 5), 'courting');
  });

  test('pressure and ending variants are deterministic', () => {
    assert.equal(isCrisisStage('calm'), false);
    assert.equal(isCrisisStage('accusations'), true);
    assert.match(epilogueFor(ROMANCE_CANDIDATES.maren_aldreth, 'peace', 'committed'), /Maren/);
    assert.match(epilogueFor(ROMANCE_CANDIDATES.rowan_corvane, 'war', 'platonic'), /Rowan/);
  });
});

const databaseSuite = process.env.DATABASE_URL ? describe : describe.skip;

databaseSuite('romance persistence', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sessionId = `romance-test-${Date.now()}`;
  let worldId = '';

  before(async () => {
    const scenario = await loadScenarioFile(join(here, '..', '..', 'scenario', 'hollowmere-v2.json'));
    const published = await publishScenario(scenario);
    worldId = (await instantiateWorld({
      scenarioVersionId: published.scenarioVersionId,
      seed: 909,
      sessionId,
      playerLocationKey: 'high_row',
      playerName: 'Ari',
    })).worldId;
  });

  after(async () => {
    if (worldId) await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
    await closePool();
  });

  test('both routes can advance on the same tick without exclusivity', async () => {
    const ref = { worldId, sessionId };
    const initial = await getRomanceArcs(ref);
    assert.equal(initial.length, 2);
    assert.ok(initial.every((arc) => arc.available && arc.stage === 0));

    const maren = await chooseRomanceMoment({
      ...ref,
      agentKey: 'maren_aldreth',
      sceneKey: 'maren_rain_between_bells',
      choiceKey: 'share_silence',
      locationKey: 'high_row',
      idempotencyKey: 'romance-maren-first',
    });
    const rowan = await chooseRomanceMoment({
      ...ref,
      agentKey: 'rowan_corvane',
      sceneKey: 'rowan_broken_lantern',
      choiceKey: 'hold_lantern',
      locationKey: 'high_row',
      idempotencyKey: 'romance-rowan-first',
    });
    assert.equal(maren.arc.stage, 1);
    assert.equal(rowan.arc.stage, 1);

    const arcs = await getRomanceArcs(ref);
    assert.deepEqual(arcs.map((arc) => [arc.agentKey, arc.stage]), [
      ['maren_aldreth', 1],
      ['rowan_corvane', 1],
    ]);
    const history = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM player_romance_events WHERE world_id = $1`,
      [worldId],
    );
    assert.equal(history[0]?.count, 2);
  });

  test('choice requests are idempotent', async () => {
    const result = await chooseRomanceMoment({
      worldId, sessionId,
      agentKey: 'maren_aldreth',
      sceneKey: 'maren_rain_between_bells',
      choiceKey: 'share_silence',
      locationKey: 'high_row',
      idempotencyKey: 'romance-maren-first',
    });
    assert.equal(result.replayed, true);
    const rows = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM player_romance_events
        WHERE world_id = $1 AND scene_key = 'maren_rain_between_bells'`,
      [worldId],
    );
    assert.equal(rows[0]?.count, 1);
  });
});

function keyPrefix(agentKey: string): string {
  return agentKey.split('_')[0]!;
}
