/**
 * Publish a scenario file as an immutable scenario version.
 *
 * Publishing is idempotent by checksum: republishing identical content returns
 * the existing version rather than creating a duplicate. Publishing *changed*
 * content under an existing version string is refused outright — that is the
 * mechanism that guarantees a recorded world can never have its scenario drift
 * underneath it.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { withSerializable, type Client } from '../engine/db.ts';
import {
  SCENARIO_SCHEMA_VERSION,
  resolveRoutine,
  validateScenario,
  type Scenario,
} from './schema.ts';

/**
 * Canonical JSON with sorted keys, so that formatting changes to the source
 * file do not present as content changes.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function checksumOf(scenario: Scenario): string {
  return createHash('sha256').update(canonicalize(scenario)).digest('hex');
}

export async function loadScenarioFile(path: string): Promise<Scenario> {
  const raw = await readFile(path, 'utf8');
  return validateScenario(JSON.parse(raw));
}

export interface PublishResult {
  scenarioVersionId: string;
  checksum: string;
  created: boolean;
}

export async function publishScenario(scenario: Scenario): Promise<PublishResult> {
  const checksum = checksumOf(scenario);

  const { value } = await withSerializable<PublishResult>(async (client) => {
    const byChecksum = await client.query<{ scenario_version_id: string }>(
      `SELECT scenario_version_id FROM scenario_versions WHERE checksum = $1`,
      [checksum],
    );
    if (byChecksum.rows[0]) {
      return {
        scenarioVersionId: byChecksum.rows[0].scenario_version_id,
        checksum,
        created: false,
      };
    }

    // Same version string, different content — the immutability violation we
    // most want to catch, since it would silently invalidate recorded worlds.
    const byVersion = await client.query<{ checksum: string }>(
      `SELECT checksum FROM scenario_versions WHERE version = $1`,
      [scenario.version],
    );
    if (byVersion.rows[0]) {
      throw new Error(
        `scenario version "${scenario.version}" is already published with different content ` +
          `(existing ${byVersion.rows[0].checksum.slice(0, 12)}, new ${checksum.slice(0, 12)}). ` +
          `Published scenarios are immutable — bump the version string.`,
      );
    }

    const inserted = await client.query<{ scenario_version_id: string }>(
      `INSERT INTO scenario_versions (version, name, checksum, schema_version, opening)
       VALUES ($1, $2, $3, $4, $5) RETURNING scenario_version_id`,
      [
        scenario.version,
        scenario.name,
        checksum,
        SCENARIO_SCHEMA_VERSION,
        JSON.stringify(scenario.opening),
      ],
    );
    const id = inserted.rows[0]!.scenario_version_id;

    await insertTemplates(client, id, scenario);
    return { scenarioVersionId: id, checksum, created: true };
  }, { label: 'publishScenario' });

  return value;
}

async function insertTemplates(
  client: Client,
  scenarioVersionId: string,
  scenario: Scenario,
): Promise<void> {
  // Order matters: each table's foreign keys point at the ones above it.
  for (const f of scenario.factions) {
    await client.query(
      `INSERT INTO faction_templates
         (scenario_version_id, faction_key, name, ideology, leader_agent_key, belligerent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scenarioVersionId, f.key, f.name, f.ideology, f.leader, f.belligerent],
    );
  }

  for (const d of scenario.districts) {
    await client.query(
      `INSERT INTO district_templates
         (scenario_version_id, district_key, name, controlling_faction_key)
       VALUES ($1, $2, $3, $4)`,
      [scenarioVersionId, d.key, d.name, d.controlledBy],
    );
  }

  for (const l of scenario.locations) {
    await client.query(
      `INSERT INTO location_templates
         (scenario_version_id, location_key, district_key, name, x, y, gossip_bonus)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [scenarioVersionId, l.key, l.district, l.name, l.x, l.y, l.gossipBonus],
    );
  }

  // Routes are authored undirected and materialised both ways, so an agent can
  // walk back the way it came without the scenario repeating every edge.
  for (const r of scenario.routes) {
    await client.query(
      `INSERT INTO route_templates
         (scenario_version_id, from_location_key, to_location_key, cost)
       VALUES ($1, $2, $3, $4), ($1, $3, $2, $4)`,
      [scenarioVersionId, r.from, r.to, r.cost],
    );
  }

  for (const a of scenario.agents) {
    const style = scenario.routineStyles[a.routine]!;
    const routine = resolveRoutine(style, a.home, a.work);
    await client.query(
      `INSERT INTO agent_templates
         (scenario_version_id, agent_key, name, faction_key, home_location_key,
          work_location_key, persona, routine, credulity, talkativeness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        scenarioVersionId,
        a.key,
        a.name,
        a.faction,
        a.home,
        a.work,
        JSON.stringify({ summary: a.summary, traits: a.traits, status: a.status ?? 'alive' }),
        JSON.stringify(routine),
        a.credulity,
        a.talkativeness,
      ],
    );
  }

  for (const c of scenario.claims) {
    await client.query(
      `INSERT INTO claim_templates
         (scenario_version_id, claim_key, text, subject_agent_key, truth, severity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scenarioVersionId, c.key, c.text, c.subject, c.truth, c.severity],
    );
  }

  for (const culprit of scenario.culprits ?? []) {
    await client.query(
      `INSERT INTO culprit_templates
         (scenario_version_id, culprit_key, motive_key, profit_claim_key,
          record_claim_key, claim_truth)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        scenarioVersionId,
        culprit.key,
        culprit.motive,
        culprit.profitClaim,
        culprit.recordClaim,
        JSON.stringify(culprit.claimTruth),
      ],
    );
  }

  for (const goal of scenario.goals ?? []) {
    await client.query(
      `INSERT INTO agent_goal_templates
         (scenario_version_id, agent_key, goal_key, priority)
       VALUES ($1, $2, $3, $4)`,
      [scenarioVersionId, goal.agent, goal.key, goal.priority],
    );
  }

  for (const scheme of scenario.schemes ?? []) {
    await client.query(
      `INSERT INTO scheme_templates
         (scenario_version_id, scheme_key, ladder_index, tactic, audience, claim_key, condition)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        scenarioVersionId,
        scheme.key,
        scheme.index,
        scheme.tactic,
        scheme.audience,
        scheme.claim ?? null,
        JSON.stringify(scheme.condition),
      ],
    );
  }

  for (const t of scenario.triggers) {
    await client.query(
      `INSERT INTO trigger_templates
         (scenario_version_id, trigger_key, condition, effect, priority, once)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        scenarioVersionId,
        t.key,
        JSON.stringify(t.condition),
        JSON.stringify({ effects: t.effects }),
        t.priority,
        t.once,
      ],
    );
  }
}
