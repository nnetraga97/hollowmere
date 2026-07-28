/**
 * Database access.
 *
 * Two things here are load-bearing for correctness:
 *
 *  1. INT8 columns are parsed as JS numbers, not strings. Every INT8 in this
 *     schema is a tick, a sequence, or a fixed-point value — all far below
 *     2^53 — so this is safe, and without it every arithmetic comparison in
 *     the rules would be doing string comparison instead.
 *
 *  2. `withSerializable` is the only way transactions are run. It retries on
 *     SQLSTATE 40001 and reports how many retries occurred, which the
 *     isolation acceptance test asserts on.
 */

import pg from 'pg';

import { errorLogFields, logError, logInfo, logWarn } from './log.ts';

const INT8_OID = 20;

/**
 * Parse INT8 as a number. Guarded, because a silent precision loss here would
 * corrupt the simulation in a way that is very hard to trace back.
 */
pg.types.setTypeParser(INT8_OID, (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`INT8 value ${value} exceeds safe integer range`);
  }
  return parsed;
});

export type Client = pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    const max = Number(process.env.DB_POOL_MAX ?? 10);
    pool = new pg.Pool({
      ...connectionOptions(connectionString),
      max,
      application_name: 'hollowmere',
    });
    logInfo('database_pool_created', { ...databaseTarget(connectionString), max });
    pool.on('error', (error) => logError('database_pool_error', errorLogFields(error)));
  }
  return pool;
}

/**
 * Build the pg connection options without weakening CockroachDB Cloud TLS.
 *
 * The Cloud console commonly emits a URL whose `sslrootcert` points at a file
 * on the operator's laptop. That path does not exist in a container. Deployment
 * therefore supplies the same certificate as base64 in a secret, while the URL
 * continues to require `verify-full` hostname and certificate verification.
 */
function connectionOptions(connectionString: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: true; ca?: string };
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString };
  }

  if (url.searchParams.get('sslmode') !== 'verify-full') {
    return { connectionString };
  }

  const encodedCa = process.env.DATABASE_CA_CERT_BASE64;
  const ca = encodedCa ? Buffer.from(encodedCa, 'base64').toString('utf8') : undefined;

  // Avoid allowing pg-connection-string to replace this explicit secure TLS
  // object with options parsed from the URL. In particular, sslrootcert often
  // names a local file that is intentionally absent from the production image.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  url.searchParams.delete('sslcert');
  url.searchParams.delete('sslkey');

  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    logInfo('database_pool_closed');
  }
}

/** Convenience for reads outside a transaction. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (error) {
    logError('database_query_failed', {
      statementType: statementType(text),
      parameterCount: params.length,
      ...errorLogFields(error),
    });
    throw error;
  }
}

/**
 * Borrow a pooled client without opening a transaction.
 *
 * Cognition needs this: it reads a great deal and appends memory accesses, but
 * it must not hold a transaction open while waiting on a model — a retry would
 * re-bill the inference, and the lock would be held for the whole round trip.
 */
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export interface TxnOutcome<T> {
  value: T;
  /** Number of times the transaction was retried. Zero on first-attempt success. */
  retries: number;
}

export interface SerializableOptions {
  /** Give up after this many retries. */
  maxRetries?: number;
  /** Label used in error messages, to make a retry storm identifiable. */
  label?: string;
}

const RETRY_SQLSTATE = '40001';

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === RETRY_SQLSTATE
  );
}

/**
 * Run `fn` inside a SERIALIZABLE transaction, retrying on serialization
 * failures.
 *
 * `fn` must contain database work only. In particular it must never perform
 * inference: a retry would re-bill the model call and could emit duplicate
 * streamed output. Cognition therefore runs to completion *before* the
 * transaction opens, and only its result is written here.
 */
export async function withSerializable<T>(
  fn: (client: Client) => Promise<T>,
  options: SerializableOptions = {},
): Promise<TxnOutcome<T>> {
  const maxRetries = options.maxRetries ?? 8;
  const label = options.label ?? 'transaction';
  const client = await getPool().connect();

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query('BEGIN');
        const value = await fn(client);
        await client.query('COMMIT');
        return { value, retries: attempt };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          // The connection may already be unusable; the outer throw is what matters.
        });
        if (!isRetryable(error)) {
          logError('database_transaction_failed', {
            label,
            attempt: attempt + 1,
            ...errorLogFields(error),
          });
          throw error;
        }
        if (attempt >= maxRetries) {
          logError('database_transaction_retries_exhausted', {
            label,
            attempts: attempt + 1,
            maxRetries,
            ...errorLogFields(error),
          });
          throw new Error(
            `${label}: gave up after ${maxRetries} serialization retries`,
            { cause: error },
          );
        }
        // Exponential backoff. Deliberately not jittered: the engine forbids
        // Math.random, and at this concurrency the herd is small enough that
        // plain backoff resolves contention.
        const delayMs = Math.min(2 ** attempt * 5, 200);
        logWarn('database_transaction_retry', {
          label,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          ...errorLogFields(error),
        });
        await sleep(delayMs);
      }
    }
  } finally {
    client.release();
  }
}

function databaseTarget(connectionString: string): Record<string, unknown> {
  try {
    const url = new URL(connectionString);
    return {
      databaseHost: url.hostname,
      databasePort: url.port || null,
      databaseName: url.pathname.replace(/^\//, '') || null,
    };
  } catch {
    return { databaseHost: 'unparseable' };
  }
}

function statementType(text: string): string {
  return text.trimStart().match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? 'UNKNOWN';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
