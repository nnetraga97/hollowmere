import { NextResponse } from 'next/server';

import { getAgentDetail } from '@/server/engine';
import { requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ agentKey: string }> }) {
  try {
    const { agentKey } = await context.params;
    return NextResponse.json(await getAgentDetail(await requireSession(), decodeURIComponent(agentKey)), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return routeError(error, { method: 'GET', route: '/api/agent/[agentKey]' });
  }
}
