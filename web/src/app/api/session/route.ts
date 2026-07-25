import { randomInt, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  assertSession, getGameSnapshot, getTownMap, instantiateWorld, query, resumeSessionWorld,
} from '@/server/engine';
import { jsonBody, requireSameOrigin, routeError } from '@/server/http';
import { clearSession, readSession, writeSession } from '@/server/session';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const existing = await readSession();
    if (existing) {
      try {
        const owned = await assertSession(existing);
        if (owned.worldStatus === 'paused') await resumeSessionWorld(existing);
        return NextResponse.json({
          session: { worldId: existing.worldId },
          map: await getTownMap(existing),
          game: await getGameSnapshot(existing),
        }, { headers: { 'cache-control': 'no-store' } });
      } catch {
        await clearSession();
      }
    }

    const body: { seed?: number } = await jsonBody<{ seed?: number }>(request).catch(() => ({}));
    const seed = Number.isSafeInteger(body.seed) ? Math.trunc(body.seed as number) : randomInt(1, 2_147_483_647);
    const scenarioVersion = process.env.SCENARIO_VERSION ?? 'hollowmere-v2';
    const versions = await query<{ scenario_version_id: string }>(
      `SELECT scenario_version_id FROM scenario_versions WHERE version = $1`, [scenarioVersion],
    );
    if (!versions[0]) throw new Error(`scenario ${scenarioVersion} has not been published`);
    const sessionId = randomUUID();
    const created = await instantiateWorld({
      scenarioVersionId: versions[0].scenario_version_id,
      seed,
      sessionId,
    });
    const ref = { sessionId, worldId: created.worldId };
    await writeSession(ref);
    return NextResponse.json({
      session: { worldId: ref.worldId },
      map: await getTownMap(ref),
      game: await getGameSnapshot(ref),
    }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return routeError(error);
  }
}
