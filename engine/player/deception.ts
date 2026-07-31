/**
 * Player-authored misinformation and manufactured evidence.
 *
 * A player can deliberately create a false claim, but cannot directly set what
 * anyone believes. The first listener evaluates it through the same fixed-point
 * ingredients as ordinary gossip: credulity, source trust, faction alignment,
 * rumor heat, reputation, and (optionally) the quality of a forged record.
 *
 * Manufactured records are durable evidence rows with `genuine = false`.
 * They may make a lie more persuasive, but the exposure gate only counts
 * genuine records, so forging evidence can never accidentally solve the case.
 */

import { BELIEF, CONVERSE, GOSSIP } from '../core/config.ts';
import { clampSigned, clampUnit, fpMul, type Fixed } from '../core/fixedpoint.ts';
import { stableId } from '../core/ids.ts';
import { createRng, deriveSeed } from '../core/rng.ts';
import { createSeq } from '../core/seq.ts';
import { query, withSerializable, type Client } from '../database/db.ts';
import { shiftConfidence, type FactionAlignment } from '../social/beliefs.ts';
import { seedRumor } from '../social/gossip.ts';
import type { SessionRef } from './game-api.ts';

const DECEPTION_SEQ_BASE = 5_000_000;
const DECEPTION_SEQ_STRIDE = 16;
const PLAYER_RUMOR_SEVERITY = 6_500;
const FABRICATION_REACH_REQUIRED = 3;
const FABRICATION_TIME_COST = 2;

export type RumorReaction = 'believes' | 'uncertain' | 'rejects';
export type FabricationOutcome = 'created' | 'failed' | 'exposed';

export interface PlayerRumorView {
  claimKey: string;
  text: string;
  subjectKey: string;
  createdTick: number;
  status: 'active' | 'discredited';
  heat: number;
  reach: number;
  evidenceId: string | null;
  evidenceCredibility: number | null;
  fabricationOutcome: FabricationOutcome | null;
}

export interface PlantRumorResult {
  commandId: string;
  replayed: boolean;
  claimKey: string;
  listenerKey: string;
  confidenceBefore: number;
  confidenceAfter: number;
  reaction: RumorReaction;
  usedManufacturedEvidence: boolean;
  response: string;
}

export interface ManufactureEvidenceResult {
  commandId: string;
  replayed: boolean;
  claimKey: string;
  outcome: FabricationOutcome;
  chance: number;
  quality: number;
  evidenceId: string | null;
  response: string;
}

export async function getPlayerRumors(ref: SessionRef): Promise<PlayerRumorView[]> {
  const rows = await query<{
    claim_key: string; text: string; subject_key: string; created_tick: number;
    status: PlayerRumorView['status']; heat: number | null; reach: number;
    evidence_id: string | null; credibility: number | null;
    outcome: FabricationOutcome | null;
  }>(
    `SELECT c.claim_key, c.text, subject.agent_key AS subject_key,
            owned.created_tick, owned.status, rumor.heat,
            count(DISTINCT spread.agent_id)::INT8 AS reach,
            max(e.evidence_id::STRING)::UUID AS evidence_id,
            max(e.credibility)::INT8 AS credibility,
            max(attempt.outcome) AS outcome
       FROM world_player_rumors owned
       JOIN world_players p
         ON p.world_id = owned.world_id AND p.player_id = owned.player_id
       JOIN world_claims c
         ON c.world_id = owned.world_id AND c.claim_id = owned.claim_id
       JOIN world_agents subject
         ON subject.world_id = c.world_id AND subject.agent_id = c.subject_agent_id
       LEFT JOIN world_rumors rumor
         ON rumor.world_id = c.world_id AND rumor.claim_id = c.claim_id
       LEFT JOIN world_rumor_spread spread
         ON spread.world_id = rumor.world_id AND spread.rumor_id = rumor.rumor_id
       LEFT JOIN world_player_evidence e
         ON e.world_id = owned.world_id AND e.player_id = owned.player_id
        AND e.claim_id = owned.claim_id AND e.manufactured AND e.discovered_tick IS NULL
       LEFT JOIN world_player_fabrication_attempts attempt
         ON attempt.world_id = owned.world_id AND attempt.player_id = owned.player_id
        AND attempt.claim_id = owned.claim_id
      WHERE owned.world_id = $1 AND p.session_id = $2
      GROUP BY c.claim_key, c.text, subject.agent_key, owned.created_tick,
               owned.status, rumor.heat
      ORDER BY owned.created_tick DESC, c.claim_key`,
    [ref.worldId, ref.sessionId],
  );
  return rows.map((row) => ({
    claimKey: row.claim_key,
    text: row.text,
    subjectKey: row.subject_key,
    createdTick: row.created_tick,
    status: row.status,
    heat: row.heat ?? 0,
    reach: row.reach,
    evidenceId: row.evidence_id,
    evidenceCredibility: row.credibility,
    fabricationOutcome: row.outcome,
  }));
}

export async function plantPlayerRumor(input: SessionRef & {
  listenerAgentKey: string;
  idempotencyKey: string;
  /** Present for a new lie. */
  subjectAgentKey?: string;
  text?: string;
  /** Present when repeating one of this player's existing lies. */
  claimKey?: string;
  evidenceId?: string;
}): Promise<PlantRumorResult> {
  const normalized = input.text ? normalizeRumorText(input.text) : null;
  if (!input.claimKey && (!input.subjectAgentKey || !normalized)) {
    throw new Error('a new rumor requires a subject and a story');
  }
  if (input.claimKey && (input.subjectAgentKey || normalized)) {
    throw new Error('repeat an existing rumor or create a new one, not both');
  }

  const { value } = await withSerializable(async (client) => {
    const replay = await replayedResult<PlantRumorResult>(
      client, input.worldId, input.idempotencyKey, 'plant_rumor',
    );
    if (replay) return { ...replay, replayed: true };

    const context = await loadPlantContext(client, input);
    if (context.listener_agent_id === context.subject_agent_id) {
      throw new Error('choose someone other than the subject as the first listener');
    }

    const commandSeq = context.command_seq + 1;
    const seq = createSeq(DECEPTION_SEQ_BASE + commandSeq * DECEPTION_SEQ_STRIDE);
    const commandId = stableId(input.worldId, 'plant-rumor', commandSeq);
    const eventId = stableId(input.worldId, 'plant-rumor-event', commandSeq);
    const claimId = context.claim_id ?? stableId(input.worldId, 'player-rumor-claim', commandSeq);
    const claimKey = context.claim_key ?? `player_rumor_${commandSeq}`;
    const claimText = context.claim_text ?? normalized!;

    await client.query(
      `UPDATE worlds
          SET command_seq = $2, last_activity_at = now()
        WHERE world_id = $1`,
      [input.worldId, commandSeq],
    );
    await client.query(
      `INSERT INTO world_events
         (world_id, event_id, tick, seq, location_id, kind, payload, description)
       VALUES ($1, $2, $3, $4, $5, 'player_command', $6, $7)`,
      [
        input.worldId, eventId, context.current_tick, seq.next(), context.location_id,
        JSON.stringify({ playerRumor: true, claimKey, subjectKey: context.subject_key,
          listenerKey: context.listener_key, evidenceId: input.evidenceId ?? null }),
        `The outsider plants a story about ${context.subject_name} with ${context.listener_name}.`,
      ],
    );

    if (!context.claim_id) {
      await client.query(
        `INSERT INTO world_claims
           (world_id, claim_id, claim_key, text, subject_agent_id, truth,
            severity, authored, locked, created_tick)
         VALUES ($1, $2, $3, $4, $5, 'false', $6, false, false, $7)`,
        [input.worldId, claimId, claimKey, claimText, context.subject_agent_id,
          PLAYER_RUMOR_SEVERITY, context.current_tick],
      );
      await client.query(
        `INSERT INTO world_player_rumors
           (world_id, claim_id, player_id, origin_event_id, created_tick)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.worldId, claimId, context.player_id, eventId, context.current_tick],
      );
    }

    const evidence = input.evidenceId
      ? await loadManufacturedEvidence(client, {
          worldId: input.worldId, playerId: context.player_id,
          claimId, evidenceId: input.evidenceId,
        })
      : null;
    const heat = clampUnit(
      CONVERSE.playerRumorHeat +
      (evidence ? fpMul(evidence.credibility, CONVERSE.manufacturedEvidenceHeatBoost) : 0),
    );
    const confidenceBefore = context.current_confidence ?? 0;
    const confidenceAfter = shiftConfidence({
      current: confidenceBefore,
      credulity: context.credulity,
      trust: sourceCredibility(context.player_trust, context.reputation),
      heat,
      alignment: alignmentFor(context.listener_faction_key, context.subject_faction_key),
    });

    await seedRumor(client, {
      worldId: input.worldId,
      tick: context.current_tick,
      seq,
      claimId,
      originAgentId: context.listener_agent_id,
      heat,
      valence: -PLAYER_RUMOR_SEVERITY,
      text: claimText,
      originEventId: eventId,
      channel: 'player',
      fromPlayerId: context.player_id,
      initialConfidence: confidenceAfter,
    });

    const reaction = reactionFor(confidenceAfter);
    const result: PlantRumorResult = {
      commandId,
      replayed: false,
      claimKey,
      listenerKey: context.listener_key,
      confidenceBefore,
      confidenceAfter,
      reaction,
      usedManufacturedEvidence: Boolean(evidence),
      response: reactionText(context.listener_name, reaction, Boolean(evidence)),
    };
    await client.query(
      `INSERT INTO world_commands
         (world_id, command_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, $4, 'plant_rumor', $5, $6)`,
      [input.worldId, commandId, input.idempotencyKey, commandSeq,
        JSON.stringify(result), context.current_tick],
    );
    return result;
  }, { label: 'plant-player-rumor' });
  return value;
}

export async function manufacturePlayerEvidence(input: SessionRef & {
  claimKey: string;
  idempotencyKey: string;
}): Promise<ManufactureEvidenceResult> {
  const { value } = await withSerializable(async (client) => {
    const replay = await replayedResult<ManufactureEvidenceResult>(
      client, input.worldId, input.idempotencyKey, 'manufacture_evidence',
    );
    if (replay) return { ...replay, replayed: true };

    const context = await loadFabricationContext(client, input);
    if (context.reach < FABRICATION_REACH_REQUIRED) {
      throw new Error(
        `the story needs ${FABRICATION_REACH_REQUIRED} listeners before a supporting record looks plausible`,
      );
    }
    if (context.previous_outcome) throw new Error('this rumor has already had one fabrication attempt');

    const commandSeq = context.command_seq + 1;
    const eventSeq = DECEPTION_SEQ_BASE + commandSeq * DECEPTION_SEQ_STRIDE;
    const commandId = stableId(input.worldId, 'manufacture-evidence', commandSeq);
    const attemptId = stableId(input.worldId, 'fabrication-attempt', commandSeq);
    const eventId = stableId(input.worldId, 'fabrication-event', commandSeq);
    const evidenceId = stableId(input.worldId, 'fabricated-evidence', commandSeq);
    const skill = backgroundBonus(context.background);
    const chance = fabricationChance({
      reach: context.reach,
      tension: context.global_tension,
      locationKey: context.location_key,
      backgroundBonus: skill,
    });
    const rng = createRng(deriveSeed(context.seed, commandSeq, 'manufacture-evidence'));
    const created = rng.chance(chance);
    const exposed = !created && rng.chance(1_500 + Math.floor((10_000 - chance) / 5));
    const outcome: FabricationOutcome = created ? 'created' : exposed ? 'exposed' : 'failed';
    const quality = created ? clampUnit(3_800 + rng.nextBelow(2_601) + Math.floor(skill / 2)) : 0;

    await client.query(
      `UPDATE worlds
          SET command_seq = $2, time_debt_ticks = time_debt_ticks + $3,
              last_activity_at = now()
        WHERE world_id = $1`,
      [input.worldId, commandSeq, FABRICATION_TIME_COST],
    );
    const description = outcome === 'created'
      ? `The outsider manufactures a record supporting a story about ${context.subject_name}.`
      : outcome === 'exposed'
        ? `A clumsy false record about ${context.subject_name} is traced back to the outsider.`
        : `The outsider fails to manufacture a convincing record about ${context.subject_name}.`;
    await client.query(
      `INSERT INTO world_events
         (world_id, event_id, tick, seq, location_id, kind, payload, description)
       VALUES ($1, $2, $3, $4, $5, 'player_command', $6, $7)`,
      [input.worldId, eventId, context.current_tick, eventSeq, context.location_id,
        JSON.stringify({ fabrication: true, claimKey: input.claimKey, outcome, quality }),
        description],
    );
    await client.query(
      `INSERT INTO world_player_fabrication_attempts
         (world_id, attempt_id, player_id, claim_id, event_id, tick, seq,
          method, outcome, chance, quality)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'forged_record', $8, $9, $10)`,
      [input.worldId, attemptId, context.player_id, context.claim_id, eventId,
        context.current_tick, eventSeq + 1, outcome, chance, quality],
    );

    let storedEvidenceId: string | null = null;
    if (outcome === 'created') {
      await client.query(
        `INSERT INTO world_player_evidence
           (world_id, player_id, evidence_id, kind, event_id, claim_id, accused_id,
            genuine, manufactured, credibility, found_tick)
         VALUES ($1, $2, $3, 'record', $4, $5, $6, false, true, $7, $8)`,
        [input.worldId, context.player_id, evidenceId, eventId, context.claim_id,
          context.subject_agent_id, quality, context.current_tick],
      );
      storedEvidenceId = evidenceId;
    } else if (outcome === 'exposed') {
      await client.query(
        `UPDATE player_reputation
            SET reputation = GREATEST(-10000, reputation - 800), updated_tick = $3
          WHERE world_id = $1 AND player_id = $2`,
        [input.worldId, context.player_id, context.current_tick],
      );
      await client.query(
        `UPDATE world_state
            SET global_tension = LEAST(10000, global_tension + 250)
          WHERE world_id = $1`,
        [input.worldId],
      );
      await client.query(
        `UPDATE world_player_rumors SET status = 'discredited'
          WHERE world_id = $1 AND claim_id = $2`,
        [input.worldId, context.claim_id],
      );
      await client.query(
        `UPDATE world_rumors SET heat = GREATEST(0, heat - 2500), updated_tick = $3
          WHERE world_id = $1 AND claim_id = $2`,
        [input.worldId, context.claim_id, context.current_tick],
      );
    }

    const result: ManufactureEvidenceResult = {
      commandId,
      replayed: false,
      claimKey: input.claimKey,
      outcome,
      chance,
      quality,
      evidenceId: storedEvidenceId,
      response: fabricationResponse(outcome, quality),
    };
    await client.query(
      `INSERT INTO world_commands
         (world_id, command_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, $4, 'manufacture_evidence', $5, $6)`,
      [input.worldId, commandId, input.idempotencyKey, commandSeq,
        JSON.stringify(result), context.current_tick],
    );
    return result;
  }, { label: 'manufacture-player-evidence' });
  return value;
}

export function sourceCredibility(trust: Fixed, reputation: Fixed): Fixed {
  const reputationFactor = clampUnit(5_000 + Math.trunc(reputation / 2));
  return fpMul(clampUnit(trust), reputationFactor);
}

export function fabricationChance(input: {
  reach: number;
  tension: Fixed;
  locationKey: string;
  backgroundBonus: Fixed;
}): Fixed {
  const locationBonus = ['granary', 'shipyard'].includes(input.locationKey) ? 1_000
    : ['market_square', 'high_row'].includes(input.locationKey) ? 650 : 0;
  const reachBonus = Math.min(1_500, Math.max(0, input.reach - FABRICATION_REACH_REQUIRED) * 300);
  const chaosBonus = Math.min(1_000, Math.floor(input.tension / 10));
  return Math.min(6_500, Math.max(1_200,
    2_200 + locationBonus + reachBonus + chaosBonus + input.backgroundBonus));
}

function normalizeRumorText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 12) throw new Error('the rumor needs enough detail to sound like a story');
  if (normalized.length > 240) throw new Error('keep the rumor under 240 characters');
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function alignmentFor(listenerFaction: string, subjectFaction: string): FactionAlignment {
  if (listenerFaction === subjectFaction) return 'same';
  if (listenerFaction === 'unaligned' || subjectFaction === 'unaligned') return 'unaligned';
  return 'rival';
}

function reactionFor(confidence: Fixed): RumorReaction {
  if (confidence >= BELIEF.actionableConfidence) return 'believes';
  if (confidence >= GOSSIP.playerRumorMinConfidenceToTransmit) return 'uncertain';
  return 'rejects';
}

function reactionText(name: string, reaction: RumorReaction, evidence: boolean): string {
  const support = evidence ? ' The record makes the story harder to dismiss.' : '';
  if (reaction === 'believes') return `${name} accepts the story and may carry it into town.${support}`;
  if (reaction === 'uncertain') return `${name} is not convinced, but finds it plausible enough to repeat.${support}`;
  return `${name} rejects the story. It stops with them unless you find a more credible audience or supporting evidence.`;
}

function backgroundBonus(background: string): Fixed {
  return /\b(scribe|clerk|forger|smuggler|merchant|scholar|printer|lawyer|accountant|archivist)\b/i
    .test(background) ? 1_500 : 0;
}

function fabricationResponse(outcome: FabricationOutcome, quality: Fixed): string {
  if (outcome === 'created') {
    return `You produce a false record with ${Math.round(quality / 100)}% apparent credibility. It can support this rumor, but a genuine investigation will not count it as proof.`;
  }
  if (outcome === 'exposed') {
    return 'The forgery fails and is traced back to you. Your reputation falls, the story is discredited, and town tension rises.';
  }
  return 'The forgery is not convincing enough to use. The attempt consumed time, and this rumor cannot be forged again.';
}

async function replayedResult<T>(
  client: Client, worldId: string, idempotencyKey: string, kind: string,
): Promise<T | null> {
  const row = await client.query<{ payload: T }>(
    `SELECT payload FROM world_commands
      WHERE world_id = $1 AND idempotency_key = $2 AND kind = $3`,
    [worldId, idempotencyKey, kind],
  );
  return row.rows[0]?.payload ?? null;
}

async function loadManufacturedEvidence(
  client: Client,
  input: { worldId: string; playerId: string; claimId: string; evidenceId: string },
): Promise<{ credibility: number }> {
  const row = await client.query<{ credibility: number }>(
    `SELECT credibility FROM world_player_evidence
      WHERE world_id = $1 AND player_id = $2 AND claim_id = $3
        AND evidence_id = $4 AND manufactured AND NOT genuine
        AND discovered_tick IS NULL`,
    [input.worldId, input.playerId, input.claimId, input.evidenceId],
  );
  if (!row.rows[0]) throw new Error('that manufactured record cannot support this rumor');
  return row.rows[0];
}

interface PlantContext {
  current_tick: number; command_seq: number; player_id: string; location_id: string;
  listener_agent_id: string; listener_key: string; listener_name: string;
  listener_faction_key: string; credulity: number; player_trust: number;
  reputation: number; current_confidence: number | null;
  subject_agent_id: string; subject_key: string; subject_name: string;
  subject_faction_key: string; claim_id: string | null; claim_key: string | null;
  claim_text: string | null;
}

async function loadPlantContext(client: Client, input: SessionRef & {
  listenerAgentKey: string; subjectAgentKey?: string; claimKey?: string;
}): Promise<PlantContext> {
  if (input.claimKey) {
    const rows = await client.query<PlantContext>(
      `${plantContextSelect()}
       JOIN world_player_rumors owned
         ON owned.world_id = w.world_id AND owned.player_id = p.player_id
       JOIN world_claims claim
         ON claim.world_id = owned.world_id AND claim.claim_id = owned.claim_id
        AND claim.claim_key = $4
       JOIN world_agents subject
         ON subject.world_id = claim.world_id AND subject.agent_id = claim.subject_agent_id
       JOIN world_factions subject_faction
         ON subject_faction.world_id = subject.world_id
        AND subject_faction.faction_id = subject.faction_id
       LEFT JOIN agent_beliefs belief
         ON belief.world_id = listener.world_id AND belief.agent_id = listener.agent_id
        AND belief.claim_id = claim.claim_id
      WHERE w.world_id = $1 AND p.session_id = $2 AND listener.agent_key = $3
        AND w.status = 'active' AND owned.status = 'active'
        AND listener.location_id = p.location_id
      FOR UPDATE OF w, p, listener`,
      [input.worldId, input.sessionId, input.listenerAgentKey, input.claimKey],
    );
    if (!rows.rows[0]) throw new Error('listener or owned rumor is unavailable here');
    return rows.rows[0];
  }
  const rows = await client.query<PlantContext>(
    `${plantContextSelect()}
     JOIN world_agents subject
       ON subject.world_id = w.world_id AND subject.agent_key = $4 AND subject.status = 'alive'
     JOIN world_factions subject_faction
       ON subject_faction.world_id = subject.world_id
      AND subject_faction.faction_id = subject.faction_id
     LEFT JOIN world_claims claim ON false
     LEFT JOIN agent_beliefs belief
       ON belief.world_id = listener.world_id AND belief.agent_id = listener.agent_id
      AND belief.claim_id = claim.claim_id
    WHERE w.world_id = $1 AND p.session_id = $2 AND listener.agent_key = $3
      AND w.status = 'active' AND listener.location_id = p.location_id
    FOR UPDATE OF w, p, listener`,
    [input.worldId, input.sessionId, input.listenerAgentKey, input.subjectAgentKey],
  );
  if (!rows.rows[0]) throw new Error('listener or subject is unavailable here');
  return rows.rows[0];
}

function plantContextSelect(): string {
  return `SELECT w.current_tick, w.command_seq, p.player_id, p.location_id,
                 listener.agent_id AS listener_agent_id,
                 listener.agent_key AS listener_key, listener.name AS listener_name,
                 listener_faction.faction_key AS listener_faction_key,
                 listener.credulity,
                 COALESCE(player_rel.trust, 5000) AS player_trust,
                 COALESCE(rep.reputation, 0) AS reputation,
                 belief.confidence AS current_confidence,
                 subject.agent_id AS subject_agent_id, subject.agent_key AS subject_key,
                 subject.name AS subject_name,
                 subject_faction.faction_key AS subject_faction_key,
                 claim.claim_id, claim.claim_key, claim.text AS claim_text
            FROM worlds w
            JOIN world_players p ON p.world_id = w.world_id
            JOIN world_agents listener ON listener.world_id = w.world_id AND listener.status = 'alive'
            JOIN world_factions listener_faction
              ON listener_faction.world_id = listener.world_id
             AND listener_faction.faction_id = listener.faction_id
            LEFT JOIN player_agent_relationships player_rel
              ON player_rel.world_id = p.world_id AND player_rel.player_id = p.player_id
             AND player_rel.agent_id = listener.agent_id
            LEFT JOIN player_reputation rep
              ON rep.world_id = p.world_id AND rep.player_id = p.player_id
             AND rep.faction_id = listener.faction_id`;
}

interface FabricationContext {
  current_tick: number; command_seq: number; seed: number; global_tension: number;
  player_id: string; background: string; location_id: string; location_key: string;
  claim_id: string; subject_agent_id: string; subject_name: string;
  reach: number; previous_outcome: FabricationOutcome | null;
}

async function loadFabricationContext(
  client: Client, input: SessionRef & { claimKey: string },
): Promise<FabricationContext> {
  const rows = await client.query<FabricationContext>(
    `SELECT w.current_tick, w.command_seq, w.seed, state.global_tension,
            p.player_id, COALESCE(p.profile->>'background', '') AS background,
            p.location_id, location.location_key,
            claim.claim_id, subject.agent_id AS subject_agent_id,
            subject.name AS subject_name,
            (SELECT count(DISTINCT spread.agent_id)::INT8
               FROM world_rumors rumor
               JOIN world_rumor_spread spread
                 ON spread.world_id = rumor.world_id AND spread.rumor_id = rumor.rumor_id
              WHERE rumor.world_id = claim.world_id AND rumor.claim_id = claim.claim_id) AS reach,
            (SELECT attempt.outcome
               FROM world_player_fabrication_attempts attempt
              WHERE attempt.world_id = owned.world_id
                AND attempt.player_id = owned.player_id
                AND attempt.claim_id = owned.claim_id
              ORDER BY attempt.tick DESC LIMIT 1) AS previous_outcome
       FROM worlds w
       JOIN world_state state ON state.world_id = w.world_id
       JOIN world_players p ON p.world_id = w.world_id AND p.session_id = $2
       JOIN world_locations location
         ON location.world_id = p.world_id AND location.location_id = p.location_id
       JOIN world_player_rumors owned
         ON owned.world_id = w.world_id AND owned.player_id = p.player_id
        AND owned.status = 'active'
       JOIN world_claims claim
         ON claim.world_id = owned.world_id AND claim.claim_id = owned.claim_id
        AND claim.claim_key = $3 AND claim.truth = 'false'
       JOIN world_agents subject
         ON subject.world_id = claim.world_id AND subject.agent_id = claim.subject_agent_id
      WHERE w.world_id = $1 AND w.status = 'active'
      FOR UPDATE OF w, p`,
    [input.worldId, input.sessionId, input.claimKey],
  );
  if (!rows.rows[0]) throw new Error('owned rumor is unavailable');
  return rows.rows[0];
}
