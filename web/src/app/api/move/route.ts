import { NextRequest, NextResponse } from 'next/server';

import { logInfo, queuePlayerMove } from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<{ locationKey?: string; idempotencyKey?: string }>(request);
    if (!body.locationKey || !body.idempotencyKey) throw new Error('locationKey and idempotencyKey are required');
    const ref = await requireSession();
    const result = await queuePlayerMove(ref, body.locationKey, body.idempotencyKey);
    logInfo('player_move_queued', {
      worldId: ref.worldId,
      locationKey: body.locationKey,
      replayed: result.replayed,
    });
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/move' });
  }
}
