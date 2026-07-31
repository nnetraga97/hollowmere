/**
 * Gossip diffusion.
 *
 * Every tick, rumors travel person to person along the social graph. This runs
 * for the whole town — all thirty agents — and uses no model inference beyond an
 * occasional rewording, which is what makes town-wide propagation affordable
 * while full cognition stays reserved for a handful of spotlit agents.
 *
 * The propagation rules are deliberately simple and entirely integer:
 *   who holds it  ×  how hot it still is  ×  who they trust  ×  who is nearby
 *
 * Belief is where the interesting asymmetry lives (see beliefs.ts): the same
 * retelling pushes a rival toward believing and a housemate toward denial, so a
 * single accusation polarises the town instead of converging it.
 *
 * Note what this does NOT do: it writes no rows to world_memories. Hearing
 * something is recorded in world_rumor_spread (with the exact wording that
 * reached that person) and in their belief; turning it into an embedded,
 * retrievable memory happens later, in cognition, and only for agents who
 * actually think. Embedding every retelling for all thirty agents would cost far
 * more than it buys, since an ambient agent never retrieves anything.
 */

import type { Client } from '../database/db.ts';
import { BELIEF, GOSSIP, TENSION } from '../core/config.ts';
import { RUMOR_HEAT_DECAY, decayAt } from '../simulation/decay.ts';
import { SCALE, clampSigned, clampUnit, fpMul, type Fixed } from '../core/fixedpoint.ts';
import { recordBelief, shiftConfidence, type FactionAlignment } from './beliefs.ts';
import type { Rng } from '../core/rng.ts';
import type { Seq } from '../core/seq.ts';
import type { InferenceClient } from '../inference/index.ts';

export interface GossipContext {
  worldId: string;
  tick: number;
  rng: Rng;
  seq: Seq;
  inference: InferenceClient;
  /** Set false to skip reworded retellings, e.g. when the budget is spent. */
  allowDistortion?: boolean | undefined;
}

export interface Transmission {
  rumorId: string;
  claimId: string;
  fromAgentKey: string;
  toAgentKey: string;
  text: string;
  distorted: boolean;
  confidenceBefore: Fixed;
  confidenceAfter: Fixed;
  crossFaction: boolean;
}

export interface GossipResult {
  transmissions: Transmission[];
  /** Tension generated this tick, to be applied by the escalation step. */
  tensionDelta: Fixed;
  /**
   * The same tension, attributed to the faction the claims were about, by
   * faction id. Heat lands on the House being accused, which is what lets one
   * House be dragged toward war while the other stays comparatively calm.
   */
  factionDelta: Map<string, Fixed>;
  rumorsConsidered: number;
  distortions: number;
}

interface RumorRow {
  rumor_id: string;
  claim_id: string;
  heat: number;
  valence: number;
  updated_tick: number;
  claim_text: string;
  severity: number;
  subject_agent_id: string;
  subject_faction_id: string;
  kind: 'fact' | 'interpretation' | 'accusation';
}

interface HolderRow {
  agent_id: string;
  agent_key: string;
  location_id: string;
  faction_id: string;
  talkativeness: number;
  distorted_text: string;
}

interface ListenerRow {
  agent_id: string;
  agent_key: string;
  location_id: string;
  faction_id: string;
  credulity: number;
  trust: number;
  sentiment: number;
  confidence: number | null;
}

/**
 * Advance every hot rumor by one tick.
 *
 * Ordering is explicit at every step — rumors by id, holders by key, listeners
 * by key — because the RNG is consumed in iteration order and any instability
 * there would break replay.
 */
export async function runGossip(
  client: Client,
  ctx: GossipContext,
): Promise<GossipResult> {
  const rumors = await loadHotRumors(client, ctx.worldId);
  const transmissions: Transmission[] = [];
  const factionDelta = new Map<string, Fixed>();
  let tensionDelta = 0;
  let distortions = 0;

  const attribute = (factionId: string, amount: Fixed): void => {
    if (amount === 0) return;
    factionDelta.set(factionId, (factionDelta.get(factionId) ?? 0) + amount);
  };

  for (const rumor of rumors) {
    // Heat decays from when the rumor was last stirred, not from creation, so
    // a rumor that keeps being retold stays alive.
    const elapsed = Math.max(0, ctx.tick - rumor.updated_tick);
    const heat = clampUnit(fpMul(rumor.heat, decayAt(RUMOR_HEAT_DECAY, elapsed)));

    if (heat < GOSSIP.minHeat) {
      await client.query(
        `UPDATE world_rumors SET heat = $3, updated_tick = $4
          WHERE world_id = $1 AND rumor_id = $2`,
        [ctx.worldId, rumor.rumor_id, heat, ctx.tick],
      );
      continue;
    }

    const holders = await loadHolders(client, ctx.worldId, rumor.rumor_id);
    for (const holder of holders) {
      if (transmissions.length >= GOSSIP.maxTransmissionsPerTick) break;

      const listeners = await loadListeners(
        client, ctx.worldId, rumor.claim_id, holder.agent_id, ctx.tick,
      );

      for (const listener of listeners) {
        if (transmissions.length >= GOSSIP.maxTransmissionsPerTick) break;

        const colocated = listener.location_id === holder.location_id;
        const probability = transmissionChance({
          heat,
          talkativeness: holder.talkativeness,
          trust: listener.trust,
          colocated,
        });

        if (!ctx.rng.chance(probability)) continue;

        // Reword occasionally. This is deterministic rule logic because gossip
        // runs inside the retryable tick transaction. A provider call here could
        // be repeated, re-billed, or return different durable text on retry.
        let text = holder.distorted_text || rumor.claim_text;
        let distorted = false;
        if ((ctx.allowDistortion ?? true) && ctx.rng.chance(GOSSIP.distortionChance)) {
          text = deterministicDistortion(text, ctx.rng);
          distorted = true;
          distortions++;
        }

        const alignment = rumor.kind === 'fact'
          ? 'rival'
          : alignmentOf(listener.faction_id, rumor.subject_faction_id);
        const confidenceBefore = listener.confidence ?? 0;
        const confidenceAfter = shiftConfidence({
          current: confidenceBefore,
          credulity: listener.credulity,
          trust: listener.trust,
          heat,
          alignment,
          direction: rumor.kind === 'accusation' && alignment === 'same'
            ? 'deny' : 'believe',
        });

        // First contact is recorded once and never rewritten — this table is
        // the history of who was told, in the wording that reached them.
        // Hearing it again shows up as another belief update, not as an edit.
        await client.query(
          `INSERT INTO world_rumor_spread
             (world_id, rumor_id, agent_id, received_tick, distorted_text, from_agent_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (world_id, rumor_id, agent_id) DO NOTHING`,
          [ctx.worldId, rumor.rumor_id, listener.agent_id, ctx.tick, text, holder.agent_id],
        );

        await recordTelling(client, {
          worldId: ctx.worldId,
          rumorId: rumor.rumor_id,
          claimId: rumor.claim_id,
          fromAgentId: holder.agent_id,
          toAgentId: listener.agent_id,
          tick: ctx.tick,
          seq: ctx.seq.next(),
          channel: 'gossip',
        });

        await recordBelief(client, {
          worldId: ctx.worldId,
          agentId: listener.agent_id,
          claimId: rumor.claim_id,
          tick: ctx.tick,
          seq: ctx.seq.next(),
          confidence: confidenceAfter,
        });

        // Believing something bad about someone sours the listener toward them,
        // but only in proportion to how far they actually believe it.
        if (rumor.kind === 'accusation') {
          await applySentimentShift(client, {
            worldId: ctx.worldId,
            tick: ctx.tick,
            srcAgentId: listener.agent_id,
            dstAgentId: rumor.subject_agent_id,
            currentSentiment: listener.sentiment,
            valence: rumor.valence,
            confidence: confidenceAfter,
          });
        }

        const crossFaction =
          alignment === 'rival' && listener.faction_id !== rumor.subject_faction_id;

        // Tension comes from a hostile claim crossing the line between the two
        // houses, and again when a listener's belief first becomes actionable.
        if (rumor.kind === 'accusation' && crossFaction && rumor.valence < 0) {
          const rise = fpMul(TENSION.crossFactionAccusation, rumor.severity);
          tensionDelta += rise;
          attribute(rumor.subject_faction_id, rise);
        }
        if (rumor.kind === 'accusation' &&
          confidenceBefore < BELIEF.actionableConfidence &&
          confidenceAfter >= BELIEF.actionableConfidence
        ) {
          const rise = fpMul(TENSION.beliefHardens, rumor.severity);
          tensionDelta += rise;
          attribute(rumor.subject_faction_id, rise);
        }

        transmissions.push({
          rumorId: rumor.rumor_id,
          claimId: rumor.claim_id,
          fromAgentKey: holder.agent_key,
          toAgentKey: listener.agent_key,
          text,
          distorted,
          confidenceBefore,
          confidenceAfter,
          crossFaction,
        });
      }
    }

    // Retelling keeps a rumor warm; silence lets it cool.
    const spread = transmissions.filter((t) => t.rumorId === rumor.rumor_id).length;
    const refreshed = spread > 0 ? clampUnit(heat + fpMul(heat, SCALE / 10)) : heat;
    await client.query(
      `UPDATE world_rumors SET heat = $3, updated_tick = $4
        WHERE world_id = $1 AND rumor_id = $2`,
      [ctx.worldId, rumor.rumor_id, refreshed, ctx.tick],
    );
  }

  return {
    transmissions,
    tensionDelta: clampUnit(tensionDelta),
    factionDelta,
    rumorsConsidered: rumors.length,
    distortions,
  };
}

const DISTORTION_HEDGES = [
  'They say ', 'Word is ', 'I heard tell that ', 'Some are saying ',
] as const;

/** Extractive only: wording changes, facts and named entities cannot be added. */
export function deterministicDistortion(text: string, rng: Rng): string {
  const source = text.trim();
  if (!source) return source;
  const truncated = source.length > 180
    ? `${source.slice(0, 177).trimEnd()}...`
    : source;
  return `${rng.pick(DISTORTION_HEDGES)}${truncated.charAt(0).toLowerCase()}${truncated.slice(1)}`;
}

export interface RumorOriginator {
  agentId: string;
  agentKey: string;
  claimText: string;
}

/**
 * Who starts telling a claim that the rules (not a person) introduced.
 *
 * Trigger-seeded rumors and the opening event both need a first mouth, and it
 * has to be chosen by a rule rather than at random, because it decides where in
 * the town the story begins. The talkative go first, the subject of the claim is
 * never their own accuser, and ties break on agent_key so the choice replays.
 *
 * `skip` lets a caller take the second- or third-most talkative teller instead,
 * which is how several opening rumors start in different corners of town rather
 * than all in one mouth.
 */
export async function pickRumorOriginator(
  client: Client,
  worldId: string,
  claimId: string,
  skip = 0,
): Promise<RumorOriginator | null> {
  const result = await client.query<{
    agent_id: string; agent_key: string; claim_text: string;
  }>(
    `SELECT a.agent_id, a.agent_key, c.text AS claim_text
       FROM world_claims c
       JOIN world_agents a
         ON a.world_id = c.world_id
        AND a.agent_id != c.subject_agent_id
        AND a.status = 'alive'
      WHERE c.world_id = $1 AND c.claim_id = $2
      ORDER BY a.talkativeness DESC, a.agent_key
      LIMIT 1 OFFSET $3`,
    [worldId, claimId, skip],
  );
  const row = result.rows[0];
  return row
    ? { agentId: row.agent_id, agentKey: row.agent_key, claimText: row.claim_text }
    : null;
}

export function transmissionChance(input: {
  heat: Fixed;
  talkativeness: Fixed;
  trust: Fixed;
  colocated: boolean;
}): Fixed {
  if (input.trust < GOSSIP.minTrustToTransmit) return 0;

  const base = fpMul(GOSSIP.baseTransmission, input.heat);
  const social = fpMul(base, input.talkativeness);
  const proximity = input.colocated ? SCALE : GOSSIP.remoteTransmissionFactor;
  return clampUnit(fpMul(social, proximity));
}

export function alignmentOf(
  listenerFactionId: string,
  subjectFactionId: string,
): FactionAlignment {
  return listenerFactionId === subjectFactionId ? 'same' : 'rival';
}

async function applySentimentShift(
  client: Client,
  input: {
    worldId: string; tick: number; srcAgentId: string; dstAgentId: string;
    currentSentiment: Fixed; valence: Fixed; confidence: Fixed;
  },
): Promise<void> {
  // An agent has no relationship edge with themselves, and a rumor can be about
  // its own listener.
  if (input.srcAgentId === input.dstAgentId) return;

  const believedFraction = clampUnit(Math.max(0, input.confidence));
  const delta = fpMul(fpMul(input.valence, believedFraction), BELIEF.sentimentTransfer);
  if (delta === 0) return;

  await client.query(
    `UPDATE world_relationships
        SET sentiment = $4, updated_tick = $5
      WHERE world_id = $1 AND src_agent_id = $2 AND dst_agent_id = $3`,
    [
      input.worldId, input.srcAgentId, input.dstAgentId,
      clampSigned(input.currentSentiment + delta), input.tick,
    ],
  );
}

// ---------------------------------------------------------------------------
// Loads. Every one is explicitly ordered — the RNG is consumed in iteration
// order, so unstable ordering would break replay.
// ---------------------------------------------------------------------------

async function loadHotRumors(client: Client, worldId: string): Promise<RumorRow[]> {
  const result = await client.query<RumorRow>(
    `SELECT r.rumor_id, r.claim_id, r.heat, r.valence, r.updated_tick,
            c.text AS claim_text, c.severity, c.subject_agent_id, c.kind,
            s.faction_id AS subject_faction_id
       FROM world_rumors r
       JOIN world_claims c ON c.world_id = r.world_id AND c.claim_id = r.claim_id
       JOIN world_agents s ON s.world_id = r.world_id AND s.agent_id = c.subject_agent_id
      WHERE r.world_id = $1 AND r.heat >= $2
      -- Ordered by claim_key, never by rumor_id. Rumor ids are random UUIDs, so
      -- ordering on them makes the iteration order — and therefore the order the
      -- seeded generator is consumed in — differ between two worlds built from
      -- the same scenario and seed. That is exactly what the determinism
      -- contract forbids, and it is invisible until a second rumor is in play.
      ORDER BY r.heat DESC, c.claim_key`,
    [worldId, GOSSIP.minHeat],
  );
  return result.rows;
}

/**
 * Who is doing the telling. The talkative go first, and only so many of them —
 * see GOSSIP.maxTellersPerRumor.
 */
async function loadHolders(
  client: Client, worldId: string, rumorId: string,
): Promise<HolderRow[]> {
  const result = await client.query<HolderRow>(
    `SELECT a.agent_id, a.agent_key, a.location_id, a.faction_id, a.talkativeness,
            s.distorted_text
       FROM world_rumor_spread s
       JOIN world_agents a ON a.world_id = s.world_id AND a.agent_id = s.agent_id
       JOIN world_claims c ON c.world_id = s.world_id AND c.claim_id = (
         SELECT claim_id FROM world_rumors
          WHERE world_id = s.world_id AND rumor_id = s.rumor_id
       )
       LEFT JOIN agent_beliefs b
         ON b.world_id = s.world_id AND b.agent_id = s.agent_id AND b.claim_id = c.claim_id
      WHERE s.world_id = $1 AND s.rumor_id = $2
        AND a.status = 'alive'
        AND (c.authored OR COALESCE(b.confidence, 0) >= $4)
      ORDER BY a.talkativeness DESC, a.agent_key
      LIMIT $3`,
    [worldId, rumorId, GOSSIP.maxTellersPerRumor, GOSSIP.playerRumorMinConfidenceToTransmit],
  );
  return result.rows;
}

/**
 * Everyone who could hear this rumor from this holder right now.
 *
 * Two kinds of listener: someone who has never heard it, and someone who has
 * not heard it *lately*. The second kind is what makes belief harden — a single
 * exposure moves a person a fraction of the way toward believing, and a town
 * where nobody is ever told anything twice never convinces itself of anything.
 *
 * "Lately" is measured against the last belief update for that claim rather
 * than against the spread row, because `world_rumor_spread` is append-only
 * history of first contact and must not be rewritten every time someone brings
 * the subject up again.
 *
 * Co-located listeners are the common case; the rest are reachable only through
 * the much weaker remote factor, representing word travelling indirectly.
 */
async function loadListeners(
  client: Client, worldId: string, claimId: string,
  holderId: string, tick: number,
): Promise<ListenerRow[]> {
  const result = await client.query<ListenerRow>(
    `SELECT a.agent_id, a.agent_key, a.location_id, a.faction_id, a.credulity,
            COALESCE(r.trust, 5000) AS trust,
            COALESCE(r.sentiment, 0) AS sentiment,
            b.confidence
       FROM world_agents a
       LEFT JOIN world_relationships r
              ON r.world_id = a.world_id
             AND r.src_agent_id = a.agent_id
             AND r.dst_agent_id = $2
       LEFT JOIN agent_beliefs b
              ON b.world_id = a.world_id
             AND b.agent_id = a.agent_id
             AND b.claim_id = $3
      WHERE a.world_id = $1
        AND a.agent_id != $2
        AND a.status = 'alive'
        AND (b.updated_tick IS NULL OR b.updated_tick <= $4)
      ORDER BY a.agent_key`,
    // The cutoff is computed here rather than as "$tick - $cooldown" in SQL:
    // with two placeholders either side of the subtraction the planner cannot
    // infer their type and rejects the statement.
    [worldId, holderId, claimId, tick - GOSSIP.retellCooldown],
  );
  return result.rows;
}

/**
 * Seed a rumor into the world and give its originator immediate belief in it.
 *
 * Used by the opening event and by the player's accusations. A rumor nobody
 * holds cannot spread, so seeding without an originator is a silent no-op —
 * hence originator is required rather than optional.
 */
export async function seedRumor(
  client: Client,
  input: {
    worldId: string;
    tick: number;
    seq: Seq;
    claimId: string;
    originAgentId: string;
    heat: Fixed;
    valence: Fixed;
    text: string;
    originEventId?: string | null;
    channel?: TellingChannel;
    fromAgentId?: string | null;
    fromPlayerId?: string | null;
    initialConfidence?: Fixed;
  },
): Promise<string> {
  const existing = await client.query<{ rumor_id: string; heat: number }>(
    `SELECT rumor_id, heat FROM world_rumors
      WHERE world_id = $1 AND claim_id = $2
      ORDER BY rumor_id LIMIT 1`,
    [input.worldId, input.claimId],
  );

  // Repeating a claim reheats the existing rumor rather than forking a rival
  // copy, which would let one claim spread at several independent temperatures.
  const rumorId = existing.rows[0]
    ? await reheat(client, input.worldId, existing.rows[0].rumor_id,
        clampUnit(Math.max(existing.rows[0].heat, input.heat)), input.tick)
    : (await client.query<{ rumor_id: string }>(
        `INSERT INTO world_rumors
           (world_id, claim_id, origin_event_id, heat, valence, created_tick, updated_tick)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING rumor_id`,
        [input.worldId, input.claimId, input.originEventId ?? null,
         clampUnit(input.heat), clampSigned(input.valence), input.tick],
      )).rows[0]!.rumor_id;

  await client.query(
    `INSERT INTO world_rumor_spread
       (world_id, rumor_id, agent_id, received_tick, distorted_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (world_id, rumor_id, agent_id) DO NOTHING`,
    [input.worldId, rumorId, input.originAgentId, input.tick, input.text],
  );

  await recordTelling(client, {
    worldId: input.worldId,
    rumorId,
    claimId: input.claimId,
    fromAgentId: input.fromAgentId ?? null,
    fromPlayerId: input.fromPlayerId ?? null,
    toAgentId: input.originAgentId,
    eventId: input.originEventId ?? null,
    tick: input.tick,
    seq: input.seq.next(),
    channel: input.channel ?? 'gossip',
  });

  await recordBelief(client, {
    worldId: input.worldId,
    agentId: input.originAgentId,
    claimId: input.claimId,
    tick: input.tick,
    seq: input.seq.next(),
    confidence: clampSigned(input.initialConfidence ?? clampUnit(input.heat)),
    causeEventId: input.originEventId ?? null,
  });

  return rumorId;
}

export type TellingChannel = 'gossip' | 'dialogue' | 'accusation' | 'player';

export async function recordTelling(
  client: Client,
  input: {
    worldId: string;
    rumorId: string;
    claimId: string;
    fromAgentId: string | null;
    fromPlayerId?: string | null;
    toAgentId: string;
    eventId?: string | null;
    tick: number;
    seq: number;
    channel: TellingChannel;
  },
): Promise<string> {
  const row = await client.query<{ telling_id: string }>(
    `INSERT INTO world_rumor_tellings
       (world_id, rumor_id, claim_id, from_agent_id, from_player_id,
        to_agent_id, event_id, tick, seq, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING telling_id`,
    [
      input.worldId,
      input.rumorId,
      input.claimId,
      input.fromAgentId,
      input.fromPlayerId ?? null,
      input.toAgentId,
      input.eventId ?? null,
      input.tick,
      input.seq,
      input.channel,
    ],
  );
  return row.rows[0]!.telling_id;
}

async function reheat(
  client: Client, worldId: string, rumorId: string, heat: Fixed, tick: number,
): Promise<string> {
  await client.query(
    `UPDATE world_rumors SET heat = $3, updated_tick = $4
      WHERE world_id = $1 AND rumor_id = $2`,
    [worldId, rumorId, heat, tick],
  );
  return rumorId;
}
