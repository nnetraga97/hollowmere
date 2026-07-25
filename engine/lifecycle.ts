/**
 * World lifecycle.
 *
 * A world is created by anyone who opens the page, and nobody ever tells us
 * they have finished with it. Left alone, a browser tab closed on a train is a
 * world that ticks — and spends — forever. So the rules here are cost control
 * before they are anything else:
 *
 *  - **Pause** a world nobody has touched in ten minutes. It keeps its state
 *    and resumes exactly where it stopped if the player comes back.
 *  - **Expire** a world a day old. Its history is still readable; it simply
 *    stops being a live simulation.
 *  - **Cap** total advancing time at thirty minutes per world. This is the one
 *    that bounds spend, because it bounds ticks regardless of how the player
 *    comes and goes.
 *
 * All three are expressed in wall-clock time, which is the one place the engine
 * legitimately uses it: they are operational policy, not simulation.
 */

import { query } from './db.ts';

export const IDLE_PAUSE_MS = 10 * 60 * 1_000;
export const EXPIRY_MS = 24 * 60 * 60 * 1_000;
export const MAX_ACTIVE_RUNTIME_MS = 30 * 60 * 1_000;

export interface SweepResult {
  paused: number;
  expired: number;
  exhausted: number;
}

/**
 * Apply all three rules. Safe to run from several schedulers at once — each
 * statement is a conditional update, so a world moves at most once.
 */
export async function sweepWorlds(): Promise<SweepResult> {
  const paused = await query<{ world_id: string }>(
    `UPDATE worlds SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'active'
        AND last_activity_at < now() - ($1 || ' milliseconds')::INTERVAL
      RETURNING world_id`,
    [IDLE_PAUSE_MS],
  );

  const expired = await query<{ world_id: string }>(
    `UPDATE worlds SET status = 'ended', ending = 'expired',
                       lease_owner = NULL, lease_expires_at = NULL
      WHERE status IN ('active', 'paused')
        AND created_at < now() - ($1 || ' milliseconds')::INTERVAL
      RETURNING world_id`,
    [EXPIRY_MS],
  );

  const exhausted = await query<{ world_id: string }>(
    `UPDATE worlds SET status = 'ended', ending = 'expired',
                       lease_owner = NULL, lease_expires_at = NULL
      WHERE status IN ('active', 'paused')
        AND active_runtime_ms >= $1
      RETURNING world_id`,
    [MAX_ACTIVE_RUNTIME_MS],
  );

  return {
    paused: paused.length,
    expired: expired.length,
    exhausted: exhausted.length,
  };
}

/** Count advancing time against the world's thirty-minute allowance. */
export async function addActiveRuntime(worldId: string, elapsedMs: number): Promise<number> {
  const rows = await query<{ active_runtime_ms: number }>(
    `UPDATE worlds SET active_runtime_ms = active_runtime_ms + $2
      WHERE world_id = $1
      RETURNING active_runtime_ms`,
    [worldId, Math.max(0, Math.trunc(elapsedMs))],
  );
  return rows[0]?.active_runtime_ms ?? 0;
}

/** Bring a paused world back. Used when a player returns to their session. */
export async function resumeWorld(worldId: string): Promise<boolean> {
  const rows = await query<{ world_id: string }>(
    `UPDATE worlds SET status = 'active', last_activity_at = now()
      WHERE world_id = $1 AND status = 'paused'
      RETURNING world_id`,
    [worldId],
  );
  return rows.length > 0;
}
