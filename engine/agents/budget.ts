/**
 * Per-world inference accounting.
 *
 * Every world is a private simulation with its own model spend, and worlds are
 * created by anyone who loads the page. Without a per-world cap, one tab left
 * open overnight is an unbounded bill. The cap is therefore not a nicety; it is
 * the thing that makes public deployment safe.
 *
 * Exhausting the budget must never break a world. Cognition falls back to a
 * deterministic planner, the town keeps running on rules, and the only visible
 * difference is that nobody says anything newly interesting.
 */

import type { Client } from '../database/db.ts';
import { COGNITION } from '../core/config.ts';

/**
 * Estimated Bedrock pricing in micro-dollars per 1,000 tokens.
 *
 * Integers, like every other quantity the engine tracks — money is exactly the
 * kind of value where accumulated float error would be embarrassing. These are
 * list prices for Claude Haiku and are only ever used for reporting, never to
 * gate a call: the call count is what the cap compares against, because it does
 * not drift when prices change.
 */
export const PRICING = {
  inputMicrosPerThousand: 800,
  outputMicrosPerThousand: 4_000,
  /** The stub costs nothing, and saying so keeps stub runs honest in reports. */
  stubMicrosPerThousand: 0,
} as const;

export interface UsageDelta {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Stub usage is counted but priced at zero. */
  billable: boolean;
}

export interface BudgetState {
  inferenceCalls: number;
  tokensIn: number;
  tokensOut: number;
  estCostMicros: number;
  /** The world has spent its allowance and cognition must degrade. */
  exhausted: boolean;
}

export function estimateCostMicros(usage: UsageDelta): number {
  if (!usage.billable) return 0;
  return (
    Math.trunc((usage.tokensIn * PRICING.inputMicrosPerThousand) / 1_000) +
    Math.trunc((usage.tokensOut * PRICING.outputMicrosPerThousand) / 1_000)
  );
}

/** Add usage to the world's running total and report the state afterwards. */
export async function recordUsage(
  client: Client,
  worldId: string,
  usage: UsageDelta,
): Promise<BudgetState> {
  const result = await client.query<{
    inference_calls: number; tokens_in: number; tokens_out: number; est_cost_micros: number;
  }>(
    `UPDATE world_budget
        SET inference_calls = inference_calls + $2,
            tokens_in = tokens_in + $3,
            tokens_out = tokens_out + $4,
            est_cost_micros = est_cost_micros + $5
      WHERE world_id = $1
      RETURNING inference_calls, tokens_in, tokens_out, est_cost_micros`,
    [worldId, usage.calls, usage.tokensIn, usage.tokensOut, estimateCostMicros(usage)],
  );

  const row = result.rows[0];
  if (!row) throw new Error(`world ${worldId} has no world_budget row`);
  return toState(row);
}

export async function readBudget(client: Client, worldId: string): Promise<BudgetState> {
  const result = await client.query<{
    inference_calls: number; tokens_in: number; tokens_out: number; est_cost_micros: number;
  }>(
    `SELECT inference_calls, tokens_in, tokens_out, est_cost_micros
       FROM world_budget WHERE world_id = $1`,
    [worldId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`world ${worldId} has no world_budget row`);
  return toState(row);
}

function toState(row: {
  inference_calls: number; tokens_in: number; tokens_out: number; est_cost_micros: number;
}): BudgetState {
  return {
    inferenceCalls: row.inference_calls,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    estCostMicros: row.est_cost_micros,
    exhausted: row.inference_calls >= COGNITION.callBudget,
  };
}
