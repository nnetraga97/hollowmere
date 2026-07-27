/**
 * Scheduler entrypoint — the ECS service that advances worlds.
 *
 * Deployed as a separate task from the web service. Player writes and scheduler
 * writes therefore contend across processes on the same rows, which is the
 * contention the isolation story rests on. Running the loop inside the web
 * service would make that contention intra-process and unrepresentative.
 */

import { hostname } from 'node:os';

import { closePool } from '../engine/db.ts';
import { createInferenceClient } from '../engine/inference/index.ts';
import { errorLogFields, logError, logInfo } from '../engine/log.ts';
import { createScheduler } from './loop.ts';

process.env.SERVICE_NAME ??= 'hollowmere-scheduler';

const owner = process.env.SCHEDULER_OWNER ?? `${hostname()}:${process.pid}`;

const scheduler = createScheduler({
  inference: createInferenceClient(),
  owner,
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 5_000),
  maxWorlds: Number(process.env.SCHEDULER_MAX_WORLDS ?? 25),
});

scheduler.start();
logInfo('scheduler_process_ready', { owner, pid: process.pid });

/**
 * Shut down cleanly on the signals a container orchestrator actually sends.
 * Draining matters: an abrupt exit leaves worlds leased to a process that is
 * gone, and they sit idle until the lease expires.
 */
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logInfo('shutdown_started', { signal, owner });
    void scheduler.stop().then(closePool).then(() => {
      logInfo('shutdown_completed', { signal, owner });
      process.exit(0);
    }).catch((error) => {
      logError('shutdown_failed', { signal, owner, ...errorLogFields(error) });
      process.exit(1);
    });
  });
}

process.on('unhandledRejection', (error) => {
  logError('unhandled_rejection', errorLogFields(error));
});

process.on('uncaughtException', (error) => {
  logError('uncaught_exception', errorLogFields(error));
  process.exit(1);
});
