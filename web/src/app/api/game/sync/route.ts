import { NextResponse } from 'next/server';

import { getGameSync } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sync = await getGameSync(await requireSession());
    return NextResponse.json(sync, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return routeError(error, { method: 'GET', route: '/api/game/sync' });
  }
}
