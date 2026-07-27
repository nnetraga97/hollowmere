import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  instantiateWorld, logInfo, pauseSessionWorld, query, queueTimeScale, resumeSessionWorld,
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
      const changed = await pauseSessionWorld(ref);
      logInfo('world_pause_requested', { worldId: ref.worldId, changed });
      return NextResponse.json({ changed });
    }
    if (body.action === 'resume') {
      const changed = await resumeSessionWorld(ref);
      logInfo('world_resume_requested', { worldId: ref.worldId, changed });
      return NextResponse.json({ changed });
    }
    if (body.action === 'timeScale') {
      const result = await queueTimeScale(ref, body.value, body.idempotencyKey);
      logInfo('world_time_scale_queued', {
        worldId: ref.worldId,
        timeScale: body.value,
        replayed: result.replayed,
      });
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === 'restart') {
      const versions = await query<{
        scenario_version_id: string; seed: number; player_name: string;
        profile: { background?: string; sympathyFactionKey?: string | null };
      }>(
        `SELECT w.scenario_version_id, w.seed, p.name AS player_name, p.profile
           FROM worlds w
           JOIN world_players p ON p.world_id = w.world_id AND p.session_id = $2
          WHERE w.world_id = $1`,
        [ref.worldId, ref.sessionId],
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
        playerName: versions[0].player_name,
        playerProfile: {
          background: versions[0].profile?.background ?? '',
          sympathyFactionKey: versions[0].profile?.sympathyFactionKey ?? null,
        },
      });
      const next = { sessionId: ref.sessionId, worldId: created.worldId };
      await writeSession(next);
      logInfo('world_restarted', {
        previousWorldId: ref.worldId,
        worldId: created.worldId,
        seed,
      });
      return NextResponse.json({ worldId: created.worldId, seed }, { status: 201 });
    }
    throw new Error('unknown control action');
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/control' });
  }
}
