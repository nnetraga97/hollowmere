import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const roleFiles = [
  join(here, '..', 'db', 'runtime-role.sql'),
  join(here, '..', 'db', 'read-only-role.sql'),
];

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe database identifier: ${name}`);
  }
  return `"${name}"`;
}

function databaseName(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!name) throw new Error('DATABASE_URL must include a database name');
  return name;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const database = databaseName(connectionString);
  const identifier = quoteIdent(database);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const file of roleFiles) {
      const template = await readFile(file, 'utf8');
      const sql = template.replaceAll('{{DATABASE_NAME}}', identifier);
      if (sql.includes('{{DATABASE_NAME}}')) throw new Error(`unresolved database placeholder in ${file}`);
      await client.query(sql);
    }
    console.log(`applied hollowmere_runtime and hollowmere_reader to ${database}`);
  } finally {
    await client.end();
  }
}

await main();
