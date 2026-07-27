import { NextRequest, NextResponse } from 'next/server';

import { chooseRomanceMoment, getRomanceArcs } from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(await getRomanceArcs(await requireSession()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<{
      agentKey?: string; sceneKey?: string; choiceKey?: string;
      locationKey?: string; idempotencyKey?: string;
    }>(request);
    if (!body.agentKey || !body.sceneKey || !body.choiceKey
      || !body.locationKey || !body.idempotencyKey) {
      return Response.json({ error: 'agentKey, sceneKey, choiceKey, locationKey, and idempotencyKey are required' }, { status: 400 });
    }
    return NextResponse.json(await chooseRomanceMoment({
      ...await requireSession(),
      agentKey: body.agentKey,
      sceneKey: body.sceneKey,
      choiceKey: body.choiceKey,
      locationKey: body.locationKey,
      idempotencyKey: body.idempotencyKey,
    }));
  } catch (error) {
    return routeError(error);
  }
}
