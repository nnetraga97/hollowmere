import { NextRequest, NextResponse } from 'next/server';

import {
  logInfo, manufacturePlayerEvidence, plantPlayerRumor,
} from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireSameOrigin(request);
    const body = await jsonBody<{
      action?: 'plant' | 'manufacture';
      listenerAgentKey?: string;
      subjectAgentKey?: string;
      claimKey?: string;
      evidenceId?: string;
      text?: string;
      idempotencyKey?: string;
    }>(request);
    if (!body.action || !body.idempotencyKey) {
      return Response.json({ error: 'action and idempotencyKey are required' }, { status: 400 });
    }
    const ref = await requireSession();
    if (body.action === 'manufacture') {
      if (!body.claimKey) return Response.json({ error: 'claimKey is required' }, { status: 400 });
      const result = await manufacturePlayerEvidence({
        ...ref, claimKey: body.claimKey, idempotencyKey: body.idempotencyKey,
      });
      logInfo('player_evidence_manufactured', {
        worldId: ref.worldId, claimKey: body.claimKey, outcome: result.outcome,
      });
      return NextResponse.json(result);
    }
    if (!body.listenerAgentKey) {
      return Response.json({ error: 'listenerAgentKey is required' }, { status: 400 });
    }
    const result = await plantPlayerRumor({
      ...ref,
      listenerAgentKey: body.listenerAgentKey,
      idempotencyKey: body.idempotencyKey,
      ...(body.claimKey ? { claimKey: body.claimKey } : {}),
      ...(body.subjectAgentKey ? { subjectAgentKey: body.subjectAgentKey } : {}),
      ...(body.text ? { text: body.text } : {}),
      ...(body.evidenceId ? { evidenceId: body.evidenceId } : {}),
    });
    logInfo('player_rumor_planted', {
      worldId: ref.worldId,
      claimKey: result.claimKey,
      listenerAgentKey: result.listenerKey,
      reaction: result.reaction,
      usedManufacturedEvidence: result.usedManufacturedEvidence,
    });
    return NextResponse.json(result);
  } catch (error) {
    return routeError(error, { method: 'POST', route: '/api/deception' });
  }
}
