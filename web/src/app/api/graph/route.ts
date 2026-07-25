import { NextRequest, NextResponse } from 'next/server';

import { getSocialGraph } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const ref = await requireSession();
    const threshold = Math.max(0, Number(request.nextUrl.searchParams.get('min') ?? 2_500));
    return NextResponse.json(await getSocialGraph(ref.worldId, threshold), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error);
  }
}
