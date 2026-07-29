/**
 * Movement along the location graph.
 *
 * The engine has no tiles, no collision, and no pathfinding beyond this: the
 * town is a small weighted graph of named places, and an agent crosses one edge
 * per tick toward wherever their routine says they should be. The Phaser client
 * later interpolates between the integer coordinates to make that look like
 * walking; the simulation never needs sub-tile positions, and giving it any
 * would put floating point on the rule path.
 *
 * Every move is written to world_events as well as to the agent's row, so where
 * everyone stood at tick T is reconstructable from history rather than only
 * from the current projection.
 */

import type { Client } from '../database/db.ts';
import { COGNITION, HEARING, TIME } from '../core/config.ts';
import { PHASES, type Phase } from '../../scenario/schema.ts';
import type { Seq } from '../core/seq.ts';

/** Which in-world phase a tick falls in. 24 ticks each, 96 ticks to the day. */
export function phaseForTick(tick: number): Phase {
  const index = Math.floor(tick / TIME.ticksPerPhase) % PHASES.length;
  return PHASES[index] as Phase;
}

/** Which in-world day a tick falls in. */
export function dayForTick(tick: number): number {
  return Math.floor(tick / (TIME.ticksPerPhase * PHASES.length));
}

export interface RouteGraph {
  /** location_id -> [{ to, cost }], ordered by location_id. */
  edges: ReadonlyMap<string, readonly { to: string; cost: number }[]>;
  keyById: ReadonlyMap<string, string>;
  idByKey: ReadonlyMap<string, string>;
}

/**
 * Load the whole map once per tick. It is eleven places and a couple of dozen
 * edges, so it is cheaper to hold it in memory for the tick than to ask the
 * database for a path forty times.
 */
export async function loadRouteGraph(client: Client, worldId: string): Promise<RouteGraph> {
  const result = await client.query<{
    from_location_id: string; to_location_id: string; cost: number;
  }>(
    `SELECT from_location_id, to_location_id, cost FROM world_routes
      WHERE world_id = $1 ORDER BY from_location_id, to_location_id`,
    [worldId],
  );

  const locations = await client.query<{ location_id: string; location_key: string }>(
    `SELECT location_id, location_key FROM world_locations WHERE world_id = $1
      ORDER BY location_key`,
    [worldId],
  );

  const keyById = new Map(locations.rows.map((r) => [r.location_id, r.location_key]));

  const edges = new Map<string, { to: string; cost: number }[]>();
  for (const row of result.rows) {
    const list = edges.get(row.from_location_id) ?? [];
    list.push({ to: row.to_location_id, cost: row.cost });
    edges.set(row.from_location_id, list);
  }

  // Adjacency is ordered by location *key*, not by id.
  //
  // This list is handed to cognition as the allowlist of places an agent may
  // decide to go, and the planner picks from it by index. Location ids are
  // random UUIDs, so leaving the database's ordering in place makes two worlds
  // built from the same seed send the same agent to different places — and from
  // there into different rooms, different conversations, and a different town.
  for (const list of edges.values()) {
    list.sort((a, b) => compareKeys(keyById, a.to, b.to));
  }

  return {
    edges,
    keyById,
    idByKey: new Map(locations.rows.map((r) => [r.location_key, r.location_id])),
  };
}

function compareKeys(keyById: ReadonlyMap<string, string>, a: string, b: string): number {
  const left = keyById.get(a) ?? a;
  const right = keyById.get(b) ?? b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The first step of a cheapest path from `from` to `to`, or null if there is no
 * path or the agent is already there.
 *
 * Dijkstra rather than breadth-first, because routes carry a cost and a route
 * table that says the long way round is cheaper should be believed. Ties break
 * on location *key* so that two equally short paths always resolve the same way
 * in every world — a coin flip here would put a different agent in a different
 * room, and from there into a different conversation.
 */
export function nextHop(graph: RouteGraph, from: string, to: string): string | null {
  if (from === to) return null;

  const distance = new Map<string, number>([[from, 0]]);
  const firstStep = new Map<string, string>();
  const settled = new Set<string>();

  for (;;) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    const ordered = [...distance.entries()]
      .sort(([a], [b]) => compareKeys(graph.keyById, a, b));
    for (const [node, dist] of ordered) {
      if (settled.has(node)) continue;
      if (dist < best) {
        best = dist;
        current = node;
      }
    }
    if (current === null) return null;
    if (current === to) return firstStep.get(to) ?? null;

    settled.add(current);
    for (const edge of graph.edges.get(current) ?? []) {
      const candidate = best + edge.cost;
      const known = distance.get(edge.to);
      if (known !== undefined && known <= candidate) continue;
      distance.set(edge.to, candidate);
      firstStep.set(edge.to, current === from ? edge.to : firstStep.get(current) as string);
    }
  }
}

export interface Movement {
  agentKey: string;
  fromLocationId: string;
  toLocationId: string;
}

export interface MovementContext {
  worldId: string;
  tick: number;
  seq: Seq;
  phase: Phase;
  graph: RouteGraph;
}

interface AgentRow {
  agent_id: string;
  agent_key: string;
  location_id: string;
  routine: Record<string, string>;
  current_plan: { targetLocationKey?: string | null } | null;
  updated_tick: number;
  commitment_location_id: string | null;
}

/**
 * Advance every ambient agent one segment toward their scheduled location.
 *
 * Ordered by agent_key rather than agent_id: ids are random UUIDs and would
 * order differently in two worlds built from the same scenario and seed, while
 * the key is scenario content and orders identically everywhere. Two agents
 * arriving at the tavern in a different order are handed to gossip in a
 * different order, and gossip consumes the seeded generator in iteration order.
 */
export async function runMovement(
  client: Client,
  ctx: MovementContext,
): Promise<Movement[]> {
  const agents = await client.query<AgentRow>(
    `SELECT a.agent_id, a.agent_key, a.location_id, a.routine, a.current_plan, a.updated_tick,
            (SELECT c.location_id FROM world_agent_commitments c
              WHERE c.world_id = a.world_id AND c.agent_id = a.agent_id
                AND c.status = 'pending' AND c.response != 'decline'
                AND $2 <= c.due_tick + $3
              ORDER BY c.due_tick, c.hearing_id LIMIT 1) AS commitment_location_id
       FROM world_agents a
      WHERE a.world_id = $1 AND a.status IN ('alive', 'injured')
      ORDER BY agent_key`,
    [ctx.worldId, ctx.tick, HEARING.holdTicks],
  );

  const moved: Movement[] = [];
  for (const agent of agents.rows) {
    // An agent who has thought recently walks toward what they decided to do;
    // everyone else follows the day's routine. This is the only way cognition
    // shows up in the town's movement, and it is why a plan is worth storing.
    // A plan goes stale deliberately: without the horizon, one decision made at
    // dawn would keep an agent away from their work for the rest of the world.
    const planFresh = ctx.tick - agent.updated_tick <= COGNITION.planHorizonTicks;
    const commitmentKey = agent.commitment_location_id
      ? ctx.graph.keyById.get(agent.commitment_location_id)
      : null;
    const targetKey = commitmentKey ??
      (planFresh ? agent.current_plan?.targetLocationKey : null) ?? agent.routine[ctx.phase];
    const targetId = targetKey ? ctx.graph.idByKey.get(targetKey) : undefined;
    if (!targetId) continue;

    const step = nextHop(ctx.graph, agent.location_id, targetId);
    if (!step) continue;

    await client.query(
      `UPDATE world_agents SET location_id = $3, updated_tick = $4
        WHERE world_id = $1 AND agent_id = $2`,
      [ctx.worldId, agent.agent_id, step, ctx.tick],
    );

    await client.query(
      `INSERT INTO world_events
         (world_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
       VALUES ($1, $2, $3, $4, $5, 'movement', $6, $7)`,
      [
        ctx.worldId, ctx.tick, ctx.seq.next(), step, agent.agent_id,
        JSON.stringify({ from: agent.location_id, to: step, phase: ctx.phase }),
        `${agent.agent_key} moves on.`,
      ],
    );

    moved.push({
      agentKey: agent.agent_key,
      fromLocationId: agent.location_id,
      toLocationId: step,
    });
  }

  return moved;
}
