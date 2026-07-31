/**
 * Initialize a new database from db/schema.sql or incrementally migrate an
 * existing database with the ordered SQL files in db/migrations.
 *
 * `--fresh` drops and recreates the database first, which is what the test
 * harness uses.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'db', 'schema.sql');
const migrationsPath = join(here, '..', 'db', 'migrations');

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
  const migrations = await loadMigrations();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const baseline = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'worlds'
       ) AS exists`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         migration_key STRING PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    if (!baseline.rows[0]?.exists) {
      await client.query(schema);
      for (const migration of migrations) await markApplied(client, migration.key);
      console.log(`applied current schema to ${database}`);
      return;
    }

    for (const migration of migrations) {
      const applied = await client.query(
        `SELECT 1 FROM schema_migrations WHERE migration_key = $1`,
        [migration.key],
      );
      if (applied.rowCount) continue;

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await markApplied(client, migration.key);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`applied migration ${migration.key}`);
    }
    console.log(`database ${database} is current`);
  } finally {
    await client.end();
  }
}

async function loadMigrations(): Promise<{ key: string; sql: string }[]> {
  const names = (await readdir(migrationsPath))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(names.map(async (key) => ({
    key,
    sql: await readFile(join(migrationsPath, key), 'utf8'),
  })));
}

async function markApplied(client: pg.Client, key: string): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (migration_key) VALUES ($1)
     ON CONFLICT (migration_key) DO NOTHING`,
    [key],
  );
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

await main();
