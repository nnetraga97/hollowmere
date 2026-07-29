/**
 * Scenario content: types, and a validator that runs before anything is
 * published.
 *
 * Scenario JSON is authored data, but it is still treated as untrusted input.
 * The trigger DSL in particular is a closed, allowlisted grammar — conditions
 * and effects are matched against known shapes and never evaluated as code.
 * A scenario file can describe what the story does; it can never describe what
 * the process does.
 */

import { SCALE } from '../engine/core/fixedpoint.ts';

export const SCENARIO_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export type Phase = 'morning' | 'midday' | 'evening' | 'night';
export const PHASES: readonly Phase[] = ['morning', 'midday', 'evening', 'night'];

export type Truth = 'true' | 'false' | 'unknown';

export type EscalationStage =
  | 'calm'
  | 'suspicion'
  | 'accusations'
  | 'trials'
  | 'first_blood'
  | 'war';

export const ESCALATION_STAGES: readonly EscalationStage[] = [
  'calm',
  'suspicion',
  'accusations',
  'trials',
  'first_blood',
  'war',
];

export interface FactionDef {
  key: string;
  name: string;
  ideology: string;
  leader: string;
  /** Non-belligerent factions hold beliefs but are never a side in the war. */
  belligerent: boolean;
}

export interface DistrictDef {
  key: string;
  name: string;
  controlledBy: string | null;
}

export interface LocationDef {
  key: string;
  district: string;
  name: string;
  x: number;
  y: number;
  /** Extra transmission probability here. Taverns and markets carry gossip. */
  gossipBonus: number;
}

export interface RouteDef {
  from: string;
  to: string;
  cost: number;
}

/**
 * A named daily schedule. `@home` and `@work` resolve per agent, which keeps
 * thirty agents from each repeating a four-line routine.
 */
export type RoutineSlot = '@home' | '@work' | (string & {});
export type RoutineStyleDef = Record<Phase, RoutineSlot>;

export interface AgentDef {
  key: string;
  name: string;
  faction: string;
  home: string;
  work: string;
  routine: string;
  /** One-line character description handed to the model. */
  summary: string;
  traits: readonly string[];
  /** How readily this agent believes what they are told. */
  credulity: number;
  /** How readily this agent passes it on. */
  talkativeness: number;
  status?: 'alive' | 'injured' | 'missing' | 'dead' | 'detained';
}

export interface ClaimDef {
  key: string;
  text: string;
  subject: string;
  truth: Truth;
  severity: number;
}

export interface CulpritDef {
  key: string;
  motive: string;
  profitClaim: string;
  recordClaim: string;
  claimTruth: Readonly<Record<string, Truth>>;
}

export interface AgentGoalDef {
  agent: string;
  key: string;
  priority: number;
}

export const SCHEME_TACTICS = [
  'blame_shift',
  'corroborate_false',
  'poison_the_well',
  'feign_moderation',
  'redirect_suspicion',
  'recruit_amplifier',
] as const;
export type SchemeTactic = typeof SCHEME_TACTICS[number];

export interface SchemeDef {
  key: string;
  index: number;
  tactic: SchemeTactic;
  audience: string;
  claim?: string | null;
  condition: Condition;
}

// --- Trigger DSL -----------------------------------------------------------

export type ConditionFact =
  | 'tick'
  | 'global_tension'
  | 'stage'
  | 'peace_streak'
  | 'faction_tension'
  | 'max_rumor_heat'
  | 'agent_status';

export type ConditionOp = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq';

export interface LeafCondition {
  fact: ConditionFact;
  op: ConditionOp;
  value: number | string;
  /** Required by faction_tension. */
  faction?: string;
  /** Required by agent_status. */
  agent?: string;
}

export type Condition =
  | LeafCondition
  | { all: readonly Condition[] }
  | { any: readonly Condition[] }
  | { not: Condition };

export type EffectVerb =
  | 'set_stage'
  | 'add_global_tension'
  | 'add_faction_tension'
  | 'emit_event'
  | 'seed_rumor'
  | 'set_negotiation'
  | 'end_world';

export interface Effect {
  verb: EffectVerb;
  stage?: EscalationStage;
  amount?: number;
  faction?: string;
  claim?: string;
  heat?: number;
  valence?: number;
  description?: string;
  willing?: boolean;
  ending?: 'war' | 'peace';
}

export interface TriggerDef {
  key: string;
  condition: Condition;
  effects: readonly Effect[];
  priority: number;
  once: boolean;
}

export interface OpeningEventDef {
  location: string;
  description: string;
  seedRumors: readonly { claim: string; heat: number; valence: number }[];
}

export interface Scenario {
  schemaVersion: number;
  version: string;
  name: string;
  factions: readonly FactionDef[];
  districts: readonly DistrictDef[];
  locations: readonly LocationDef[];
  routes: readonly RouteDef[];
  routineStyles: Record<string, RoutineStyleDef>;
  agents: readonly AgentDef[];
  claims: readonly ClaimDef[];
  culprits: readonly CulpritDef[];
  goals: readonly AgentGoalDef[];
  schemes: readonly SchemeDef[];
  triggers: readonly TriggerDef[];
  opening: OpeningEventDef;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ScenarioError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`scenario validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ScenarioError';
    this.issues = issues;
  }
}

const CONDITION_FACTS = new Set<string>([
  'tick',
  'global_tension',
  'stage',
  'peace_streak',
  'faction_tension',
  'max_rumor_heat',
  'agent_status',
]);
const CONDITION_OPS = new Set<string>(['lt', 'lte', 'gt', 'gte', 'eq', 'neq']);
const EFFECT_VERBS = new Set<string>([
  'set_stage',
  'add_global_tension',
  'add_faction_tension',
  'emit_event',
  'seed_rumor',
  'set_negotiation',
  'end_world',
]);
const SCHEME_TACTIC_SET = new Set<string>(SCHEME_TACTICS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inUnitRange(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SCALE;
}

/**
 * Validate a parsed scenario. Returns the scenario typed, or throws with every
 * problem found — reporting all issues at once, because fixing authored content
 * one error per run is miserable.
 */
export function validateScenario(input: unknown): Scenario {
  const issues: string[] = [];
  const fail = (msg: string): void => void issues.push(msg);

  if (!isRecord(input)) throw new ScenarioError(['scenario must be an object']);

  const s = input as Partial<Scenario>;

  if (s.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCENARIO_SCHEMA_VERSION}, got ${String(s.schemaVersion)}`);
  }
  if (typeof s.version !== 'string' || !s.version) fail('version must be a non-empty string');
  if (typeof s.name !== 'string' || !s.name) fail('name must be a non-empty string');

  const factions = s.factions ?? [];
  const districts = s.districts ?? [];
  const locations = s.locations ?? [];
  const routes = s.routes ?? [];
  const agents = s.agents ?? [];
  const claims = s.claims ?? [];
  const culprits = s.culprits ?? [];
  const goals = s.goals ?? [];
  const schemes = s.schemes ?? [];
  const triggers = s.triggers ?? [];
  const routineStyles = s.routineStyles ?? {};

  const factionKeys = new Set(factions.map((f) => f.key));
  const districtKeys = new Set(districts.map((d) => d.key));
  const locationKeys = new Set(locations.map((l) => l.key));
  const agentKeys = new Set(agents.map((a) => a.key));
  const claimKeys = new Set(claims.map((c) => c.key));
  const styleKeys = new Set(Object.keys(routineStyles));

  const requireUnique = (label: string, keys: readonly string[]): void => {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) fail(`duplicate ${label} key: ${key}`);
      seen.add(key);
    }
  };
  requireUnique('faction', factions.map((f) => f.key));
  requireUnique('district', districts.map((d) => d.key));
  requireUnique('location', locations.map((l) => l.key));
  requireUnique('agent', agents.map((a) => a.key));
  requireUnique('claim', claims.map((c) => c.key));
  requireUnique('culprit', culprits.map((c) => c.key));
  requireUnique('scheme', schemes.map((scheme) => scheme.key));
  requireUnique('scheme ladder index', schemes.map((scheme) => String(scheme.index)));
  requireUnique('trigger', triggers.map((t) => t.key));

  // --- factions
  if (factions.length < 2) fail('at least two factions are required');
  if (factions.filter((f) => f.belligerent).length !== 2) {
    fail('exactly two factions must be belligerent — the war has two sides');
  }
  for (const f of factions) {
    if (!agentKeys.has(f.leader)) fail(`faction ${f.key}: unknown leader agent "${f.leader}"`);
  }

  // --- districts and locations
  for (const d of districts) {
    if (d.controlledBy !== null && !factionKeys.has(d.controlledBy)) {
      fail(`district ${d.key}: unknown controlling faction "${d.controlledBy}"`);
    }
  }
  for (const l of locations) {
    if (!districtKeys.has(l.district)) fail(`location ${l.key}: unknown district "${l.district}"`);
    if (!Number.isInteger(l.x) || !Number.isInteger(l.y)) {
      fail(`location ${l.key}: coordinates must be integers`);
    }
    if (!inUnitRange(l.gossipBonus)) {
      fail(`location ${l.key}: gossipBonus must be an integer in [0, ${SCALE}]`);
    }
  }

  // --- routes
  for (const r of routes) {
    if (!locationKeys.has(r.from)) fail(`route: unknown from location "${r.from}"`);
    if (!locationKeys.has(r.to)) fail(`route: unknown to location "${r.to}"`);
    if (!Number.isInteger(r.cost) || r.cost <= 0) {
      fail(`route ${r.from}->${r.to}: cost must be a positive integer`);
    }
  }
  // Movement is one route segment per tick, so the graph must be connected or
  // agents would be stranded away from their routine.
  if (locations.length > 0 && routes.length > 0) {
    const unreachable = findUnreachable(locations.map((l) => l.key), routes);
    if (unreachable.length > 0) {
      fail(`locations unreachable from ${locations[0]!.key}: ${unreachable.join(', ')}`);
    }
  }

  // --- routine styles
  for (const [key, style] of Object.entries(routineStyles)) {
    for (const phase of PHASES) {
      const slot = style[phase];
      if (typeof slot !== 'string') {
        fail(`routineStyle ${key}: missing phase "${phase}"`);
        continue;
      }
      if (slot !== '@home' && slot !== '@work' && !locationKeys.has(slot)) {
        fail(`routineStyle ${key}.${phase}: unknown location "${slot}"`);
      }
    }
  }

  // --- agents
  for (const a of agents) {
    if (!factionKeys.has(a.faction)) fail(`agent ${a.key}: unknown faction "${a.faction}"`);
    if (!locationKeys.has(a.home)) fail(`agent ${a.key}: unknown home "${a.home}"`);
    if (!locationKeys.has(a.work)) fail(`agent ${a.key}: unknown work "${a.work}"`);
    if (!styleKeys.has(a.routine)) fail(`agent ${a.key}: unknown routine style "${a.routine}"`);
    if (!inUnitRange(a.credulity)) fail(`agent ${a.key}: credulity out of range`);
    if (!inUnitRange(a.talkativeness)) fail(`agent ${a.key}: talkativeness out of range`);
    if (!a.summary) fail(`agent ${a.key}: summary is required`);
  }

  // --- claims
  for (const c of claims) {
    if (!agentKeys.has(c.subject)) fail(`claim ${c.key}: unknown subject "${c.subject}"`);
    if (c.truth !== 'true' && c.truth !== 'false' && c.truth !== 'unknown') {
      fail(`claim ${c.key}: truth must be true, false, or unknown`);
    }
    if (!inUnitRange(c.severity)) fail(`claim ${c.key}: severity out of range`);
  }

  // --- culprit candidates, goals, and authored scheme fallback
  for (const culprit of culprits) {
    if (!agentKeys.has(culprit.key)) fail(`culprit ${culprit.key}: unknown agent`);
    if (!culprit.motive) fail(`culprit ${culprit.key}: motive is required`);
    if (!claimKeys.has(culprit.profitClaim)) {
      fail(`culprit ${culprit.key}: unknown profit claim "${culprit.profitClaim}"`);
    }
    if (!claimKeys.has(culprit.recordClaim)) {
      fail(`culprit ${culprit.key}: unknown record claim "${culprit.recordClaim}"`);
    }
    for (const [claimKey, truth] of Object.entries(culprit.claimTruth ?? {})) {
      if (!claimKeys.has(claimKey)) fail(`culprit ${culprit.key}: unknown truth claim "${claimKey}"`);
      if (truth !== 'true' && truth !== 'false' && truth !== 'unknown') {
        fail(`culprit ${culprit.key}: invalid truth for "${claimKey}"`);
      }
    }
  }
  for (const goal of goals) {
    if (!agentKeys.has(goal.agent)) fail(`goal ${goal.key}: unknown agent "${goal.agent}"`);
    if (!goal.key) fail('goal key is required');
    if (!Number.isInteger(goal.priority)) fail(`goal ${goal.key}: priority must be an integer`);
  }
  for (const scheme of schemes) {
    if (!Number.isInteger(scheme.index) || scheme.index < 0) {
      fail(`scheme ${scheme.key}: index must be a non-negative integer`);
    }
    if (!SCHEME_TACTIC_SET.has(scheme.tactic)) {
      fail(`scheme ${scheme.key}: unknown tactic "${String(scheme.tactic)}"`);
    }
    if (!factionKeys.has(scheme.audience) && !locationKeys.has(scheme.audience)) {
      fail(`scheme ${scheme.key}: unknown audience "${scheme.audience}"`);
    }
    if (scheme.claim != null && !claimKeys.has(scheme.claim)) {
      fail(`scheme ${scheme.key}: unknown claim "${scheme.claim}"`);
    }
    validateCondition(scheme.condition, `scheme ${scheme.key}`, { factionKeys, agentKeys }, fail);
  }

  // --- triggers
  for (const t of triggers) {
    validateCondition(t.condition, `trigger ${t.key}`, { factionKeys, agentKeys }, fail);
    if (!Array.isArray(t.effects) || t.effects.length === 0) {
      fail(`trigger ${t.key}: at least one effect is required`);
    } else {
      for (const e of t.effects) {
        validateEffect(e, `trigger ${t.key}`, { factionKeys, claimKeys }, fail);
      }
    }
  }

  // --- opening
  const opening = s.opening;
  if (!opening) {
    fail('opening event is required');
  } else {
    if (!locationKeys.has(opening.location)) {
      fail(`opening: unknown location "${opening.location}"`);
    }
    if (!opening.description) fail('opening: description is required');
    for (const seed of opening.seedRumors ?? []) {
      if (!claimKeys.has(seed.claim)) fail(`opening: unknown claim "${seed.claim}"`);
      if (!inUnitRange(seed.heat)) fail(`opening: rumor heat out of range for "${seed.claim}"`);
    }
  }

  if (issues.length > 0) throw new ScenarioError(issues);
  return input as unknown as Scenario;
}

function validateCondition(
  condition: unknown,
  where: string,
  refs: { factionKeys: Set<string>; agentKeys: Set<string> },
  fail: (msg: string) => void,
): void {
  if (!isRecord(condition)) {
    fail(`${where}: condition must be an object`);
    return;
  }

  if ('all' in condition || 'any' in condition) {
    const branch = ('all' in condition ? condition.all : condition.any) as unknown;
    if (!Array.isArray(branch) || branch.length === 0) {
      fail(`${where}: all/any must be a non-empty array`);
      return;
    }
    for (const child of branch) validateCondition(child, where, refs, fail);
    return;
  }

  if ('not' in condition) {
    validateCondition(condition.not, where, refs, fail);
    return;
  }

  const { fact, op, value, faction, agent } = condition as Record<string, unknown>;
  if (typeof fact !== 'string' || !CONDITION_FACTS.has(fact)) {
    fail(`${where}: unknown condition fact "${String(fact)}"`);
    return;
  }
  if (typeof op !== 'string' || !CONDITION_OPS.has(op)) {
    fail(`${where}: unknown condition op "${String(op)}"`);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    fail(`${where}: condition value must be a number or string`);
  }
  if (fact === 'stage' && typeof value === 'string'
      && !ESCALATION_STAGES.includes(value as EscalationStage)) {
    fail(`${where}: unknown escalation stage "${value}"`);
  }
  if (fact === 'faction_tension') {
    if (typeof faction !== 'string' || !refs.factionKeys.has(faction)) {
      fail(`${where}: faction_tension requires a known faction`);
    }
  }
  if (fact === 'agent_status') {
    if (typeof agent !== 'string' || !refs.agentKeys.has(agent)) {
      fail(`${where}: agent_status requires a known agent`);
    }
  }
}

function validateEffect(
  effect: unknown,
  where: string,
  refs: { factionKeys: Set<string>; claimKeys: Set<string> },
  fail: (msg: string) => void,
): void {
  if (!isRecord(effect)) {
    fail(`${where}: effect must be an object`);
    return;
  }
  const verb = effect.verb;
  if (typeof verb !== 'string' || !EFFECT_VERBS.has(verb)) {
    fail(`${where}: unknown effect verb "${String(verb)}"`);
    return;
  }

  switch (verb) {
    case 'set_stage':
      if (!ESCALATION_STAGES.includes(effect.stage as EscalationStage)) {
        fail(`${where}: set_stage requires a valid stage`);
      }
      break;
    case 'add_global_tension':
      if (typeof effect.amount !== 'number' || !Number.isInteger(effect.amount)) {
        fail(`${where}: add_global_tension requires an integer amount`);
      }
      break;
    case 'add_faction_tension':
      if (typeof effect.faction !== 'string' || !refs.factionKeys.has(effect.faction)) {
        fail(`${where}: add_faction_tension requires a known faction`);
      }
      if (typeof effect.amount !== 'number' || !Number.isInteger(effect.amount)) {
        fail(`${where}: add_faction_tension requires an integer amount`);
      }
      break;
    case 'emit_event':
      if (typeof effect.description !== 'string' || !effect.description) {
        fail(`${where}: emit_event requires a description`);
      }
      break;
    case 'seed_rumor':
      if (typeof effect.claim !== 'string' || !refs.claimKeys.has(effect.claim)) {
        fail(`${where}: seed_rumor requires a known claim`);
      }
      if (!inUnitRange(effect.heat)) fail(`${where}: seed_rumor heat out of range`);
      break;
    case 'set_negotiation':
      if (typeof effect.faction !== 'string' || !refs.factionKeys.has(effect.faction)) {
        fail(`${where}: set_negotiation requires a known faction`);
      }
      if (typeof effect.willing !== 'boolean') {
        fail(`${where}: set_negotiation requires a boolean willing`);
      }
      break;
    case 'end_world':
      if (effect.ending !== 'war' && effect.ending !== 'peace') {
        fail(`${where}: end_world requires ending war or peace`);
      }
      break;
  }
}

/** Locations not reachable from the first one, treating routes as undirected. */
function findUnreachable(
  locationKeys: readonly string[],
  routes: readonly RouteDef[],
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const key of locationKeys) adjacency.set(key, []);
  for (const r of routes) {
    adjacency.get(r.from)?.push(r.to);
    adjacency.get(r.to)?.push(r.from);
  }
  const start = locationKeys[0];
  if (!start) return [];

  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return locationKeys.filter((key) => !seen.has(key));
}

/** Expand a routine style into concrete locations for one agent. */
export function resolveRoutine(
  style: RoutineStyleDef,
  home: string,
  work: string,
): Record<Phase, string> {
  const out = {} as Record<Phase, string>;
  for (const phase of PHASES) {
    const slot = style[phase];
    out[phase] = slot === '@home' ? home : slot === '@work' ? work : slot;
  }
  return out;
}
