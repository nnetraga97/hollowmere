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
    pool = new pg.Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      application_name: 'hollowmere',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Convenience for reads outside a transaction. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
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
          throw error;
        }
        if (attempt >= maxRetries) {
          throw new Error(
            `${label}: gave up after ${maxRetries} serialization retries`,
            { cause: error },
          );
        }
        // Exponential backoff. Deliberately not jittered: the engine forbids
        // Math.random, and at this concurrency the herd is small enough that
        // plain backoff resolves contention.
        await sleep(Math.min(2 ** attempt * 5, 200));
      }
    }
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
