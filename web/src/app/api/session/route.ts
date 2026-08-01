import { randomInt, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  assertSession, errorLogFields, getGameSnapshot, getTownMap, instantiateWorld, logInfo,
  isInferenceProfileEnabled, isSelectableInferenceProfile, logWarn, query,
  deleteSessionWorld, renameSessionWorld, resumeSessionWorld, SessionAccessError, setPlayerProfile, upgradeLegacyWorldInferenceProfile,
} from '@/server/engine';
import type { SelectableInferenceProfile } from '@/server/engine';
import { jsonBody, requireSameOrigin, routeError } from '@/server/http';
import { clearSession, readSession, writeSession } from '@/server/session';

export const runtime = 'nodejs';

interface SessionBody {
  seed?: number;
  playerName?: string;
  background?: string;
  sympathyFactionKey?: string | null;
  inferenceProfile?: SelectableInferenceProfile;
  newWorld?: boolean;
  worldId?: string;
  displayName?: string | null;
}

const FACTION_KEYS = new Set(['aldreth', 'corvane', 'unaligned']);

export async function GET() {
  try {
    const existing = await readSession();
    if (!existing) return NextResponse.json({ worlds: [] });
    await assertSession(existing);
    const worlds = await query<{
      world_id: string; status: string; ending: string | null; current_tick: number;
      day: number; escalation_stage: string; seed: number; display_name: string | null;
      inference_profile: 'stub' | 'azure_sol' | 'azure_terra' | 'bedrock_sonnet';
      created_at: Date;
    }>(
      `SELECT w.world_id, w.status, w.ending, w.current_tick, state.day,
              state.escalation_stage, w.seed, w.display_name, w.inference_profile, w.created_at
         FROM world_players player
         JOIN worlds w ON w.world_id = player.world_id
         JOIN world_state state ON state.world_id = w.world_id
        WHERE player.session_id = $1
        ORDER BY w.created_at DESC`,
      [existing.sessionId],
    );
    return NextResponse.json({
      worlds: worlds.map((world) => ({
        worldId: world.world_id,
        status: world.status,
        ending: world.ending,
        currentTick: world.current_tick,
        day: world.day,
        stage: world.escalation_stage,
        seed: world.seed,
        displayName: world.display_name,
        inferenceProfile: world.inference_profile,
        createdAt: world.created_at.toISOString(),
      })),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof SessionAccessError) {
      await clearSession();
      logWarn('world_list_session_invalidated', errorLogFields(error));
      return NextResponse.json({ worlds: [] }, { headers: { 'cache-control': 'no-store' } });
    }
    return routeError(error, { method: 'GET', route: '/api/session' });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<SessionBody>(request);
    const existing = await readSession();
    if (!existing || typeof body.worldId !== 'string') {
      return Response.json({ error: 'choose a world to rename' }, { status: 400 });
    }
    if (body.displayName !== null && typeof body.displayName !== 'string') {
      return Response.json({ error: 'world name must be text' }, { status: 400 });
    }
    const displayName = typeof body.displayName === 'string'
      ? body.displayName.trim().slice(0, 80) || null
      : null;
    const worldId = body.worldId;
    const name = await renameSessionWorld({ sessionId: existing.sessionId, worldId }, displayName);
    return NextResponse.json({ worldId, displayName: name }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error, { method: 'PATCH', route: '/api/session' });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<SessionBody>(request);
    const existing = await readSession();
    if (!existing || typeof body.worldId !== 'string') {
      return Response.json({ error: 'choose a world to delete' }, { status: 400 });
    }
    const worldId = body.worldId;
    const replacement = existing.worldId === worldId
      ? await query<{ world_id: string }>(
        `SELECT world_id FROM world_players
          WHERE session_id = $1 AND world_id <> $2
          ORDER BY world_id LIMIT 1`,
        [existing.sessionId, worldId],
      )
      : [];
    await deleteSessionWorld({ sessionId: existing.sessionId, worldId });
    if (existing.worldId === worldId) {
      const replacementWorldId = replacement[0]?.world_id;
      if (replacementWorldId) await writeSession({ sessionId: existing.sessionId, worldId: replacementWorldId });
      else await clearSession();
    }
    logInfo('session_world_deleted', { worldId, sessionId: existing.sessionId });
    return NextResponse.json({ deletedWorldId: worldId }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error, { method: 'DELETE', route: '/api/session' });
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<SessionBody>(request).catch((): SessionBody => ({}));
    const profileProvided = typeof body.playerName === 'string'
      || typeof body.background === 'string'
      || body.sympathyFactionKey !== undefined;
    const playerName = typeof body.playerName === 'string' && body.playerName.trim()
      ? body.playerName.trim().slice(0, 60)
      : 'the outsider';
    const playerProfile = {
      background: typeof body.background === 'string' ? body.background.trim().slice(0, 360) : '',
      sympathyFactionKey: typeof body.sympathyFactionKey === 'string'
        && FACTION_KEYS.has(body.sympathyFactionKey) ? body.sympathyFactionKey : null,
    };
    const inferenceProfile = isSelectableInferenceProfile(body.inferenceProfile)
      && isInferenceProfileEnabled(body.inferenceProfile)
      ? body.inferenceProfile
      : null;
    if (body.inferenceProfile !== undefined && !inferenceProfile) {
      return Response.json({ error: 'choose an available inference profile' }, { status: 400 });
    }
    const existing = await readSession();
    if (existing) {
      let existingSessionIsValid = false;
      try {
        await assertSession(existing);
        existingSessionIsValid = true;
        if (body.newWorld) {
          if (!inferenceProfile) {
            return Response.json({ error: 'choose an available inference profile' }, { status: 400 });
          }
          const created = await createWorld(existing.sessionId, {
            seed: body.seed, playerName, playerProfile, inferenceProfile,
          });
          await query(
            `UPDATE worlds SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL
              WHERE world_id IN (SELECT world_id FROM world_players WHERE session_id = $1)
                AND world_id <> $2 AND status = 'active'`,
            [existing.sessionId, created.session.worldId],
          );
          await writeSession({ sessionId: existing.sessionId, worldId: created.session.worldId });
          logInfo('session_world_created', {
            worldId: created.session.worldId,
            previousWorldId: existing.worldId,
            inferenceProfile,
          });
          return NextResponse.json(created, {
            status: 201,
            headers: { 'cache-control': 'no-store' },
          });
        }

        const target = {
          sessionId: existing.sessionId,
          worldId: typeof body.worldId === 'string' ? body.worldId : existing.worldId,
        };
        const owned = await assertSession(target);
        if (target.worldId !== existing.worldId) {
          await query(
            `UPDATE worlds SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL
              WHERE world_id IN (SELECT world_id FROM world_players WHERE session_id = $1)
                AND world_id <> $2 AND status = 'active'`,
            [existing.sessionId, target.worldId],
          );
        }
        if (profileProvided) await setPlayerProfile(target, playerName, playerProfile);
        const inferenceProfileUpgraded = inferenceProfile
          ? await upgradeLegacyWorldInferenceProfile(target, inferenceProfile)
          : false;
        if (owned.worldStatus === 'paused') await resumeSessionWorld(target);
        await writeSession(target);
        logInfo('session_reused', {
          worldId: target.worldId,
          profileUpdated: profileProvided,
          inferenceProfileUpgraded,
          resumed: owned.worldStatus === 'paused',
        });
        return NextResponse.json({
          session: { worldId: target.worldId },
          map: await getTownMap(target),
          game: await getGameSnapshot(target),
        }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (existingSessionIsValid) throw error;
        logWarn('session_cookie_invalidated', {
          worldId: existing.worldId,
          ...errorLogFields(error),
        });
        await clearSession();
      }
    }

    if (!inferenceProfile) {
      return Response.json({ error: 'choose an available inference profile' }, { status: 400 });
    }
    const sessionId = randomUUID();
    const created = await createWorld(sessionId, {
      seed: body.seed, playerName, playerProfile, inferenceProfile,
    });
    const ref = { sessionId, worldId: created.session.worldId };
    await writeSession(ref);
    logInfo('session_created', {
      worldId: ref.worldId,
      seed: created.game.world.seed,
      scenarioVersion: process.env.SCENARIO_VERSION ?? 'hollowmere-v5',
      inferenceProfile,
    });
    return NextResponse.json(created, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/session' });
  }
}

async function createWorld(
  sessionId: string,
  input: {
    seed?: number;
    playerName: string;
    playerProfile: { background: string; sympathyFactionKey: string | null };
    inferenceProfile: SelectableInferenceProfile;
  },
) {
  const seed = Number.isSafeInteger(input.seed)
    ? Math.trunc(input.seed as number)
    : randomInt(1, 2_147_483_647);
  const scenarioVersion = process.env.SCENARIO_VERSION ?? 'hollowmere-v5';
  const versions = await query<{ scenario_version_id: string }>(
    `SELECT scenario_version_id FROM scenario_versions WHERE version = $1`, [scenarioVersion],
  );
  if (!versions[0]) throw new Error(`scenario ${scenarioVersion} has not been published`);
  const created = await instantiateWorld({
    scenarioVersionId: versions[0].scenario_version_id,
    seed,
    sessionId,
    playerName: input.playerName,
    playerProfile: input.playerProfile,
    inferenceProfile: input.inferenceProfile,
  });
  const ref = { sessionId, worldId: created.worldId };
  return {
    session: { worldId: ref.worldId },
    map: await getTownMap(ref),
    game: await getGameSnapshot(ref),
  };
}
