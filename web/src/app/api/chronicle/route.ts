import { NextRequest, NextResponse } from 'next/server';

import { getChronicle } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const ref = await requireSession();
    const limit = Math.min(200, Math.max(1, Number(request.nextUrl.searchParams.get('limit') ?? 80)));
    const sinceTick = Math.max(0, Number(request.nextUrl.searchParams.get('sinceTick') ?? 0));
    return NextResponse.json(await getChronicle(ref.worldId, { limit, sinceTick }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error);
  }
}
