/**
 * Recreate the local Hollowmere database and apply the current schema.
 *
 * This command is deliberately narrower than `migrate.ts --fresh`: it refuses
 * remote hosts, production mode, and database names other than `hollowmere`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { closePool } from '../engine/database/db.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');
const scenarioPath = join(here, '..', 'scenario', 'hollowmere-v2.json');

function localTarget(): { connectionString: string; database: string } {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to reset a database while NODE_ENV=production');
  }

  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`unsupported database protocol: ${url.protocol}`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing to reset non-local database host: ${url.hostname}`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== 'hollowmere') {
    throw new Error(`refusing to reset unexpected database: ${database || '(missing)'}`);
  }
  return { connectionString, database };
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

async function main(): Promise<void> {
  const { connectionString, database } = localTarget();
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/defaultdb';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} CASCADE`);
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await admin.end();
  }

  const schema = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(schema);
  } finally {
    await client.end();
  }

  const scenario = await loadScenarioFile(scenarioPath);
  const published = await publishScenario(scenario);
  console.log(
    `reset local database ${database}, applied the schema, and published ${scenario.version} ` +
    `(${published.checksum.slice(0, 12)})`,
  );
}

try {
  await main();
} finally {
  await closePool();
}
