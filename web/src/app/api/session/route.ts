import { randomInt, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  assertSession, errorLogFields, getGameSnapshot, getTownMap, instantiateWorld, logInfo,
  isInferenceProfileEnabled, isSelectableInferenceProfile, logWarn, query,
  resumeSessionWorld, setPlayerProfile, upgradeLegacyWorldInferenceProfile,
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
}

const FACTION_KEYS = new Set(['aldreth', 'corvane', 'unaligned']);

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
      try {
        const owned = await assertSession(existing);
        if (profileProvided) await setPlayerProfile(existing, playerName, playerProfile);
        const inferenceProfileUpgraded = inferenceProfile
          ? await upgradeLegacyWorldInferenceProfile(existing, inferenceProfile)
          : false;
        if (owned.worldStatus === 'paused') await resumeSessionWorld(existing);
        logInfo('session_reused', {
          worldId: existing.worldId,
          profileUpdated: profileProvided,
          inferenceProfileUpgraded,
          resumed: owned.worldStatus === 'paused',
        });
        return NextResponse.json({
          session: { worldId: existing.worldId },
          map: await getTownMap(existing),
          game: await getGameSnapshot(existing),
        }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
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
    const seed = Number.isSafeInteger(body.seed) ? Math.trunc(body.seed as number) : randomInt(1, 2_147_483_647);
    const scenarioVersion = process.env.SCENARIO_VERSION ?? 'hollowmere-v5';
    const versions = await query<{ scenario_version_id: string }>(
      `SELECT scenario_version_id FROM scenario_versions WHERE version = $1`, [scenarioVersion],
    );
    if (!versions[0]) throw new Error(`scenario ${scenarioVersion} has not been published`);
    const sessionId = randomUUID();
    const created = await instantiateWorld({
      scenarioVersionId: versions[0].scenario_version_id,
      seed,
      sessionId,
      playerName,
      playerProfile,
      inferenceProfile,
    });
    const ref = { sessionId, worldId: created.worldId };
    await writeSession(ref);
    logInfo('session_created', {
      worldId: ref.worldId,
      seed,
      scenarioVersion,
      inferenceProfile,
    });
    return NextResponse.json({
      session: { worldId: ref.worldId },
      map: await getTownMap(ref),
      game: await getGameSnapshot(ref),
    }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/session' });
  }
}
