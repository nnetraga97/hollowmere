import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  instantiateWorld, pauseSessionWorld, query, queueTimeScale, resumeSessionWorld,
} from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';
import { writeSession } from '@/server/session';

export const runtime = 'nodejs';

type ControlBody =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'timeScale'; value: number; idempotencyKey: string }
  | { action: 'restart'; seed?: number };

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const ref = await requireSession();
    const body = await jsonBody<ControlBody>(request);
    if (body.action === 'pause') {
      return NextResponse.json({ changed: await pauseSessionWorld(ref) });
    }
    if (body.action === 'resume') {
      return NextResponse.json({ changed: await resumeSessionWorld(ref) });
    }
    if (body.action === 'timeScale') {
      return NextResponse.json(await queueTimeScale(ref, body.value, body.idempotencyKey), { status: 202 });
    }
    if (body.action === 'restart') {
      const versions = await query<{ scenario_version_id: string; seed: number }>(
        `SELECT scenario_version_id, seed FROM worlds WHERE world_id = $1`, [ref.worldId],
      );
      if (!versions[0]) throw new Error('world no longer exists');
      await pauseSessionWorld(ref);
      const seed = Number.isSafeInteger(body.seed)
        ? Math.trunc(body.seed as number)
        : randomInt(1, 2_147_483_647);
      const created = await instantiateWorld({
        scenarioVersionId: versions[0].scenario_version_id,
        seed,
        sessionId: ref.sessionId,
      });
      const next = { sessionId: ref.sessionId, worldId: created.worldId };
      await writeSession(next);
      return NextResponse.json({ worldId: created.worldId, seed }, { status: 201 });
    }
    throw new Error('unknown control action');
  } catch (error) {
    return routeError(error);
  }
}
