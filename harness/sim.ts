/**
 * Headless simulation runner.
 *
 * This is where the town is actually tuned. Escalation balance is an empirical
 * question — does an unattended run reach war inside the canonical window? does
 * a scripted reconciliation reach peace before first blood? — and answering it
 * through the UI would be slow and unrepeatable. A run here is a seed, a tick
 * count, and an optional script of player commands, and it prints the same
 * numbers every time.
 *
 * Usage:
 *   node harness/sim.ts --ticks 360 --seed 42
 *   node harness/sim.ts --ticks 120 --commands harness/scripts/reconcile.json
 *   node harness/sim.ts --ticks 288 --json > run.json
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { closePool, query } from '../engine/db.ts';
import { getMisinformationIndex } from '../engine/beliefs.ts';
import { readBudget } from '../engine/budget.ts';
import { withClient } from '../engine/db.ts';
import { createInferenceClient } from '../engine/inference/index.ts';
import { runTick, type TickReport } from '../engine/runtick.ts';
import { fpToDisplay } from '../engine/fixedpoint.ts';
import { converse, type SpeechAct } from '../engine/converse.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO = join(here, '..', 'scenario', 'hollowmere-v1.json');

export interface ScriptedCommand {
  /** Tick at which the player says this. */
  tick: number;
  agentKey: string;
  text: string;
}

export interface SimOptions {
  ticks: number;
  seed: number;
  scenarioPath?: string;
  commands?: readonly ScriptedCommand[];
  /** Reworded retellings cost a model call each; off by default in batches. */
  allowDistortion?: boolean;
  onTick?: (report: TickReport) => void;
}

export interface SimResult {
  worldId: string;
  ticks: number;
  ending: string | null;
  endedAtTick: number | null;
  finalStage: string;
  finalTension: number;
  /** Tick at which each stage was first entered. */
  stageEntries: { stage: string; tick: number }[];
  tensionCurve: number[];
  transmissions: number;
  accusations: number;
  thinkers: number;
  firedTriggers: string[];
  conversations: { tick: number; agentKey: string; act: SpeechAct }[];
  misinformation: { falseClaimBelief: number; trueClaimBelief: number; unknownClaimBelief: number };
  budget: { inferenceCalls: number; estCostMicros: number };
  wallClockMs: number;
}

export async function simulate(options: SimOptions): Promise<SimResult> {
  const started = Date.now();
  const scenario = await loadScenarioFile(options.scenarioPath ?? DEFAULT_SCENARIO);
  const published = await publishScenario(scenario);
  const world = await instantiateWorld({
    scenarioVersionId: published.scenarioVersionId,
    seed: options.seed,
    sessionId: `sim-${options.seed}-${started}`,
  });

  const inference = createInferenceClient();
  const commandsByTick = new Map<number, ScriptedCommand[]>();
  for (const command of options.commands ?? []) {
    const list = commandsByTick.get(command.tick) ?? [];
    list.push(command);
    commandsByTick.set(command.tick, list);
  }

  const result: SimResult = {
    worldId: world.worldId,
    ticks: 0,
    ending: null,
    endedAtTick: null,
    finalStage: 'calm',
    finalTension: 0,
    stageEntries: [{ stage: 'calm', tick: 0 }],
    tensionCurve: [],
    transmissions: 0,
    accusations: 0,
    thinkers: 0,
    firedTriggers: [],
    conversations: [],
    misinformation: { falseClaimBelief: 0, trueClaimBelief: 0, unknownClaimBelief: 0 },
    budget: { inferenceCalls: 0, estCostMicros: 0 },
    wallClockMs: 0,
  };

  for (let tick = 1; tick <= options.ticks; tick++) {
    // The player speaks before the tick that follows, which is the same
    // ordering the live game has: conversation is immediate, ticks are not.
    for (const command of commandsByTick.get(tick) ?? []) {
      const outcome = await converse({
        worldId: world.worldId,
        sessionId: `sim-${options.seed}-${started}`,
        agentKey: command.agentKey,
        text: command.text,
        idempotencyKey: `sim-${tick}-${command.agentKey}`,
        inference,
      });
      result.conversations.push({ tick, agentKey: command.agentKey, act: outcome.act });
    }

    const report = await runTick({
      worldId: world.worldId,
      inference,
      allowDistortion: options.allowDistortion ?? false,
    });
    options.onTick?.(report);

    if (!report.committed) {
      if (report.skipped === 'not_active' || report.skipped === 'tick_ceiling') break;
      continue;
    }

    result.ticks = report.tick;
    result.tensionCurve.push(report.globalTension);
    result.transmissions += report.transmissions;
    result.accusations += report.accusations;
    result.thinkers += report.thinkers;
    result.firedTriggers.push(...report.firedTriggers);
    result.finalStage = report.stage;
    result.finalTension = report.globalTension;

    if (report.stage !== report.previousStage) {
      result.stageEntries.push({ stage: report.stage, tick: report.tick });
    }
    if (report.ending) {
      result.ending = report.ending;
      result.endedAtTick = report.tick;
      break;
    }
  }

  result.misinformation = await withClient((client) =>
    getMisinformationIndex(client, world.worldId));
  const budget = await withClient((client) => readBudget(client, world.worldId));
  result.budget = {
    inferenceCalls: budget.inferenceCalls,
    estCostMicros: budget.estCostMicros,
  };
  result.wallClockMs = Date.now() - started;
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const SPARK = '▁▂▃▄▅▆▇█';

/** A tension curve small enough to read in a terminal. */
export function sparkline(values: readonly number[], width = 72): string {
  if (values.length === 0) return '';
  const step = Math.max(1, Math.ceil(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) sampled.push(values[i] as number);
  return sampled
    .map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / 10_000) * SPARK.length))])
    .join('');
}

export async function printReport(result: SimResult): Promise<void> {
  const chronicle = await query<{ tick: number; description: string; kind: string }>(
    `SELECT tick, description, kind FROM world_events
      WHERE world_id = $1 AND kind IN ('escalation', 'trigger', 'accusation')
      ORDER BY tick, seq
      LIMIT 40`,
    [result.worldId],
  );

  const believed = await query<{ claim_key: string; truth: string; believers: number; avg: number }>(
    `SELECT c.claim_key, c.truth,
            count(*) FILTER (WHERE b.confidence >= 4500)::INT8 AS believers,
            COALESCE(avg(b.confidence), 0)::INT8 AS avg
       FROM world_claims c
       LEFT JOIN agent_beliefs b ON b.world_id = c.world_id AND b.claim_id = c.claim_id
      WHERE c.world_id = $1
      GROUP BY c.claim_key, c.truth
      ORDER BY believers DESC, c.claim_key
      LIMIT 8`,
    [result.worldId],
  );

  console.log(`\nHollowmere — ${result.ticks} ticks in ${(result.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`world ${result.worldId}`);
  console.log(`\ntension  ${sparkline(result.tensionCurve)}`);
  console.log(`         0 → ${result.ticks} ticks, final ${fpToDisplay(result.finalTension)}`);

  console.log('\nstages');
  for (const entry of result.stageEntries) {
    console.log(`  ${String(entry.tick).padStart(4)}  ${entry.stage}`);
  }
  console.log(
    `\nending   ${result.ending ?? 'none (still running)'}` +
      (result.endedAtTick ? ` at tick ${result.endedAtTick}` : ''),
  );

  console.log('\nactivity');
  console.log(`  transmissions  ${result.transmissions}`);
  console.log(`  accusations    ${result.accusations}`);
  console.log(`  agents thought ${result.thinkers}`);
  console.log(`  triggers       ${result.firedTriggers.join(', ') || 'none'}`);
  if (result.conversations.length > 0) {
    console.log(`  conversations  ${result.conversations
      .map((c) => `t${c.tick} ${c.agentKey}:${c.act}`).join(', ')}`);
  }

  console.log('\nwhat the town believes');
  for (const row of believed) {
    console.log(
      `  ${row.claim_key.padEnd(28)} ${String(row.believers).padStart(3)} believers  ` +
      `avg ${fpToDisplay(row.avg)}  (truth: ${row.truth})`,
    );
  }

  console.log('\nmisinformation index');
  console.log(`  belief in false claims    ${fpToDisplay(result.misinformation.falseClaimBelief)}`);
  console.log(`  belief in true claims     ${fpToDisplay(result.misinformation.trueClaimBelief)}`);
  console.log(`  belief in unknown claims  ${fpToDisplay(result.misinformation.unknownClaimBelief)}`);

  console.log('\ninference');
  console.log(`  calls ${result.budget.inferenceCalls}  est. cost ` +
    `$${(result.budget.estCostMicros / 1_000_000).toFixed(4)}`);

  console.log('\nchronicle');
  for (const row of chronicle) {
    console.log(`  ${String(row.tick).padStart(4)}  ${row.description}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const commandsPath = flag('commands', '');
  const commands = commandsPath
    ? (JSON.parse(await readFile(commandsPath, 'utf8')) as ScriptedCommand[])
    : undefined;

  const result = await simulate({
    ticks: Number(flag('ticks', '288')),
    seed: Number(flag('seed', '42')),
    scenarioPath: flag('scenario', DEFAULT_SCENARIO),
    ...(commands ? { commands } : {}),
    allowDistortion: process.argv.includes('--distort'),
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    await printReport(result);
  }
  await closePool();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  await main();
}
