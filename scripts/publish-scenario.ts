import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool } from '../engine/database/db.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const scenarioPath = process.env.SCENARIO_PATH
  ?? join(here, '..', 'scenario', 'hollowmere-v2.json');

try {
  const scenario = await loadScenarioFile(scenarioPath);
  const result = await publishScenario(scenario);
  console.log(
    `${result.created ? 'published' : 'verified'} scenario ${scenario.version} `
    + `(${result.checksum.slice(0, 12)})`,
  );
} finally {
  await closePool();
}
