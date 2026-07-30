import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function roleUrl(source: URL, database: string, role: string): string {
  const value = new URL(source);
  value.pathname = `/${database}`;
  value.username = role;
  value.password = '';
  return value.toString();
}

async function expectDenied(client: pg.Client, sql: string, label: string): Promise<void> {
  await assert.rejects(
    client.query(sql),
    (error: unknown) => Boolean(
      error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === '42501'
    ),
    `${label} should fail with insufficient privilege`,
  );
}

async function main(): Promise<void> {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error('DATABASE_URL is not set');
  const source = new URL(configured);
  if (!['localhost', '127.0.0.1'].includes(source.hostname)
    || source.searchParams.get('sslmode') !== 'disable') {
    throw new Error('check:db-roles only runs against an explicit local insecure cluster');
  }

  const database = `hollowmere_role_check_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = '/defaultdb';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
    const databaseUrl = new URL(source);
    databaseUrl.pathname = `/${database}`;
    const migrator = new pg.Client({ connectionString: databaseUrl.toString() });
    await migrator.connect();
    try {
      await migrator.query(await readFile(join(here, '..', 'db', 'schema.sql'), 'utf8'));
      for (const file of ['runtime-role.sql', 'read-only-role.sql']) {
        const template = await readFile(join(here, '..', 'db', file), 'utf8');
        await migrator.query(template.replaceAll('{{DATABASE_NAME}}', quoteIdent(database)));
      }
      await migrator.query(
        `INSERT INTO scenario_versions (version, name, checksum, schema_version)
         VALUES ('role-check', 'Role Check', 'role-check', 1)`,
      );
      const sequences = await migrator.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.sequences WHERE sequence_schema = 'public'`,
      );
      assert.equal(Number(sequences.rows[0]?.count ?? -1), 0,
        'the schema has no sequences and therefore requires no sequence grant');
    } finally {
      await migrator.end();
    }

    const runtime = new pg.Client({
      connectionString: roleUrl(source, database, 'hollowmere_runtime'),
    });
    await runtime.connect();
    try {
      await runtime.query(`SELECT count(*) FROM scenario_versions`);
      await runtime.query(
        `INSERT INTO worlds (scenario_version_id, seed)
         SELECT scenario_version_id, 1 FROM scenario_versions WHERE version = 'role-check'`,
      );
      await runtime.query(`UPDATE worlds SET status = 'paused' WHERE seed = 1`);
      await runtime.query(`DELETE FROM worlds WHERE seed = 1`);
      await expectDenied(runtime,
        `INSERT INTO scenario_versions (version, name, checksum, schema_version)
         VALUES ('forbidden', 'Forbidden', 'forbidden', 1)`,
        'scenario publication');
      await expectDenied(runtime, `CREATE TABLE forbidden_runtime_table (id INT PRIMARY KEY)`,
        'table creation');
      await expectDenied(runtime, `CREATE SCHEMA forbidden_runtime_schema`, 'schema creation');
      await expectDenied(runtime, `CREATE DATABASE forbidden_runtime_database`, 'database creation');
      await expectDenied(runtime, `CREATE ROLE forbidden_runtime_role`, 'role creation');
      await expectDenied(runtime,
        `SET CLUSTER SETTING sql.defaults.vectorize = 'on'`, 'cluster-setting mutation');
    } finally {
      await runtime.end();
    }

    const reader = new pg.Client({
      connectionString: roleUrl(source, database, 'hollowmere_reader'),
    });
    await reader.connect();
    try {
      await reader.query(`SELECT count(*) FROM archivist_memory_sources`);
      await expectDenied(reader,
        `INSERT INTO worlds (scenario_version_id, seed)
         SELECT scenario_version_id, 2 FROM scenario_versions WHERE version = 'role-check'`,
        'reader write');
    } finally {
      await reader.end();
    }

    console.log(`runtime and reader role checks passed in ${database}`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} CASCADE`);
    await admin.end();
  }
}

await main();
