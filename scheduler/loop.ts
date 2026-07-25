/**
 * The scheduler service.
 *
 * One process, many worlds, one runner each. Three things here are deliberate:
 *
 *  - **The loop is non-overlapping, never `setInterval`.** A tick that takes
 *    longer than the cadence must delay the next one, not stack on top of it.
 *    With `setInterval` a slow database turns into an ever-growing pile of
 *    concurrent ticks, each contending with the last, which is the classic way
 *    a scheduler takes itself down.
 *  - **A world advances only under a lease**, renewed as it works. If this
 *    process dies, the claim expires and another picks the world up. The lease
 *    is efficiency, though — the safety property is the tick commit's primary
 *    key, which makes a double-advance impossible even if two schedulers are
 *    briefly convinced they both own a world.
 *  - **Failures are per world.** One world throwing must not stop the others,
 *    so a runner that fails logs, drops its lease, and lets the world be picked
 *    up again rather than taking the process with it.
 */

import { runTick, type TickReport } from '../engine/runtick.ts';
import {
  acquireLease, findSchedulableWorlds, releaseLease, renewLease,
} from '../engine/lease.ts';
import { addActiveRuntime, sweepWorlds } from '../engine/lifecycle.ts';
import { SCALE } from '../engine/fixedpoint.ts';
import { query } from '../engine/db.ts';
import type { InferenceClient } from '../engine/inference/index.ts';

export interface SchedulerOptions {
  inference: InferenceClient;
  /** Identifies this process in the lease. */
  owner: string;
  /** Real milliseconds per tick at 1×. */
  tickIntervalMs?: number;
  /** How long a claim is good for. Must comfortably exceed one tick. */
  leaseTtlMs?: number;
  /** How often to look for unclaimed worlds. */
  pollIntervalMs?: number;
  /** Worlds this process will advance at once. */
  maxWorlds?: number;
  /**
   * Restrict this worker to specific worlds.
   *
   * A scheduler normally advances anything that needs advancing, which is the
   * right production behaviour and exactly wrong when two test suites share a
   * database — a worker will happily pick up a world another test is stepping
   * by hand and advance it underneath them. It is also the hook for pinning a
   * worker to a shard during a targeted rehearsal.
   */
  only?: readonly string[];
  /** Structured log sink. Defaults to JSON on stdout. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Worlds currently held by this process. Exposed for health checks. */
  held(): string[];
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const tickIntervalMs = options.tickIntervalMs ?? 5_000;
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxWorlds = options.maxWorlds ?? 25;
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));

  const runners = new Map<string, Promise<void>>();
  let running = false;

  async function advance(worldId: string): Promise<void> {
    let lastSweep = 0;

    for (;;) {
      if (!running) break;

      const started = Date.now();
      let report: TickReport;
      try {
        report = await runTick({ worldId, inference: options.inference });
      } catch (error) {
        // One world's failure is one world's problem. Dropping the lease lets
        // another worker try, which is the right response to a transient fault
        // and harmless for a permanent one (the next worker fails too, and the
        // world is eventually swept).
        log({
          level: 'error', event: 'tick_failed', worldId,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      const elapsed = Date.now() - started;
      await addActiveRuntime(worldId, elapsed);

      log({
        level: 'info', event: 'tick', worldId, tick: report.tick,
        committed: report.committed, skipped: report.skipped,
        stage: report.stage, tension: report.globalTension,
        transmissions: report.transmissions, accusations: report.accusations,
        thinkers: report.thinkers, retries: report.retries,
        durationMs: report.durationMs,
      });

      if (report.ending || report.skipped === 'not_active' || report.skipped === 'tick_ceiling') {
        log({ level: 'info', event: 'world_finished', worldId, ending: report.ending });
        break;
      }

      // Losing the lease mid-run means someone else believes they own this
      // world. Stop immediately rather than racing them.
      if (!(await renewLease(worldId, { owner: options.owner, ttlMs: leaseTtlMs }))) {
        log({ level: 'warn', event: 'lease_lost', worldId });
        break;
      }

      if (!options.only && Date.now() - lastSweep > 60_000) {
        lastSweep = Date.now();
        const swept = await sweepWorlds();
        if (swept.paused + swept.expired + swept.exhausted > 0) {
          log({ level: 'info', event: 'sweep', ...swept });
        }
      }

      // time_scale is a fixed-point multiplier: 20000 runs the town at double
      // speed. It exists for headless capture and video editing, so it is read
      // every tick rather than cached — an operator can change it live.
      const scale = await readTimeScale(worldId);
      const target = Math.max(0, Math.trunc((tickIntervalMs * SCALE) / scale) - elapsed);
      await sleep(target);
    }

    await releaseLease(worldId, options.owner);
    runners.delete(worldId);
  }

  async function poll(): Promise<void> {
    while (running) {
      try {
        const capacity = maxWorlds - runners.size;
        if (capacity > 0) {
          for (const worldId of await findSchedulableWorlds(capacity, options.only)) {
            if (runners.has(worldId)) continue;
            if (!(await acquireLease(worldId, { owner: options.owner, ttlMs: leaseTtlMs }))) {
              continue;
            }
            log({ level: 'info', event: 'world_claimed', worldId, owner: options.owner });
            runners.set(worldId, advance(worldId));
          }
        }
        if (!options.only) await sweepWorlds();
      } catch (error) {
        log({
          level: 'error', event: 'poll_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      log({ level: 'info', event: 'scheduler_started', owner: options.owner, maxWorlds });
      void poll();
    },

    async stop(): Promise<void> {
      running = false;
      // Wait for the in-flight ticks so that shutdown does not leave a world
      // leased by a process that no longer exists.
      await Promise.allSettled([...runners.values()]);
      log({ level: 'info', event: 'scheduler_stopped', owner: options.owner });
    },

    held(): string[] {
      return [...runners.keys()].sort();
    },
  };
}

async function readTimeScale(worldId: string): Promise<number> {
  const rows = await query<{ time_scale: number }>(
    `SELECT time_scale FROM worlds WHERE world_id = $1`, [worldId],
  );
  return rows[0]?.time_scale ?? SCALE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
