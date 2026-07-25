import { NextResponse } from 'next/server';

import { getTensionCurve } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ref = await requireSession();
    return NextResponse.json(await getTensionCurve(ref.worldId), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error);
  }
}
