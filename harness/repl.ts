/**
 * Interactive REPL.
 *
 * The headless runner answers "what happens over three hundred ticks"; this
 * answers "what is going on right now, and what happens if I say this". It is
 * the tool for actually feeling whether the town reacts the way it should,
 * which no aggregate report can tell you.
 *
 *   node harness/repl.ts                 start a new world
 *   node harness/repl.ts --world <uuid>  attach to an existing one
 *
 * Commands:
 *   tick [n]                 advance n ticks (default 1)
 *   talk <agent> <words>     say something to someone
 *   where [agent]            who is where
 *   belief <agent> [claim]   what someone believes, and how it moved
 *   claims                   every claim, believers against ground truth
 *   graph                    the sharpest relationships in town
 *   chronicle [n]            the last n things that happened
 *   state                    tension, stage, factions, budget
 *   help / quit
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { closePool } from '../engine/db.ts';
import {
  getBeliefHistory, getChronicle, getClaims, getCognition, getFactions,
  getSocialGraph, getWorldSummary, listAgents,
} from '../engine/api.ts';
import { fpToDisplay } from '../engine/fixedpoint.ts';
import { createInferenceClient } from '../engine/inference/index.ts';
import { runTick } from '../engine/runtick.ts';
import { converse } from '../engine/converse.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, '..', 'scenario', 'hollowmere-v2.json');

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const inference = createInferenceClient();
  const sessionId = flag('session') ?? `repl-${Date.now()}`;

  let worldId = flag('world');
  if (!worldId) {
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const published = await publishScenario(scenario);
    const world = await instantiateWorld({
      scenarioVersionId: published.scenarioVersionId,
      seed: Number(flag('seed') ?? 42),
      sessionId,
    });
    worldId = world.worldId;
    console.log(`new world ${worldId} (${world.agentCount} agents)`);
  } else {
    console.log(`attached to ${worldId}`);
  }

  let commandCount = 0;
  console.log('type "help" for commands, "quit" to leave\n');

  /** The prompt doubles as a status line: tick, stage, and current tension. */
  const showPrompt = async (): Promise<void> => {
    const summary = await getWorldSummary(worldId);
    stdout.write(summary
      ? `[t${summary.currentTick} ${summary.stage} ${fpToDisplay(summary.globalTension)}] > `
      : '> ');
  };
  await showPrompt();

  // Two things here are load-bearing for driving the REPL from a pipe, which is
  // how a scripted run is rehearsed:
  //
  //   - Plain readline, not the promises flavour: `question` resolves exactly
  //     once against a pipe and then hangs forever.
  //   - Nothing may be awaited between creating the interface and iterating it.
  //     readline starts consuming stdin immediately, and any line that arrives
  //     before the iterator attaches is dropped — so a whole script vanishes
  //     into a single await. Hence the first prompt is printed above.
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      await showPrompt();
      continue;
    }

    const summary = await getWorldSummary(worldId);
    const [command, ...rest] = line.split(/\s+/);
    const argument = rest.join(' ');

    try {
      switch (command) {
        case 'quit':
        case 'exit':
          rl.close();
          await closePool();
          return;


        case 'help':
          console.log(HELP);
          break;

        case 'tick': {
          const count = Number(rest[0] ?? 1);
          for (let i = 0; i < count; i++) {
            const report = await runTick({ worldId, inference, allowDistortion: false });
            const marks = [
              report.transmissions > 0 ? `${report.transmissions} told` : '',
              report.accusations > 0 ? `${report.accusations} accused` : '',
              report.thinkers > 0 ? `${report.thinkers} thought` : '',
              report.firedTriggers.length > 0 ? `!${report.firedTriggers.join(',')}` : '',
              report.stage !== report.previousStage ? `→ ${report.stage.toUpperCase()}` : '',
            ].filter(Boolean).join('  ');
            console.log(
              `  t${String(report.tick).padStart(3)}  ` +
              `${fpToDisplay(report.globalTension)}  ${marks}`,
            );
            if (report.ending) {
              console.log(`\n  *** the world ends: ${report.ending} ***\n`);
              break;
            }
            if (!report.committed) {
              console.log(`  (nothing to do: ${report.skipped})`);
              break;
            }
          }
          break;
        }

        case 'talk': {
          const agentKey = rest[0];
          const text = rest.slice(1).join(' ');
          if (!agentKey || !text) {
            console.log('  usage: talk <agent_key> <what you say>');
            break;
          }
          stdout.write('  ');
          const result = await converse({
            worldId, sessionId, agentKey, text,
            idempotencyKey: `repl-${++commandCount}`,
            inference,
            onToken: (token) => stdout.write(token),
          });
          console.log(`\n  [${result.act}${result.claimKey ? ` · ${result.claimKey}` : ''}` +
            `${result.effects.negotiationOpened ? ' · negotiation opened' : ''}` +
            `${result.effects.rumorSeeded ? ' · rumour seeded' : ''}]`);
          if (result.effects.beliefAfter !== null) {
            console.log(`  belief ${fpToDisplay(result.effects.beliefBefore ?? 0)} ` +
              `→ ${fpToDisplay(result.effects.beliefAfter)}`);
          }
          break;
        }

        case 'where': {
          const agents = await listAgents(worldId);
          const filtered = argument
            ? agents.filter((a) => a.agentKey.includes(argument))
            : agents;
          const byLocation = new Map<string, string[]>();
          for (const agent of filtered) {
            const list = byLocation.get(agent.locationKey) ?? [];
            list.push(agent.status === 'alive' ? agent.agentKey : `${agent.agentKey}(${agent.status})`);
            byLocation.set(agent.locationKey, list);
          }
          for (const [location, keys] of [...byLocation].sort()) {
            console.log(`  ${location.padEnd(16)} ${keys.join(', ')}`);
          }
          break;
        }

        case 'belief': {
          const agentKey = rest[0];
          if (!agentKey) {
            console.log('  usage: belief <agent_key> [claim_key]');
            break;
          }
          const claims = await getClaims(worldId);
          const claimKeys = rest[1] ? [rest[1]] : claims.map((c) => c.claimKey);
          for (const claimKey of claimKeys) {
            const history = await getBeliefHistory(worldId, agentKey, claimKey);
            if (history.length === 0) continue;
            const last = history[history.length - 1]!;
            const path = history.map((p) => `t${p.tick}:${fpToDisplay(p.confidence, 1)}`).join(' ');
            console.log(`  ${claimKey.padEnd(28)} now ${fpToDisplay(last.confidence)}`);
            console.log(`    ${path}`);
          }
          break;
        }

        case 'claims': {
          const claims = await getClaims(worldId);
          console.log('  claim                          truth    heat  reached  believe  deny');
          for (const claim of claims) {
            console.log(
              `  ${claim.claimKey.padEnd(28)} ${claim.truth.padEnd(8)} ` +
              `${fpToDisplay(claim.heat, 1).padStart(4)} ` +
              `${String(claim.reached).padStart(7)} ` +
              `${String(claim.believers).padStart(8)} ` +
              `${String(claim.deniers).padStart(5)}`,
            );
          }
          break;
        }

        case 'graph': {
          const graph = await getSocialGraph(worldId);
          console.log(`  ${graph.nodes.length} people, ${graph.edges.length} charged relationships`);
          for (const edge of graph.edges.slice(0, 20)) {
            const arrow = edge.sentiment < 0 ? '--x' : '-->';
            console.log(
              `  ${edge.src.padEnd(20)} ${arrow} ${edge.dst.padEnd(20)} ` +
              `sentiment ${fpToDisplay(edge.sentiment)}  trust ${fpToDisplay(edge.trust)}`,
            );
          }
          break;
        }

        case 'chronicle': {
          const entries = await getChronicle(worldId, { limit: Number(rest[0] ?? 20) });
          for (const entry of [...entries].reverse()) {
            console.log(`  t${String(entry.tick).padStart(3)} ${entry.kind.padEnd(15)} ${entry.description}`);
          }
          break;
        }

        case 'think': {
          const records = await getCognition(worldId, Number(rest[0] ?? 10));
          for (const record of records) {
            console.log(`  t${String(record.tick).padStart(3)} ${record.agentKey.padEnd(20)} ` +
              `${record.modelId}  ${JSON.stringify(record.decision.intention ?? '')}`);
          }
          break;
        }

        case 'state': {
          if (!summary) { console.log('  world is gone'); break; }
          console.log(`  tick ${summary.currentTick}  day ${summary.day} ${summary.phase}`);
          console.log(`  stage ${summary.stage}  tension ${fpToDisplay(summary.globalTension)}` +
            `  peace streak ${summary.peaceStreak}`);
          console.log(`  status ${summary.status}${summary.ending ? ` (${summary.ending})` : ''}` +
            `  ${summary.agentsAlive} alive`);
          console.log(`  inference ${summary.inferenceCalls} calls, ` +
            `$${(summary.estCostMicros / 1_000_000).toFixed(4)}`);
          for (const faction of await getFactions(worldId)) {
            console.log(
              `  ${faction.factionKey.padEnd(12)} tension ${fpToDisplay(faction.tension)}  ` +
              `${faction.belligerent ? 'belligerent' : 'unaligned  '}  ` +
              `${faction.willingToNegotiate ? 'will negotiate' : ''}`,
            );
          }
          break;
        }

        default:
          console.log(`  unknown command "${command}" — try "help"`);
      }
    } catch (error) {
      console.log(`  error: ${error instanceof Error ? error.message : String(error)}`);
    }

    await showPrompt();
  }

  rl.close();
  await closePool();
}

const HELP = `
  tick [n]                 advance n ticks
  talk <agent> <words>     say something to someone
  where [filter]           who is where
  belief <agent> [claim]   what someone believes, tick by tick
  claims                   every claim: believers against ground truth
  graph                    the sharpest relationships in town
  chronicle [n]            the last n things that happened
  think [n]                what the spotlit agents decided
  state                    tension, stage, factions, budget
  quit
`;

await main();
