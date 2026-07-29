/**
 * Scheduler leases.
 *
 * A world advances under exactly one scheduler at a time. The lease is the
 * cheap, cooperative half of that guarantee: a worker takes a time-limited
 * claim on a world, renews it while it works, and drops it when it stops. If
 * the worker dies, the claim expires and another picks the world up without
 * anyone having to notice the failure.
 *
 * The lease is not the safety property, though — it is the efficiency one. Two
 * schedulers convinced they both own a world (a partition, a paused process, a
 * clock skew) is a situation that must be *safe*, not merely unlikely, and that
 * comes from `world_tick_commits` carrying `PRIMARY KEY (world_id, tick)`: the
 * second writer's tick simply cannot commit. The lease keeps that from
 * happening constantly; the primary key keeps it from ever mattering.
 */

import { query, type Client } from './db.ts';

export interface LeaseOptions {
  /** Identifies the worker. Recorded so a stuck lease can be traced to a process. */
  owner: string;
  /** How long the claim is good for. Renew well inside this. */
  ttlMs: number;
}

/**
 * Take or extend a claim on a world.
 *
 * Succeeds when the world is unclaimed, already ours, or held by a lease that
 * has expired. Returns false when someone else holds a live claim.
 */
export async function acquireLease(
  worldId: string,
  options: LeaseOptions,
): Promise<boolean> {
  const rows = await query<{ world_id: string }>(
    `UPDATE worlds
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 || ' milliseconds')::INTERVAL
      WHERE world_id = $1
        AND status = 'active'
        AND (lease_owner IS NULL OR lease_owner = $2 OR lease_expires_at < now())
      RETURNING world_id`,
    [worldId, options.owner, options.ttlMs],
  );
  return rows.length > 0;
}

/** Extend a claim we already hold. False means we lost it and must stop. */
export async function renewLease(
  worldId: string,
  options: LeaseOptions,
): Promise<boolean> {
  const rows = await query<{ world_id: string }>(
    `UPDATE worlds
        SET lease_expires_at = now() + ($3 || ' milliseconds')::INTERVAL
      WHERE world_id = $1 AND lease_owner = $2
      RETURNING world_id`,
    [worldId, options.owner, options.ttlMs],
  );
  return rows.length > 0;
}

/** Give up a claim so another worker can take the world immediately. */
export async function releaseLease(worldId: string, owner: string): Promise<void> {
  await query(
    `UPDATE worlds SET lease_owner = NULL, lease_expires_at = NULL
      WHERE world_id = $1 AND lease_owner = $2`,
    [worldId, owner],
  );
}

/**
 * Worlds that want advancing and are not currently spoken for.
 *
 * Ordered by how long they have been waiting, so a busy scheduler starves no
 * world; `limit` is what keeps one worker from claiming everything before its
 * siblings wake up.
 */
export async function findSchedulableWorlds(
  limit: number,
  only?: readonly string[],
): Promise<string[]> {
  const rows = await query<{ world_id: string }>(
    `SELECT world_id FROM worlds
      WHERE status = 'active'
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND ($2::UUID[] IS NULL OR world_id = ANY($2::UUID[]))
      ORDER BY last_activity_at DESC, world_id
      LIMIT $1`,
    [limit, only ?? null],
  );
  return rows.map((row) => row.world_id);
}

/** Mark a world as touched, which is what the pause and expiry rules read. */
export async function touchWorld(client: Client, worldId: string): Promise<void> {
  await client.query(
    `UPDATE worlds SET last_activity_at = now() WHERE world_id = $1`,
    [worldId],
  );
}
