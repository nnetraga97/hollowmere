import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  endSessionWorld, instantiateWorldOnClient, logInfo, pauseSessionWorld, queueTimeScale,
  resumeSessionWorld, withSerializable,
} from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';
import { writeSession } from '@/server/session';

export const runtime = 'nodejs';

type ControlBody =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'timeScale'; value: number; idempotencyKey: string }
  | { action: 'end' }
  | { action: 'start'; seed?: number };

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
    if (body.action === 'end') {
      const changed = await endSessionWorld(ref);
      logInfo('world_end_requested', { worldId: ref.worldId, changed, ending: 'player_ended' });
      return NextResponse.json({ changed, worldId: ref.worldId });
    }
    if (body.action === 'start') {
      const seed = Number.isSafeInteger(body.seed)
        ? Math.trunc(body.seed as number)
        : randomInt(1, 2_147_483_647);
      const { value: started } = await withSerializable(async (client) => {
        const rows = await client.query<{
          status: string; scenario_version_id: string; player_name: string;
          inference_profile: 'stub' | 'azure_terra' | 'bedrock_sonnet';
          profile: { background?: string; sympathyFactionKey?: string | null };
          successor_world_id: string | null; successor_seed: number | null;
        }>(
          `SELECT w.status, w.scenario_version_id, w.inference_profile,
                  p.name AS player_name, p.profile,
                  successor.successor_world_id, next.seed AS successor_seed
             FROM worlds w
             JOIN world_players p ON p.world_id = w.world_id AND p.session_id = $2
             LEFT JOIN world_successors successor ON successor.previous_world_id = w.world_id
             LEFT JOIN worlds next ON next.world_id = successor.successor_world_id
            WHERE w.world_id = $1
            FOR UPDATE OF w`,
          [ref.worldId, ref.sessionId],
        );
        const current = rows.rows[0];
        if (!current) throw new Error('session does not own this world');
        if (current.status !== 'ended') throw new Error('end the current world before starting another');
        if (current.successor_world_id) {
          return {
            worldId: current.successor_world_id,
            seed: current.successor_seed ?? seed,
            created: false,
          };
        }

        const created = await instantiateWorldOnClient(client, {
          scenarioVersionId: current.scenario_version_id,
          seed,
          sessionId: ref.sessionId,
          playerName: current.player_name,
          inferenceProfile: current.inference_profile,
          playerProfile: {
            background: current.profile?.background ?? '',
            sympathyFactionKey: current.profile?.sympathyFactionKey ?? null,
          },
        });
        await client.query(
          `INSERT INTO world_successors (previous_world_id, successor_world_id) VALUES ($1, $2)`,
          [ref.worldId, created.worldId],
        );
        return { worldId: created.worldId, seed, created: true };
      }, { label: 'start-successor-world' });
      const next = { sessionId: ref.sessionId, worldId: started.worldId };
      await writeSession(next);
      logInfo('world_started', {
        previousWorldId: ref.worldId,
        worldId: started.worldId,
        seed: started.seed,
        created: started.created,
      });
      return NextResponse.json(started, { status: started.created ? 201 : 200 });
    }
    throw new Error('unknown control action');
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/control' });
  }
}
