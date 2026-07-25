/**
 * Instantiate a private world from a published scenario version.
 *
 * Scenario templates are shared and immutable; everything a world can change
 * is copied into world-scoped rows here. That copy is what lets every
 * downstream foreign key be composite, which is what makes a cross-world
 * reference impossible to express rather than merely discouraged.
 */

import { createHash } from 'node:crypto';

import { withSerializable, type Client } from '../engine/db.ts';
import { pickRumorOriginator, seedRumor } from '../engine/gossip.ts';
import { createSeq } from '../engine/seq.ts';
import type { OpeningEventDef } from './schema.ts';

/** Starting sentiment and trust, by relationship of the two agents' factions. */
const INITIAL_SAME_FACTION = { sentiment: 3_000, trust: 6_500 };
const INITIAL_RIVAL_FACTION = { sentiment: -2_000, trust: 3_000 };
const INITIAL_NEUTRAL = { sentiment: 0, trust: 5_000 };

export interface InstantiateOptions {
  scenarioVersionId: string;
  seed: number;
  sessionId: string;
  playerName?: string;
  playerProfile?: {
    background: string;
    sympathyFactionKey: string | null;
  };
  /** Where the player starts. Defaults to the opening event's location. */
  playerLocationKey?: string;
}

export interface InstantiateResult {
  worldId: string;
  playerId: string;
  agentCount: number;
}

export async function instantiateWorld(
  options: InstantiateOptions,
): Promise<InstantiateResult> {
  const { value } = await withSerializable<InstantiateResult>(async (client) => {
    const scenario = await loadScenarioRows(client, options.scenarioVersionId);

    const world = await client.query<{ world_id: string }>(
      `INSERT INTO worlds (scenario_version_id, seed) VALUES ($1, $2) RETURNING world_id`,
      [options.scenarioVersionId, options.seed],
    );
    const worldId = world.rows[0]!.world_id;

    const factionIds = await insertFactions(client, worldId, scenario.factions);
    const locationIds = await insertLocations(
      client, worldId, scenario.districts, scenario.locations, factionIds,
    );
    await insertRoutes(client, worldId, scenario.routes, locationIds);
    const agentIds = await insertAgents(client, worldId, scenario.agents, factionIds, locationIds);
    await linkFactionLeaders(client, worldId, scenario.factions, agentIds);
    await insertRelationships(client, worldId, scenario.agents, agentIds);
    const claimIds = await insertClaims(client, worldId, scenario.claims, agentIds);

    const culprit = selectCulprit(options.seed, options.scenarioVersionId, scenario.culprits);
    if (culprit) {
      await insertCulpritState(client, {
        worldId,
        culprit,
        agentIds,
        claimIds,
        goals: scenario.goals,
      });
    } else {
      await insertGoals(client, worldId, scenario.goals, agentIds, null);
    }

    await insertInitialState(client, worldId, scenario.factions, factionIds);
    const playerId = await insertPlayer(
      client, worldId, options.sessionId,
      locationIds.get(options.playerLocationKey ?? scenario.opening.location)!,
      scenario.factions, factionIds, options.playerName, options.playerProfile,
    );
    await insertPlayerAgentRelationships(client, worldId, playerId);
    await insertReflectionState(client, worldId);

    await applyOpening(client, worldId, scenario.opening, locationIds, claimIds);

    return { worldId, playerId, agentCount: scenario.agents.length };
  }, { label: 'instantiateWorld' });

  return value;
}

async function insertPlayerAgentRelationships(
  client: Client,
  worldId: string,
  playerId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO player_agent_relationships (world_id, player_id, agent_id)
     SELECT $1, $2, agent_id FROM world_agents WHERE world_id = $1
     ON CONFLICT (world_id, player_id, agent_id) DO NOTHING`,
    [worldId, playerId],
  );
}

async function insertReflectionState(client: Client, worldId: string): Promise<void> {
  await client.query(
    `INSERT INTO world_agent_reflection_state (world_id, agent_id)
     SELECT $1, agent_id FROM world_agents WHERE world_id = $1
     ON CONFLICT (world_id, agent_id) DO NOTHING`,
    [worldId],
  );
}

// ---------------------------------------------------------------------------

interface FactionRow { faction_key: string; name: string; ideology: string;
  leader_agent_key: string; belligerent: boolean }
interface DistrictRow { district_key: string; controlling_faction_key: string | null }
interface LocationRow { location_key: string; district_key: string; name: string;
  x: number; y: number; gossip_bonus: number }
interface RouteRow { from_location_key: string; to_location_key: string; cost: number }
interface AgentRow { agent_key: string; name: string; faction_key: string;
  home_location_key: string; work_location_key: string;
  persona: { status?: string; traits?: string[] };
  routine: unknown; credulity: number; talkativeness: number }
interface ClaimRow { claim_key: string; text: string; subject_agent_key: string;
  truth: string; severity: number }
interface CulpritRow { culprit_key: string; motive_key: string; profit_claim_key: string;
  record_claim_key: string; claim_truth: Record<string, 'true' | 'false' | 'unknown'> }
interface GoalRow { agent_key: string; goal_key: string; priority: number }

async function loadScenarioRows(client: Client, scenarioVersionId: string) {
  const version = await client.query<{ opening: OpeningEventDef }>(
    `SELECT opening FROM scenario_versions WHERE scenario_version_id = $1`,
    [scenarioVersionId],
  );
  if (!version.rows[0]) {
    throw new Error(`unknown scenario version ${scenarioVersionId}`);
  }

  // Every read is explicitly ordered. Instantiation order determines the order
  // rows are created in, and the determinism contract requires that be stable.
  //
  // These run sequentially rather than via Promise.all: a single pg client
  // cannot execute concurrent queries, and issuing them in parallel only
  // queues them anyway while triggering a deprecation warning.
  const factions = await client.query<FactionRow>(
    `SELECT faction_key, name, ideology, leader_agent_key, belligerent
       FROM faction_templates WHERE scenario_version_id = $1 ORDER BY faction_key`,
    [scenarioVersionId]);
  const districts = await client.query<DistrictRow>(
    `SELECT district_key, controlling_faction_key
       FROM district_templates WHERE scenario_version_id = $1 ORDER BY district_key`,
    [scenarioVersionId]);
  const locations = await client.query<LocationRow>(
    `SELECT location_key, district_key, name, x, y, gossip_bonus
       FROM location_templates WHERE scenario_version_id = $1 ORDER BY location_key`,
    [scenarioVersionId]);
  const routes = await client.query<RouteRow>(
    `SELECT from_location_key, to_location_key, cost
       FROM route_templates WHERE scenario_version_id = $1
      ORDER BY from_location_key, to_location_key`,
    [scenarioVersionId]);
  const agents = await client.query<AgentRow>(
    `SELECT agent_key, name, faction_key, home_location_key, work_location_key,
            persona, routine, credulity, talkativeness
       FROM agent_templates WHERE scenario_version_id = $1 ORDER BY agent_key`,
    [scenarioVersionId]);
  const claims = await client.query<ClaimRow>(
    `SELECT claim_key, text, subject_agent_key, truth, severity
       FROM claim_templates WHERE scenario_version_id = $1 ORDER BY claim_key`,
    [scenarioVersionId]);
  const culprits = await client.query<CulpritRow>(
    `SELECT culprit_key, motive_key, profit_claim_key, record_claim_key, claim_truth
       FROM culprit_templates WHERE scenario_version_id = $1 ORDER BY culprit_key`,
    [scenarioVersionId]);
  const goals = await client.query<GoalRow>(
    `SELECT agent_key, goal_key, priority FROM agent_goal_templates
      WHERE scenario_version_id = $1 ORDER BY agent_key, priority DESC, goal_key`,
    [scenarioVersionId]);

  return {
    opening: version.rows[0].opening,
    factions: factions.rows,
    districts: districts.rows,
    locations: locations.rows,
    routes: routes.rows,
    agents: agents.rows,
    claims: claims.rows,
    culprits: culprits.rows,
    goals: goals.rows,
  };
}

async function insertFactions(
  client: Client, worldId: string, factions: readonly FactionRow[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const f of factions) {
    const row = await client.query<{ faction_id: string }>(
      `INSERT INTO world_factions (world_id, faction_key, name, ideology, belligerent)
       VALUES ($1, $2, $3, $4, $5) RETURNING faction_id`,
      [worldId, f.faction_key, f.name, f.ideology, f.belligerent],
    );
    ids.set(f.faction_key, row.rows[0]!.faction_id);
  }
  return ids;
}

async function insertLocations(
  client: Client, worldId: string,
  districts: readonly DistrictRow[], locations: readonly LocationRow[],
  factionIds: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const controllerByDistrict = new Map(
    districts.map((d) => [d.district_key, d.controlling_faction_key]),
  );
  const ids = new Map<string, string>();
  for (const l of locations) {
    const controllerKey = controllerByDistrict.get(l.district_key) ?? null;
    const row = await client.query<{ location_id: string }>(
      `INSERT INTO world_locations
         (world_id, location_key, district_key, name, x, y, gossip_bonus, controlling_faction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING location_id`,
      [worldId, l.location_key, l.district_key, l.name, l.x, l.y, l.gossip_bonus,
       controllerKey ? factionIds.get(controllerKey) ?? null : null],
    );
    ids.set(l.location_key, row.rows[0]!.location_id);
  }
  return ids;
}

async function insertRoutes(
  client: Client, worldId: string, routes: readonly RouteRow[],
  locationIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const r of routes) {
    await client.query(
      `INSERT INTO world_routes (world_id, from_location_id, to_location_id, cost)
       VALUES ($1, $2, $3, $4)`,
      [worldId, locationIds.get(r.from_location_key), locationIds.get(r.to_location_key), r.cost],
    );
  }
}

async function insertAgents(
  client: Client, worldId: string, agents: readonly AgentRow[],
  factionIds: ReadonlyMap<string, string>, locationIds: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const a of agents) {
    const persona = a.persona;
    const personality = personalityFrom(a);
    const row = await client.query<{ agent_id: string }>(
      `INSERT INTO world_agents
         (world_id, agent_key, name, faction_id, home_location_id, work_location_id,
          location_id, persona, routine, credulity, talkativeness, kindness,
          engagement, honesty, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING agent_id`,
      [
        worldId, a.agent_key, a.name,
        factionIds.get(a.faction_key),
        locationIds.get(a.home_location_key),
        locationIds.get(a.work_location_key),
        // Everyone starts at home; the first tick moves them into the routine.
        locationIds.get(a.home_location_key),
        JSON.stringify(a.persona), JSON.stringify(a.routine),
        a.credulity, a.talkativeness, personality.kindness,
        personality.engagement, personality.honesty,
        persona.status ?? 'alive',
      ],
    );
    ids.set(a.agent_key, row.rows[0]!.agent_id);
  }
  return ids;
}

function personalityFrom(agent: AgentRow): {
  kindness: number; engagement: number; honesty: number;
} {
  const traits = new Set((agent.persona.traits ?? []).map((trait) => trait.toLowerCase()));
  const score = (positive: readonly string[], negative: readonly string[]) => {
    const up = positive.some((word) => [...traits].some((trait) => trait.includes(word)));
    const down = negative.some((word) => [...traits].some((trait) => trait.includes(word)));
    return up === down ? 5000 : up ? 7000 : 3000;
  };
  return {
    kindness: score(
      ['motherly', 'cheerful', 'devout', 'careful', 'kind'],
      ['bitter', 'imperious', 'calculating', 'hot-tempered', 'unforgiving'],
    ),
    engagement: agent.talkativeness,
    honesty: score(
      ['credible', 'blunt', 'practical', 'meticulous', 'careful'],
      ['secretive', 'evasive', 'compromised', 'calculating'],
    ),
  };
}

async function linkFactionLeaders(
  client: Client, worldId: string, factions: readonly FactionRow[],
  agentIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const f of factions) {
    await client.query(
      `UPDATE world_factions SET leader_agent_id = $3
        WHERE world_id = $1 AND faction_key = $2`,
      [worldId, f.faction_key, agentIds.get(f.leader_agent_key)],
    );
  }
}

/**
 * Seed the social graph. Every ordered pair gets an edge, because gossip
 * weighting needs a defined relationship for any two agents who might meet,
 * and a missing edge would silently read as neutral.
 */
async function insertRelationships(
  client: Client, worldId: string, agents: readonly AgentRow[],
  agentIds: ReadonlyMap<string, string>,
): Promise<void> {
  const factionOf = new Map(agents.map((a) => [a.agent_key, a.faction_key]));

  type Edge = [src: string, dst: string, sentiment: number, trust: number];
  const edges: Edge[] = [];

  for (const src of agents) {
    for (const dst of agents) {
      if (src.agent_key === dst.agent_key) continue;
      const srcFaction = factionOf.get(src.agent_key);
      const dstFaction = factionOf.get(dst.agent_key);
      const initial =
        srcFaction === dstFaction
          ? INITIAL_SAME_FACTION
          : srcFaction === 'unaligned' || dstFaction === 'unaligned'
            ? INITIAL_NEUTRAL
            : INITIAL_RIVAL_FACTION;

      edges.push([
        agentIds.get(src.agent_key)!,
        agentIds.get(dst.agent_key)!,
        initial.sentiment,
        initial.trust,
      ]);
    }
  }

  // 870 edges for thirty agents. Chunked to stay well inside CockroachDB's
  // per-statement parameter limit.
  const CHUNK = 200;
  for (let start = 0; start < edges.length; start += CHUNK) {
    const chunk = edges.slice(start, start + CHUNK);
    const params: unknown[] = [worldId];
    const tuples = chunk.map((edge) => {
      params.push(...edge);
      const base = params.length - 4;
      return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    await client.query(
      `INSERT INTO world_relationships (world_id, src_agent_id, dst_agent_id, sentiment, trust)
       VALUES ${tuples.join(', ')}`,
      params,
    );
  }
}

async function insertClaims(
  client: Client, worldId: string, claims: readonly ClaimRow[],
  agentIds: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const c of claims) {
    const row = await client.query<{ claim_id: string }>(
      `INSERT INTO world_claims
         (world_id, claim_key, text, subject_agent_id, truth, severity, authored)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING claim_id`,
      [worldId, c.claim_key, c.text, agentIds.get(c.subject_agent_key), c.truth, c.severity],
    );
    ids.set(c.claim_key, row.rows[0]!.claim_id);
  }
  return ids;
}

/** Culprit selection is derived, so it never consumes the simulation RNG stream. */
export function selectCulprit(
  seed: number,
  scenarioVersionId: string,
  candidates: readonly CulpritRow[],
): CulpritRow | null {
  const ordered = [...candidates].sort((a, b) => a.culprit_key.localeCompare(b.culprit_key));
  if (ordered.length === 0) return null;
  const digest = createHash('sha256').update(`${seed}:${scenarioVersionId}`).digest();
  const index = digest.readUInt32BE(0) % ordered.length;
  return ordered[index] as CulpritRow;
}

async function insertCulpritState(
  client: Client,
  input: {
    worldId: string;
    culprit: CulpritRow;
    agentIds: ReadonlyMap<string, string>;
    claimIds: Map<string, string>;
    goals: readonly GoalRow[];
  },
): Promise<void> {
  const culpritId = input.agentIds.get(input.culprit.culprit_key);
  if (!culpritId) throw new Error(`culprit agent missing: ${input.culprit.culprit_key}`);

  await client.query(
    `INSERT INTO world_culprit (world_id, agent_id, motive_key) VALUES ($1, $2, $3)`,
    [input.worldId, culpritId, input.culprit.motive_key],
  );

  for (const [claimKey, truth] of Object.entries(input.culprit.claim_truth ?? {})) {
    await client.query(
      `UPDATE world_claims SET truth = $3 WHERE world_id = $1 AND claim_key = $2`,
      [input.worldId, claimKey, truth],
    );
  }

  const exposed = await client.query<{ claim_id: string }>(
    `INSERT INTO world_claims
       (world_id, claim_key, text, subject_agent_id, truth, severity, authored, locked)
     VALUES ($1, 'instigator_exposed', $2, $3, 'true', 10000, true, true)
     RETURNING claim_id`,
    [input.worldId, `${input.culprit.culprit_key.replace(/_/g, ' ')} engineered the feud and killed the prince.`, culpritId],
  );
  input.claimIds.set('instigator_exposed', exposed.rows[0]!.claim_id);

  await insertGoals(client, input.worldId, input.goals, input.agentIds, input.culprit.culprit_key);
  await client.query(
    `INSERT INTO world_scheme_state (world_id, agent_id) VALUES ($1, $2)`,
    [input.worldId, culpritId],
  );
}

async function insertGoals(
  client: Client,
  worldId: string,
  goals: readonly GoalRow[],
  agentIds: ReadonlyMap<string, string>,
  culpritKey: string | null,
): Promise<void> {
  for (const goal of goals) {
    if (goal.goal_key === 'provoke_war' && goal.agent_key !== culpritKey) continue;
    const agentId = agentIds.get(goal.agent_key);
    if (!agentId) continue;
    await client.query(
      `INSERT INTO world_agent_goals (world_id, agent_id, goal_key, priority, status, updated_tick)
       VALUES ($1, $2, $3, $4, 'active', 0)`,
      [worldId, agentId, goal.goal_key, goal.priority],
    );
  }
}

async function insertInitialState(
  client: Client, worldId: string, factions: readonly FactionRow[],
  factionIds: ReadonlyMap<string, string>,
): Promise<void> {
  await client.query(`INSERT INTO world_state (world_id) VALUES ($1)`, [worldId]);
  await client.query(`INSERT INTO world_budget (world_id) VALUES ($1)`, [worldId]);
  await client.query(
    `INSERT INTO world_state_history (world_id, tick, global_tension, escalation_stage)
     VALUES ($1, 0, 0, 'calm')`,
    [worldId],
  );
  for (const f of factions) {
    await client.query(
      `INSERT INTO world_faction_state (world_id, faction_id) VALUES ($1, $2)`,
      [worldId, factionIds.get(f.faction_key)],
    );
  }
}

async function insertPlayer(
  client: Client, worldId: string, sessionId: string, locationId: string,
  factions: readonly FactionRow[], factionIds: ReadonlyMap<string, string>,
  playerName = 'the outsider',
  playerProfile: InstantiateOptions['playerProfile'] = { background: '', sympathyFactionKey: null },
): Promise<string> {
  const row = await client.query<{ player_id: string }>(
    `INSERT INTO world_players (world_id, session_id, name, profile, location_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING player_id`,
    [worldId, sessionId, playerName, JSON.stringify(playerProfile), locationId],
  );
  const playerId = row.rows[0]!.player_id;

  // The outsider starts unknown to everyone, not merely neutral.
  for (const f of factions) {
    await client.query(
      `INSERT INTO player_reputation (world_id, player_id, faction_id, reputation)
       VALUES ($1, $2, $3, $4)`,
      [
        worldId, playerId, factionIds.get(f.faction_key),
        playerProfile.sympathyFactionKey === f.faction_key ? 750 : 0,
      ],
    );
  }
  return playerId;
}

/**
 * Apply the inciting event: one world event at tick 0, plus the rumors the
 * town already carries when the player arrives.
 *
 * Each opening rumor is put into somebody's mouth. A rumor with no holder
 * cannot spread — gossip walks outward from whoever already has it — so a
 * seeded rumor without an originator would sit in the table looking correct
 * while the town stayed silent. The first tellers are the talkative, taken one
 * further down the list for each successive rumor so the three opening stories
 * start in three different corners of town rather than all in one mouth.
 */
async function applyOpening(
  client: Client, worldId: string, opening: OpeningEventDef,
  locationIds: ReadonlyMap<string, string>, claimIds: ReadonlyMap<string, string>,
): Promise<void> {
  const event = await client.query<{ event_id: string }>(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, kind, payload, description)
     VALUES ($1, 0, 0, $2, 'escalation', '{"opening":true}', $3) RETURNING event_id`,
    [worldId, locationIds.get(opening.location), opening.description],
  );
  const eventId = event.rows[0]!.event_id;

  const seq = createSeq(1);
  for (const [index, seed] of opening.seedRumors.entries()) {
    const claimId = claimIds.get(seed.claim);
    if (!claimId) continue;

    const originator = await pickRumorOriginator(client, worldId, claimId, index);
    if (!originator) continue;

    await seedRumor(client, {
      worldId,
      tick: 0,
      seq,
      claimId,
      originAgentId: originator.agentId,
      heat: seed.heat,
      valence: seed.valence,
      text: originator.claimText,
      originEventId: eventId,
    });
  }
}
