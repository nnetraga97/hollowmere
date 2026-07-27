/** Durable, branching romance scenes and their simulation effects. */

import { query, withSerializable, type Client } from './db.ts';
import { stableId } from './ids.ts';
import {
  ROMANCE_AGENT_KEYS, epilogueFor, isCrisisStage, romanceCandidate,
  romanceStatusAfterChoice, type RomanceCandidateDef, type RomanceChoiceDef,
  type RomanceProfile, type RomanceStatus,
} from './romance-content.ts';

const ROMANCE_EVENT_SEQ_BASE = 4_000_000;
const ROMANCE_EVENT_SEQ_STRIDE = 16;

export interface RomanceRef { worldId: string; sessionId: string }

export interface RomanceMomentView {
  sceneKey: string;
  chapter: number;
  chapterCount: number;
  title: string;
  kicker: string;
  setting: string;
  narration: string;
  callbacks: string[];
  opening: string;
  choices: { key: string; label: string; intent: string }[];
}

export interface RomanceHistoryView {
  tick: number;
  sceneKey: string;
  title: string;
  choiceKey: string;
  choiceLabel: string;
  response: string;
  aftermath: string;
  statusAfter: RomanceStatus;
  revealedClaimKeys: string[];
}

export interface RomanceArcView {
  agentKey: string;
  name: string;
  shortName: string;
  factionKey: string;
  agentStatus: string;
  agentLocationKey: string;
  routeTitle: string;
  profile: RomanceProfile;
  stage: number;
  chapterCount: number;
  status: RomanceStatus;
  bond: { trust: number; affinity: number; fear: number; respect: number };
  flags: string[];
  revealedClaimKeys: string[];
  history: RomanceHistoryView[];
  available: boolean;
  availabilityReason: string | null;
  moment: RomanceMomentView | null;
  epilogue: string;
}

export interface RomanceChoiceResult {
  eventId: string;
  replayed: boolean;
  agentKey: string;
  sceneKey: string;
  choiceKey: string;
  response: string;
  aftermath: string;
  effectSummary: string[];
  arc: RomanceArcView;
}

interface ArcRow {
  agent_id: string;
  agent_key: string;
  agent_name: string;
  faction_key: string;
  agent_status: string;
  agent_location_key: string;
  agent_location_name: string;
  player_id: string;
  player_name: string;
  player_location_key: string;
  player_location_name: string;
  world_status: string;
  ending: string | null;
  current_tick: number;
  day: number;
  phase: string;
  escalation_stage: string;
  trust: number;
  affinity: number;
  fear: number;
  respect: number;
  stage: number | null;
  romance_status: RomanceStatus | null;
  last_event_tick: number | null;
  move_pending: boolean;
  conversation_open: boolean;
}

interface EventRow {
  agent_key: string;
  romance_event_id: string;
  tick: number;
  scene_key: string;
  choice_key: string;
  response: string;
  aftermath: string;
  status_after: RomanceStatus;
  revealed_claim_keys: unknown;
}

export async function getRomanceArcs(ref: RomanceRef): Promise<RomanceArcView[]> {
  const rows = await query<ArcRow>(
    `SELECT a.agent_id, a.agent_key, a.name AS agent_name, f.faction_key,
            a.status AS agent_status, agent_location.location_key AS agent_location_key,
            agent_location.name AS agent_location_name,
            p.player_id, p.name AS player_name, player_location.location_key AS player_location_key,
            player_location.name AS player_location_name,
            w.status AS world_status, w.ending, w.current_tick,
            state.day, state.phase, state.escalation_stage,
            relationship.trust, relationship.affinity, relationship.fear, relationship.respect,
            arc.stage, arc.status AS romance_status, arc.last_event_tick,
            EXISTS (
              SELECT 1 FROM world_commands move
               WHERE move.world_id = w.world_id AND move.kind = 'move_player'
                 AND move.applied_tick IS NULL
                 AND move.payload->>'playerId' = p.player_id::STRING
            ) AS move_pending,
            EXISTS (
              SELECT 1 FROM world_conversation_sessions conversation
               WHERE conversation.world_id = w.world_id AND conversation.player_id = p.player_id
                 AND conversation.status IN ('open', 'closing')
            ) AS conversation_open
       FROM world_players p
       JOIN worlds w ON w.world_id = p.world_id
       JOIN world_state state ON state.world_id = w.world_id
       JOIN world_locations player_location
         ON player_location.world_id = p.world_id AND player_location.location_id = p.location_id
       JOIN world_agents a ON a.world_id = p.world_id AND a.agent_key = ANY($3::STRING[])
       JOIN world_locations agent_location
         ON agent_location.world_id = a.world_id AND agent_location.location_id = a.location_id
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
       JOIN player_agent_relationships relationship
         ON relationship.world_id = p.world_id AND relationship.player_id = p.player_id
        AND relationship.agent_id = a.agent_id
       LEFT JOIN player_romance_arcs arc
         ON arc.world_id = p.world_id AND arc.player_id = p.player_id AND arc.agent_id = a.agent_id
      WHERE p.world_id = $1 AND p.session_id = $2
      ORDER BY a.agent_key`,
    [ref.worldId, ref.sessionId, [...ROMANCE_AGENT_KEYS]],
  );
  if (!rows.length) {
    const ownsWorld = await query<{ owns_world: boolean }>(
      `SELECT true AS owns_world FROM world_players WHERE world_id = $1 AND session_id = $2`,
      [ref.worldId, ref.sessionId],
    );
    if (!ownsWorld[0]) throw new Error('session does not own this world');
  }

  const [flags, events] = await Promise.all([
    query<{ agent_key: string; flag_key: string }>(
      `SELECT a.agent_key, flag.flag_key
         FROM player_romance_flags flag
         JOIN world_players p
           ON p.world_id = flag.world_id AND p.player_id = flag.player_id
         JOIN world_agents a
           ON a.world_id = flag.world_id AND a.agent_id = flag.agent_id
        WHERE flag.world_id = $1 AND p.session_id = $2
        ORDER BY a.agent_key, flag.gained_tick, flag.flag_key`,
      [ref.worldId, ref.sessionId],
    ),
    query<EventRow>(
      `SELECT a.agent_key, event.romance_event_id, event.tick, event.scene_key,
              event.choice_key, event.response, event.aftermath, event.status_after,
              event.revealed_claim_keys
         FROM player_romance_events event
         JOIN world_players p
           ON p.world_id = event.world_id AND p.player_id = event.player_id
         JOIN world_agents a
           ON a.world_id = event.world_id AND a.agent_id = event.agent_id
        WHERE event.world_id = $1 AND p.session_id = $2
        ORDER BY event.command_seq`,
      [ref.worldId, ref.sessionId],
    ),
  ]);

  return rows.map((row) => buildArcView(
    row,
    flags.filter((flag) => flag.agent_key === row.agent_key).map((flag) => flag.flag_key),
    events.filter((event) => event.agent_key === row.agent_key),
  ));
}

export async function chooseRomanceMoment(input: RomanceRef & {
  agentKey: string;
  sceneKey: string;
  choiceKey: string;
  locationKey: string;
  idempotencyKey: string;
}): Promise<RomanceChoiceResult> {
  const candidate = romanceCandidate(input.agentKey);
  if (!candidate) throw new Error(`${input.agentKey} is not a romance route`);
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new Error('a valid idempotency key is required');
  }

  const { value } = await withSerializable(async (client) => {
    const prior = await priorChoice(client, input.worldId, input.idempotencyKey);
    if (prior) return { ...prior, replayed: true };

    const context = await loadChoiceContext(client, input, candidate);
    const stage = context.stage ?? 0;
    const status = context.romance_status ?? 'open';
    const scene = candidate.scenes[stage];
    if (!scene || scene.key !== input.sceneKey) throw new Error('that relationship moment is no longer current');
    const choice = scene.choices.find((item) => item.key === input.choiceKey);
    if (!choice) throw new Error('unknown relationship choice');
    if (!['active', 'paused'].includes(context.world_status)) throw new Error('this story has already ended');
    if (!['alive', 'injured'].includes(context.agent_status)) throw new Error(`${candidate.shortName} is unavailable`);
    if (context.player_location_key !== input.locationKey) throw new Error('the player has left this location');
    if (context.move_pending) throw new Error('the player is travelling');
    if (context.conversation_open) throw new Error('finish the current conversation first');
    if (context.last_event_tick !== null && context.last_event_tick >= context.current_tick) {
      throw new Error('let the town move forward before seeking another private moment');
    }
    assertMinimum(context, scene.minimum, candidate.shortName);

    const flagRows = await client.query<{ flag_key: string }>(
      `SELECT flag_key FROM player_romance_flags
        WHERE world_id = $1 AND player_id = $2 AND agent_id = $3`,
      [input.worldId, context.player_id, context.agent_id],
    );
    const flags = new Set(flagRows.rows.map((row) => row.flag_key));
    const crisis = isCrisisStage(context.escalation_stage);
    const response = crisis && choice.crisisResponse ? choice.crisisResponse : choice.response;
    const nextStage = stage + 1;
    const statusAfter = romanceStatusAfterChoice(status, choice, nextStage);
    const sequence = await client.query<{ command_seq: number }>(
      `UPDATE worlds
          SET command_seq = command_seq + 1, time_debt_ticks = time_debt_ticks + 1,
              last_activity_at = now()
        WHERE world_id = $1 AND status IN ('active', 'paused')
        RETURNING command_seq`, [input.worldId],
    );
    const commandSeq = sequence.rows[0]?.command_seq;
    if (commandSeq === undefined) throw new Error('world is unavailable');
    const eventId = stableId(input.worldId, 'romance', commandSeq);
    const revealed = [...(choice.effects.revealClaimKeys ?? [])];

    await client.query(
      `INSERT INTO world_commands
         (world_id, idempotency_key, command_seq, kind, payload, applied_tick)
       VALUES ($1, $2, $3, 'romance_choice', $4, $5)`,
      [input.worldId, input.idempotencyKey, commandSeq, JSON.stringify({
        romanceEventId: eventId, agentKey: input.agentKey,
        sceneKey: input.sceneKey, choiceKey: input.choiceKey,
      }), context.current_tick],
    );
    await client.query(
      `INSERT INTO player_romance_arcs
         (world_id, player_id, agent_id, stage, status, last_event_tick, updated_tick)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (world_id, player_id, agent_id) DO UPDATE SET
         stage = excluded.stage, status = excluded.status,
         last_event_tick = excluded.last_event_tick, updated_tick = excluded.updated_tick`,
      [input.worldId, context.player_id, context.agent_id, nextStage, statusAfter, context.current_tick],
    );
    flags.add(choice.flag);
    await client.query(
      `INSERT INTO player_romance_flags
         (world_id, player_id, agent_id, flag_key, gained_tick)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (world_id, player_id, agent_id, flag_key) DO NOTHING`,
      [input.worldId, context.player_id, context.agent_id, choice.flag, context.current_tick],
    );
    await client.query(
      `INSERT INTO player_romance_events
         (world_id, romance_event_id, player_id, agent_id, tick, seq, command_seq,
          scene_key, choice_key, response, aftermath, impression, status_after,
          revealed_claim_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [input.worldId, eventId, context.player_id, context.agent_id, context.current_tick,
        ROMANCE_EVENT_SEQ_BASE + commandSeq * ROMANCE_EVENT_SEQ_STRIDE,
        commandSeq, scene.key, choice.key, response, choice.aftermath, choice.impression,
        statusAfter, JSON.stringify(revealed)],
    );

    await applyChoiceEffects(client, input.worldId, context, choice, commandSeq);
    const eventSeq = ROMANCE_EVENT_SEQ_BASE + commandSeq * ROMANCE_EVENT_SEQ_STRIDE;
    await client.query(
      `INSERT INTO world_events
         (world_id, event_id, tick, seq, location_id, actor_agent_id, kind, payload, description)
       VALUES ($1, $2, $3, $4, $5, $6, 'player_command', $7, $8)`,
      [input.worldId, stableId(input.worldId, eventId, 'chronicle'), context.current_tick,
        eventSeq, context.player_location_id, context.agent_id,
        JSON.stringify({ romance: true, agentKey: input.agentKey, sceneKey: scene.key,
          choiceKey: choice.key, revealedClaimKeys: revealed }),
        `${candidate.name} and ${context.player_name}: ${choice.aftermath}`],
    );

    return {
      eventId, replayed: false, response, aftermath: choice.aftermath,
      effectSummary: effectSummary(choice), agentKey: candidate.agentKey,
      sceneKey: scene.key, choiceKey: choice.key,
    };
  }, { label: 'romance-choice' });

  const arcs = await getRomanceArcs(input);
  const arc = arcs.find((item) => item.agentKey === input.agentKey);
  if (!arc) throw new Error('relationship arc could not be reloaded');
  return { ...value, arc };
}

async function loadChoiceContext(
  client: Client,
  input: RomanceRef & { agentKey: string },
  _candidate: RomanceCandidateDef,
): Promise<ArcRow & { player_location_id: string }> {
  const result = await client.query<ArcRow & { player_location_id: string }>(
    `SELECT a.agent_id, a.agent_key, a.name AS agent_name, f.faction_key,
            a.status AS agent_status, agent_location.location_key AS agent_location_key,
            agent_location.name AS agent_location_name,
            p.player_id, p.name AS player_name, p.location_id AS player_location_id,
            player_location.location_key AS player_location_key,
            player_location.name AS player_location_name,
            w.status AS world_status, w.ending, w.current_tick,
            state.day, state.phase, state.escalation_stage,
            relationship.trust, relationship.affinity, relationship.fear, relationship.respect,
            arc.stage, arc.status AS romance_status, arc.last_event_tick,
            EXISTS (
              SELECT 1 FROM world_commands move
               WHERE move.world_id = w.world_id AND move.kind = 'move_player'
                 AND move.applied_tick IS NULL
                 AND move.payload->>'playerId' = p.player_id::STRING
            ) AS move_pending,
            EXISTS (
              SELECT 1 FROM world_conversation_sessions conversation
               WHERE conversation.world_id = w.world_id AND conversation.player_id = p.player_id
                 AND conversation.status IN ('open', 'closing')
            ) AS conversation_open
       FROM world_players p
       JOIN worlds w ON w.world_id = p.world_id
       JOIN world_state state ON state.world_id = w.world_id
       JOIN world_locations player_location
         ON player_location.world_id = p.world_id AND player_location.location_id = p.location_id
       JOIN world_agents a ON a.world_id = p.world_id AND a.agent_key = $3
       JOIN world_locations agent_location
         ON agent_location.world_id = a.world_id AND agent_location.location_id = a.location_id
       JOIN world_factions f ON f.world_id = a.world_id AND f.faction_id = a.faction_id
       JOIN player_agent_relationships relationship
         ON relationship.world_id = p.world_id AND relationship.player_id = p.player_id
        AND relationship.agent_id = a.agent_id
       LEFT JOIN player_romance_arcs arc
         ON arc.world_id = p.world_id AND arc.player_id = p.player_id AND arc.agent_id = a.agent_id
      WHERE p.world_id = $1 AND p.session_id = $2
      FOR UPDATE OF w, p, a, relationship`,
    [input.worldId, input.sessionId, input.agentKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error('world, player, or relationship candidate is unavailable');
  return row;
}

async function priorChoice(
  client: Client,
  worldId: string,
  idempotencyKey: string,
): Promise<Omit<RomanceChoiceResult, 'arc' | 'replayed'> | null> {
  const result = await client.query<{
    romance_event_id: string; agent_key: string; scene_key: string; choice_key: string;
    response: string; aftermath: string;
  }>(
    `SELECT event.romance_event_id, agent.agent_key, event.scene_key, event.choice_key,
            event.response, event.aftermath
       FROM world_commands command
       JOIN player_romance_events event
         ON event.world_id = command.world_id
        AND event.romance_event_id = (command.payload->>'romanceEventId')::UUID
       JOIN world_agents agent
         ON agent.world_id = event.world_id AND agent.agent_id = event.agent_id
      WHERE command.world_id = $1 AND command.idempotency_key = $2
        AND command.kind = 'romance_choice'`,
    [worldId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const candidate = romanceCandidate(row.agent_key)!;
  const scene = candidate.scenes.find((item) => item.key === row.scene_key)!;
  const choice = scene.choices.find((item) => item.key === row.choice_key)!;
  return {
    eventId: row.romance_event_id,
    agentKey: row.agent_key,
    sceneKey: row.scene_key,
    choiceKey: row.choice_key,
    response: row.response,
    aftermath: row.aftermath,
    effectSummary: effectSummary(choice),
  };
}

async function applyChoiceEffects(
  client: Client,
  worldId: string,
  context: ArcRow,
  choice: RomanceChoiceDef,
  commandSeq: number,
): Promise<void> {
  const effect = choice.effects;
  await client.query(
    `UPDATE player_agent_relationships
        SET trust = greatest(0, least(10000, trust + $4)),
            affinity = greatest(-10000, least(10000, affinity + $5)),
            fear = greatest(0, least(10000, fear + $6)),
            respect = greatest(-10000, least(10000, respect + $7)),
            impression = $8, updated_tick = $9
      WHERE world_id = $1 AND player_id = $2 AND agent_id = $3`,
    [worldId, context.player_id, context.agent_id, effect.trust, effect.affinity,
      effect.fear ?? 0, effect.respect, choice.impression, context.current_tick],
  );
  await client.query(
    `INSERT INTO player_agent_relationship_updates
       (world_id, update_id, player_id, agent_id, tick, seq, trust_delta,
        affinity_delta, fear_delta, respect_delta, impression)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [worldId, stableId(worldId, 'romance-relationship', commandSeq), context.player_id,
      context.agent_id, context.current_tick,
      ROMANCE_EVENT_SEQ_BASE + commandSeq * ROMANCE_EVENT_SEQ_STRIDE + 1,
      effect.trust, effect.affinity, effect.fear ?? 0, effect.respect, choice.impression],
  );

  if (effect.reputation) {
    await client.query(
      `UPDATE player_reputation reputation
          SET reputation = greatest(-10000, least(10000, reputation.reputation + $4)),
              updated_tick = $5
         FROM world_factions faction
        WHERE reputation.world_id = $1 AND reputation.player_id = $2
          AND faction.world_id = reputation.world_id
          AND faction.faction_id = reputation.faction_id AND faction.faction_key = $3`,
      [worldId, context.player_id, context.faction_key, effect.reputation, context.current_tick],
    );
  }
  if (effect.globalTension) {
    await client.query(
      `UPDATE world_state
          SET global_tension = greatest(0, least(10000, global_tension + $2))
        WHERE world_id = $1`, [worldId, effect.globalTension],
    );
  }
  if (effect.factionTension || effect.negotiation !== undefined) {
    await client.query(
      `UPDATE world_faction_state faction_state
          SET tension = greatest(0, least(10000, tension + $3)),
              willing_to_negotiate = CASE WHEN $4::BOOL IS NULL
                THEN willing_to_negotiate ELSE $4 END,
              updated_tick = $5
         FROM world_factions faction
        WHERE faction_state.world_id = $1
          AND faction.world_id = faction_state.world_id
          AND faction.faction_id = faction_state.faction_id AND faction.faction_key = $2`,
      [worldId, context.faction_key, effect.factionTension ?? 0,
        effect.negotiation ?? null, context.current_tick],
    );
  }
  if (effect.rumorHeat) {
    await client.query(
      `UPDATE world_rumors rumor
          SET heat = greatest(0, least(10000, heat + $3)), updated_tick = $4
         FROM world_claims claim
        WHERE rumor.world_id = $1 AND claim.world_id = rumor.world_id
          AND claim.claim_id = rumor.claim_id AND claim.claim_key = $2`,
      [worldId, effect.rumorHeat.claimKey, effect.rumorHeat.amount, context.current_tick],
    );
  }
}

function buildArcView(row: ArcRow, flags: string[], events: EventRow[]): RomanceArcView {
  const candidate = romanceCandidate(row.agent_key)!;
  const stage = row.stage ?? 0;
  const status = row.romance_status ?? 'open';
  const scene = candidate.scenes[stage] ?? null;
  const availabilityReason = availability(row, scene);
  const history = events.map((event): RomanceHistoryView => {
    const definition = candidate.scenes.find((item) => item.key === event.scene_key);
    const choice = definition?.choices.find((item) => item.key === event.choice_key);
    return {
      tick: event.tick,
      sceneKey: event.scene_key,
      title: definition?.title ?? event.scene_key,
      choiceKey: event.choice_key,
      choiceLabel: choice?.label ?? event.choice_key,
      response: event.response,
      aftermath: event.aftermath,
      statusAfter: event.status_after,
      revealedClaimKeys: stringArray(event.revealed_claim_keys),
    };
  });
  return {
    agentKey: candidate.agentKey,
    name: candidate.name,
    shortName: candidate.shortName,
    factionKey: candidate.factionKey,
    agentStatus: row.agent_status,
    agentLocationKey: row.agent_location_key,
    routeTitle: candidate.profile.routeTitle,
    profile: candidate.profile,
    stage,
    chapterCount: candidate.scenes.length,
    status,
    bond: { trust: row.trust, affinity: row.affinity, fear: row.fear, respect: row.respect },
    flags,
    revealedClaimKeys: [...new Set(history.flatMap((event) => event.revealedClaimKeys))],
    history,
    available: Boolean(scene) && availabilityReason === null,
    availabilityReason,
    moment: scene ? momentView(candidate, scene, row, flags) : null,
    epilogue: epilogueFor(candidate, row.ending, status),
  };
}

function momentView(
  candidate: RomanceCandidateDef,
  scene: RomanceCandidateDef['scenes'][number],
  row: ArcRow,
  flags: readonly string[],
): RomanceMomentView {
  const crisis = isCrisisStage(row.escalation_stage);
  return {
    sceneKey: scene.key,
    chapter: scene.chapter,
    chapterCount: candidate.scenes.length,
    title: scene.title,
    kicker: scene.kicker,
    setting: `Day ${row.day} · ${row.phase} · ${row.player_location_name}`,
    narration: crisis && scene.crisisNarration ? scene.crisisNarration : scene.narration,
    callbacks: (scene.callbacks ?? [])
      .filter((callback) => flags.includes(callback.flag))
      .map((callback) => callback.text),
    opening: crisis && scene.crisisOpening ? scene.crisisOpening : scene.opening,
    choices: scene.choices.map((choice) => ({
      key: choice.key, label: choice.label, intent: choice.intent,
    })),
  };
}

function availability(row: ArcRow, scene: RomanceCandidateDef['scenes'][number] | null): string | null {
  if (!scene) return 'This relationship arc is complete.';
  if (!['active', 'paused'].includes(row.world_status)) return 'The town’s story has ended.';
  if (!['alive', 'injured'].includes(row.agent_status)) return `${row.agent_name} is ${row.agent_status}.`;
  if (row.player_location_key !== row.agent_location_key) return `Meet ${row.agent_name} at ${row.agent_location_name}.`;
  if (row.move_pending) return 'Finish travelling first.';
  if (row.conversation_open) return 'Finish the current conversation first.';
  if (row.last_event_tick !== null && row.last_event_tick >= row.current_tick) {
    return 'Let one world tick pass before the next private moment.';
  }
  const missing: string[] = [];
  if (row.trust < scene.minimum.trust) missing.push(`trust ${formatBond(row.trust)}/${formatBond(scene.minimum.trust)}`);
  if (row.affinity < scene.minimum.affinity) missing.push(`affinity ${formatSignedBond(row.affinity)}/${formatSignedBond(scene.minimum.affinity)}`);
  if (row.respect < scene.minimum.respect) missing.push(`respect ${formatSignedBond(row.respect)}/${formatSignedBond(scene.minimum.respect)}`);
  return missing.length ? `Keep talking with ${row.agent_name}: ${missing.join(' · ')}.` : null;
}

function assertMinimum(
  relationship: Pick<ArcRow, 'trust' | 'affinity' | 'respect'>,
  minimum: { trust: number; affinity: number; respect: number },
  name: string,
): void {
  if (relationship.trust < minimum.trust
    || relationship.affinity < minimum.affinity
    || relationship.respect < minimum.respect) {
    throw new Error(`the bond with ${name} is not ready for this moment`);
  }
}

function effectSummary(choice: RomanceChoiceDef): string[] {
  const effect = choice.effects;
  const values = [
    `${signed(effect.trust)} trust`,
    `${signed(effect.affinity)} affinity`,
    `${signed(effect.respect)} respect`,
  ];
  if (effect.fear) values.push(`${signed(effect.fear)} fear`);
  if (effect.globalTension) values.push(`${signed(effect.globalTension)} town tension`);
  if (effect.factionTension) values.push(`${signed(effect.factionTension)} house tension`);
  if (effect.reputation) values.push(`${signed(effect.reputation)} house reputation`);
  if (effect.rumorHeat) values.push(`${signed(effect.rumorHeat.amount)} “${effect.rumorHeat.claimKey}” heat`);
  if (effect.revealClaimKeys?.length) values.push(`learned: ${effect.revealClaimKeys.join(', ')}`);
  if (effect.negotiation) values.push('opened a path to negotiation');
  return values;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function signed(value: number): string { return `${value >= 0 ? '+' : ''}${(value / 100).toFixed(value % 100 ? 1 : 0)}`; }
function formatBond(value: number): string { return Math.round(value / 100).toString(); }
function formatSignedBond(value: number): string { return `${value >= 0 ? '+' : ''}${Math.round(value / 100)}`; }
