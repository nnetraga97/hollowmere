import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query } from '../database/db.ts';
import { createRng, deriveSeed } from '../core/rng.ts';
import { instantiateWorld } from '../../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../../scenario/publish.ts';
import {
  fabricationChance, getPlayerRumors, manufacturePlayerEvidence,
  plantPlayerRumor, sourceCredibility,
} from './deception.ts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', '..', 'scenario', 'hollowmere-v2.json');

describe('player deception rules', () => {
  test('trust and reputation jointly determine source credibility', () => {
    assert.ok(sourceCredibility(8_000, 6_000) > sourceCredibility(8_000, -6_000));
    assert.ok(sourceCredibility(8_000, 6_000) > sourceCredibility(3_000, 6_000));
  });

  test('fabrication is helped by reach, useful locations, chaos, and background', () => {
    const weak = fabricationChance({
      reach: 3, tension: 0, locationKey: 'plaza', backgroundBonus: 0,
    });
    const prepared = fabricationChance({
      reach: 8, tension: 8_000, locationKey: 'granary', backgroundBonus: 1_500,
    });
    assert.ok(prepared > weak);
    assert.ok(weak >= 1_200 && prepared <= 6_500);
  });
});

describe('player deception against CockroachDB', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId = '';
  const worlds: string[] = [];

  before(async () => {
    scenarioVersionId = (await publishScenario(await loadScenarioFile(SCENARIO_PATH))).scenarioVersionId;
  });

  after(async () => {
    for (const worldId of worlds) await query(`DELETE FROM worlds WHERE world_id = $1`, [worldId]);
    await closePool();
  });

  test('a novel lie becomes a false claim and listeners decide their own confidence', async () => {
    // Three rumor commands followed by fabrication use command sequence 4.
    // Pick a deterministic seed whose skilled, market-based attempt succeeds.
    const chance = fabricationChance({
      reach: 3, tension: 0, locationKey: 'market_square', backgroundBonus: 1_500,
    });
    let seed = 8_200;
    while (!createRng(deriveSeed(seed, 4, 'manufacture-evidence')).chance(chance)) seed++;

    const sessionId = `deception-${seed}-${Date.now()}`;
    const world = await instantiateWorld({
      scenarioVersionId, seed, sessionId,
      playerProfile: { background: 'A meticulous scribe', sympathyFactionKey: null },
    });
    worlds.push(world.worldId);
    const ref = { worldId: world.worldId, sessionId };

    const location = await query<{ location_id: string }>(
      `SELECT location_id FROM world_locations
        WHERE world_id = $1 AND location_key = 'market_square'`,
      [world.worldId],
    );
    assert.ok(location[0]);
    await query(
      `UPDATE world_players SET location_id = $2 WHERE world_id = $1`,
      [world.worldId, location[0].location_id],
    );
    await query(
      `UPDATE world_agents SET location_id = $2
        WHERE world_id = $1 AND agent_id IN (
          SELECT agent_id FROM world_agents
           WHERE world_id = $1 AND status = 'alive'
           ORDER BY agent_key LIMIT 3
        )`,
      [world.worldId, location[0].location_id],
    );
    const listeners = await query<{ agent_key: string }>(
      `SELECT agent_key FROM world_agents
        WHERE world_id = $1 AND location_id = $2 AND status = 'alive'
        ORDER BY agent_key LIMIT 3`,
      [world.worldId, location[0].location_id],
    );
    const subject = await query<{ agent_key: string }>(
      `SELECT agent_key FROM world_agents
        WHERE world_id = $1 AND status = 'alive'
          AND agent_key NOT IN ($2, $3, $4)
        ORDER BY agent_key LIMIT 1`,
      [world.worldId, listeners[0]!.agent_key, listeners[1]!.agent_key, listeners[2]!.agent_key],
    );
    assert.ok(subject[0]);

    const firstInput = {
      ...ref,
      listenerAgentKey: listeners[0]!.agent_key,
      subjectAgentKey: subject[0].agent_key,
      text: 'A hidden payment ledger proves this person sold names to both houses',
      idempotencyKey: 'plant-one',
    };
    const first = await plantPlayerRumor(firstInput);
    const replay = await plantPlayerRumor(firstInput);
    assert.equal(replay.replayed, true);
    assert.equal(replay.commandId, first.commandId);
    assert.ok(['believes', 'uncertain', 'rejects'].includes(first.reaction));

    const claim = await query<{ truth: string; authored: boolean; confidence: number }>(
      `SELECT claim.truth, claim.authored, belief.confidence
         FROM world_claims claim
         JOIN world_agents listener
           ON listener.world_id = claim.world_id AND listener.agent_key = $3
         JOIN agent_beliefs belief
           ON belief.world_id = claim.world_id AND belief.claim_id = claim.claim_id
          AND belief.agent_id = listener.agent_id
        WHERE claim.world_id = $1 AND claim.claim_key = $2`,
      [world.worldId, first.claimKey, listeners[0]!.agent_key],
    );
    assert.deepEqual(claim[0], {
      truth: 'false', authored: false, confidence: first.confidenceAfter,
    });
    const source = await query<{ from_player: boolean; no_agent_source: boolean }>(
      `SELECT telling.from_player_id = player.player_id AS from_player,
              telling.from_agent_id IS NULL AS no_agent_source
         FROM world_rumor_tellings telling
         JOIN world_players player
           ON player.world_id = telling.world_id AND player.session_id = $3
         JOIN world_claims claim
           ON claim.world_id = telling.world_id AND claim.claim_id = telling.claim_id
        WHERE telling.world_id = $1 AND claim.claim_key = $2
        ORDER BY telling.seq LIMIT 1`,
      [world.worldId, first.claimKey, sessionId],
    );
    assert.deepEqual(source[0], { from_player: true, no_agent_source: true });

    for (let index = 1; index < 3; index++) {
      await plantPlayerRumor({
        ...ref, claimKey: first.claimKey,
        listenerAgentKey: listeners[index]!.agent_key,
        idempotencyKey: `plant-${index + 1}`,
      });
    }
    const beforeForgery = await getPlayerRumors(ref);
    assert.equal(beforeForgery[0]?.reach, 3);

    const forged = await manufacturePlayerEvidence({
      ...ref, claimKey: first.claimKey, idempotencyKey: 'forge-one',
    });
    assert.equal(forged.outcome, 'created');
    assert.ok(forged.evidenceId);
    const evidence = await query<{ genuine: boolean; manufactured: boolean; credibility: number }>(
      `SELECT genuine, manufactured, credibility FROM world_player_evidence
        WHERE world_id = $1 AND evidence_id = $2`,
      [world.worldId, forged.evidenceId],
    );
    assert.deepEqual(evidence[0], {
      genuine: false, manufactured: true, credibility: forged.quality,
    });
  });
});
