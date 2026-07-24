/**
 * Apply db/schema.sql to the configured database.
 *
 * The schema is idempotent (CREATE ... IF NOT EXISTS throughout), so this is
 * safe to re-run. `--fresh` drops and recreates the database first, which is
 * what the test harness uses.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');

function parseDatabaseName(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!name) throw new Error('DATABASE_URL must include a database name');
  return name;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const database = parseDatabaseName(connectionString);
  const fresh = process.argv.includes('--fresh');

  if (fresh) {
    // Connect to the default database to drop/recreate the target.
    const adminUrl = new URL(connectionString);
    adminUrl.pathname = '/defaultdb';
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} CASCADE`);
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
    await admin.end();
    console.log(`recreated database ${database}`);
  }

  const schema = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(schema);
    console.log(`applied schema to ${database}`);
  } finally {
    await client.end();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

await main();
