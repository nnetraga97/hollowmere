/**
 * Public accusations — the rules-only escalation loop.
 *
 * Gossip alone cannot carry a town to war. Once everyone has heard a rumor
 * there is nobody left to tell, transmissions stop, and tension would settle
 * into a plateau just below whatever the first wave reached. Real towns do not
 * work that way: what keeps a feud going is not new information but the same
 * accusation being said again, louder, by people who now believe it.
 *
 * So belief feeds back into tension directly. An agent who actually believes a
 * damaging claim about the other House will, with a probability that rises as
 * the town gets worse, say so in public. That raises tension, which advances
 * the stage, which makes everyone readier to speak — the loop that produces war
 * under no input at all.
 *
 * This costs no inference. Forty agents can be this angry every tick for the
 * price of two queries, which is what keeps town-wide behaviour affordable
 * while cognition stays reserved for the spotlight.
 */

import type { Client } from '../database/db.ts';
import { ACCUSATION, BELIEF, TENSION } from '../core/config.ts';
import { clampUnit, fpMul, type Fixed } from '../core/fixedpoint.ts';
import type { Rng } from '../core/rng.ts';
import type { Seq } from '../core/seq.ts';
import type { EscalationStage } from '../simulation/tension.ts';
import { recordTelling } from '../social/gossip.ts';

export interface AccusationContext {
  worldId: string;
  tick: number;
  seq: Seq;
  rng: Rng;
  stage: EscalationStage;
}

export interface Accusation {
  accuserKey: string;
  subjectKey: string;
  claimKey: string;
  confidence: Fixed;
  severity: Fixed;
}

export interface AccusationResult {
  accusations: Accusation[];
  tensionDelta: Fixed;
  /** Tension attributed to the accused agent's faction. */
  factionDelta: Map<string, Fixed>;
}

interface CandidateRow {
  agent_id: string;
  agent_key: string;
  claim_id: string;
  claim_key: string;
  claim_text: string;
  severity: number;
  confidence: number;
  subject_agent_id: string;
  subject_key: string;
  subject_faction_id: string;
  rumor_id: string;
  heat: number;
  location_id: string | null;
}

/**
 * Give every sufficiently convinced believer a chance to speak this tick.
 */
export async function runAccusations(
  client: Client,
  ctx: AccusationContext,
): Promise<AccusationResult> {
  const result: AccusationResult = {
    accusations: [],
    tensionDelta: 0,
    factionDelta: new Map(),
  };

  const chance = ACCUSATION.chanceByStage[ctx.stage];
  if (chance <= 0) return result;

  const candidates = await loadCandidates(client, ctx.worldId);
  if (candidates.length === 0) return result;

  // Ordered deterministically by the query, then shuffled by the seeded
  // generator so that the same few loudest believers do not monopolise every
  // tick's quota. Both steps are reproducible.
  for (const candidate of ctx.rng.shuffle(candidates)) {
    if (result.accusations.length >= ACCUSATION.maxPerTick) break;
    if (!ctx.rng.chance(chance)) continue;

    const rise = await emitAccusation(client, {
      worldId: ctx.worldId,
      tick: ctx.tick,
      seq: ctx.seq,
      accuserId: candidate.agent_id,
      accuserKey: candidate.agent_key,
      locationId: candidate.location_id,
      subjectKey: candidate.subject_key,
      subjectFactionId: candidate.subject_faction_id,
      claimKey: candidate.claim_key,
      claimText: candidate.claim_text,
      severity: candidate.severity,
      confidence: candidate.confidence,
      rumorId: candidate.rumor_id,
      rumorHeat: candidate.heat,
    });

    result.tensionDelta += rise;
    result.factionDelta.set(
      candidate.subject_faction_id,
      (result.factionDelta.get(candidate.subject_faction_id) ?? 0) + rise,
    );
    result.accusations.push({
      accuserKey: candidate.agent_key,
      subjectKey: candidate.subject_key,
      claimKey: candidate.claim_key,
      confidence: candidate.confidence,
      severity: candidate.severity,
    });
  }

  result.tensionDelta = clampUnit(result.tensionDelta);
  return result;
}

export interface EmitAccusationInput {
  worldId: string;
  tick: number;
  seq: Seq;
  accuserId: string;
  accuserKey: string;
  locationId: string | null;
  subjectKey: string;
  subjectFactionId: string;
  claimKey: string;
  claimText: string;
  severity: Fixed;
  confidence: Fixed;
  rumorId: string | null;
  rumorHeat: Fixed;
}

/**
 * Record one accusation and return the tension it generates.
 *
 * Shared by the ambient believers here, by a spotlit agent who decides to speak,
 * and by the player accusing someone in conversation — all three are the same
 * act and must price and reheat identically, or the player would be able to
 * make an accusation that counts for more than a townsperson's.
 */
export async function emitAccusation(
  client: Client,
  input: EmitAccusationInput,
): Promise<Fixed> {
  const event = await client.query<{ event_id: string }>(
    `INSERT INTO world_events
       (world_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
     VALUES ($1, $2, $3, $4, $5, 'accusation', $6, $7)
     RETURNING event_id`,
    [
      input.worldId, input.tick, input.seq.next(),
      input.locationId, input.accuserId,
      JSON.stringify({
        claimKey: input.claimKey,
        subjectKey: input.subjectKey,
        confidence: input.confidence,
      }),
      `${input.accuserKey} says it aloud: ${input.claimText}`,
    ],
  );

  // Saying it again puts the story back in circulation, so people who missed it
  // the first time can still hear it. This is the only thing that keeps an old
  // rumor spreading after the first wave of gossip has passed through everyone.
  if (input.rumorId) {
    await client.query(
      `UPDATE world_rumors SET heat = $3, updated_tick = $4
        WHERE world_id = $1 AND rumor_id = $2`,
      [
        input.worldId, input.rumorId,
        clampUnit(input.rumorHeat + fpMul(ACCUSATION.reheat, input.severity)),
        input.tick,
      ],
    );
    const listener = await client.query<{ agent_id: string; claim_id: string }>(
      `SELECT listener.agent_id, rumor.claim_id
         FROM world_rumors rumor
         JOIN world_agents listener
           ON listener.world_id = rumor.world_id AND listener.location_id = $3
          AND listener.agent_id != $4 AND listener.status = 'alive'
        WHERE rumor.world_id = $1 AND rumor.rumor_id = $2
        ORDER BY listener.agent_key LIMIT 1`,
      [input.worldId, input.rumorId, input.locationId, input.accuserId],
    );
    if (listener.rows[0]) {
      await client.query(
        `INSERT INTO world_rumor_spread
           (world_id, rumor_id, agent_id, received_tick, distorted_text, from_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (world_id, rumor_id, agent_id) DO NOTHING`,
        [
          input.worldId, input.rumorId, listener.rows[0].agent_id,
          input.tick, input.claimText, input.accuserId,
        ],
      );
      await recordTelling(client, {
        worldId: input.worldId,
        rumorId: input.rumorId,
        claimId: listener.rows[0].claim_id,
        fromAgentId: input.accuserId,
        toAgentId: listener.rows[0].agent_id,
        eventId: event.rows[0]!.event_id,
        tick: input.tick,
        seq: input.seq.next(),
        channel: 'accusation',
      });
    }
  }

  return fpMul(TENSION.publicAccusation, input.severity);
}

export interface ResolvedAccusation {
  rise: Fixed;
  subjectFactionId: string;
  subjectKey: string;
}

/**
 * Accuse by claim key, resolving everything the low-level form needs.
 *
 * Returns null when the accusation is not one the rules recognise — an unknown
 * claim, a dead accuser, or an accusation that does not cross the line between
 * the two Houses. Refusing quietly is deliberate: this is reached from model
 * output and from player text, and neither may invent an effect by naming
 * something that does not exist.
 */
export async function accuseByClaimKey(
  client: Client,
  input: {
    worldId: string; tick: number; seq: Seq; accuserId: string; claimKey: string;
  },
): Promise<ResolvedAccusation | null> {
  const result = await client.query<{
    agent_key: string; location_id: string | null;
    claim_key: string; claim_text: string; severity: number;
    subject_key: string; subject_faction_id: string;
    confidence: number | null; rumor_id: string | null; heat: number | null;
    accuser_belligerent: boolean; subject_belligerent: boolean;
    same_faction: boolean; claim_kind: string;
  }>(
    `SELECT a.agent_key, a.location_id,
            c.claim_key, c.text AS claim_text, c.severity,
            s.agent_key AS subject_key, s.faction_id AS subject_faction_id,
            b.confidence, r.rumor_id, r.heat,
            af.belligerent AS accuser_belligerent,
            sf.belligerent AS subject_belligerent,
            (a.faction_id = s.faction_id) AS same_faction,
            c.kind AS claim_kind
       FROM world_agents a
       JOIN world_claims c ON c.world_id = a.world_id AND c.claim_key = $3
       JOIN world_agents s ON s.world_id = c.world_id AND s.agent_id = c.subject_agent_id
       JOIN world_factions af ON af.world_id = a.world_id AND af.faction_id = a.faction_id
       JOIN world_factions sf ON sf.world_id = s.world_id AND sf.faction_id = s.faction_id
       LEFT JOIN agent_beliefs b
              ON b.world_id = a.world_id AND b.agent_id = a.agent_id AND b.claim_id = c.claim_id
       LEFT JOIN world_rumors r ON r.world_id = c.world_id AND r.claim_id = c.claim_id
      WHERE a.world_id = $1 AND a.agent_id = $2 AND a.status = 'alive'
        AND NOT c.locked
      ORDER BY r.rumor_id
      LIMIT 1`,
    [input.worldId, input.accuserId, input.claimKey],
  );

  const row = result.rows[0];
  if (!row) return null;
  if (row.claim_kind !== 'accusation') return null;
  const resolution = row.claim_key === 'instigator_altered_notebook'
    || row.claim_key === 'instigator_murdered_for_war';
  if (!resolution && row.same_faction) return null;
  if (!resolution && (!row.accuser_belligerent || !row.subject_belligerent)) return null;

  const rise = await emitAccusation(client, {
    worldId: input.worldId,
    tick: input.tick,
    seq: input.seq,
    accuserId: input.accuserId,
    accuserKey: row.agent_key,
    locationId: row.location_id,
    subjectKey: row.subject_key,
    subjectFactionId: row.subject_faction_id,
    claimKey: row.claim_key,
    claimText: row.claim_text,
    severity: row.severity,
    confidence: row.confidence ?? 0,
    rumorId: row.rumor_id,
    rumorHeat: row.heat ?? 0,
  });

  return {
    rise: resolution ? 0 : rise,
    subjectFactionId: row.subject_faction_id,
    subjectKey: row.subject_key,
  };
}

/**
 * Everyone who believes something damaging about the other House.
 *
 * Only belligerent factions accuse belligerent factions: the magistrate, the
 * priest, and the physician carry gossip and hold beliefs, but they are not a
 * side in the war and their opinions must not push it along.
 */
async function loadCandidates(client: Client, worldId: string): Promise<CandidateRow[]> {
  const result = await client.query<CandidateRow>(
    `SELECT a.agent_id, a.agent_key, a.location_id,
            c.claim_id, c.claim_key, c.text AS claim_text, c.severity,
            b.confidence,
            s.agent_id AS subject_agent_id, s.agent_key AS subject_key,
            s.faction_id AS subject_faction_id,
            r.rumor_id, r.heat
       FROM agent_beliefs b
       JOIN world_agents a ON a.world_id = b.world_id AND a.agent_id = b.agent_id
       JOIN world_claims c ON c.world_id = b.world_id AND c.claim_id = b.claim_id
       JOIN world_agents s ON s.world_id = c.world_id AND s.agent_id = c.subject_agent_id
       JOIN world_factions af ON af.world_id = a.world_id AND af.faction_id = a.faction_id
       JOIN world_factions sf ON sf.world_id = s.world_id AND sf.faction_id = s.faction_id
       JOIN world_rumors r ON r.world_id = b.world_id AND r.claim_id = b.claim_id
      WHERE b.world_id = $1
        AND b.confidence >= $2
        AND a.status = 'alive'
        AND af.belligerent AND sf.belligerent
        AND a.faction_id != s.faction_id
        AND r.valence < 0
        AND c.kind = 'accusation'
        AND NOT c.locked
        AND c.claim_key NOT IN ('instigator_altered_notebook', 'instigator_murdered_for_war')
      ORDER BY b.confidence DESC, a.agent_key, c.claim_key`,
    [worldId, BELIEF.actionableConfidence],
  );
  return result.rows;
}
