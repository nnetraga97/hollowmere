import { NextRequest, NextResponse } from 'next/server';

import { queuePlayerMove } from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<{ locationKey?: string; idempotencyKey?: string }>(request);
    if (!body.locationKey || !body.idempotencyKey) throw new Error('locationKey and idempotencyKey are required');
    const result = await queuePlayerMove(await requireSession(), body.locationKey, body.idempotencyKey);
    return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
  } catch (error) {
    return routeError(error);
  }
}
