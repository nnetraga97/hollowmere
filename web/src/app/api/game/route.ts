import { NextResponse } from 'next/server';

import { getGameSnapshot } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const game = await getGameSnapshot(await requireSession());
    return NextResponse.json(game, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return routeError(error);
  }
}
