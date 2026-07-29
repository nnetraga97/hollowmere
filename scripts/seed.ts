/**
 * Publish the scenario and instantiate a world.
 *
 *   node scripts/seed.ts                       # default scenario, random seed
 *   node scripts/seed.ts --seed 42             # reproducible world
 *   node scripts/seed.ts --scenario path.json
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool, query } from '../engine/database/db.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const scenarioPath = arg('scenario') ?? join(here, '..', 'scenario', 'hollowmere-v2.json');
  const seed = Number(arg('seed') ?? Date.now() % 2_147_483_647);
  const sessionId = arg('session') ?? `seed-cli-${Date.now()}`;

  const scenario = await loadScenarioFile(scenarioPath);
  console.log(`scenario: ${scenario.name} (${scenario.version})`);
  console.log(`  ${scenario.factions.length} factions, ${scenario.agents.length} agents, ` +
              `${scenario.locations.length} locations, ${scenario.claims.length} claims, ` +
              `${scenario.triggers.length} triggers`);

  const published = await publishScenario(scenario);
  console.log(`published: ${published.scenarioVersionId} ` +
              `(${published.created ? 'new' : 'existing'}, checksum ${published.checksum.slice(0, 12)})`);

  const world = await instantiateWorld({
    scenarioVersionId: published.scenarioVersionId,
    seed,
    sessionId,
  });
  console.log(`world: ${world.worldId}`);
  console.log(`  seed ${seed}, ${world.agentCount} agents instantiated`);

  // Without statistics the optimizer ignores the vector index on
  // world_memories. Establish them at seed time; auto-stats maintains them after.
  await query('ANALYZE world_memories');
  await query('ANALYZE world_relationships');

  const [counts] = await query<{
    agents: number; relationships: number; claims: number; rumors: number; events: number;
  }>(
    `SELECT
       (SELECT count(*)::INT8 FROM world_agents WHERE world_id = $1) AS agents,
       (SELECT count(*)::INT8 FROM world_relationships WHERE world_id = $1) AS relationships,
       (SELECT count(*)::INT8 FROM world_claims WHERE world_id = $1) AS claims,
       (SELECT count(*)::INT8 FROM world_rumors WHERE world_id = $1) AS rumors,
       (SELECT count(*)::INT8 FROM world_events WHERE world_id = $1) AS events`,
    [world.worldId],
  );
  console.log(`  ${counts?.relationships} relationships, ${counts?.claims} claims, ` +
              `${counts?.rumors} rumors in circulation, ${counts?.events} events`);
}

try {
  await main();
} finally {
  await closePool();
}
