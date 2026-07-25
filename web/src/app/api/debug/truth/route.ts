import { NextResponse } from 'next/server';

import { getDebugTruth } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getDebugTruth(await requireSession()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error);
  }
}
