import { NextRequest, NextResponse } from 'next/server';

import {
  closeConversation, getHeldConversation, startConversation, takeConversationTurn,
} from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession, routeError } from '@/server/http';
import { inference } from '@/server/inference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(await getHeldConversation(await requireSession()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) { return routeError(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireSameOrigin(request);
    const ref = await requireSession();
    const body = await jsonBody<{
      action?: 'start' | 'turn' | 'close'; agentKey?: string; conversationId?: string;
      text?: string; idempotencyKey?: string;
    }>(request);
    if (!body.action || !body.idempotencyKey) {
      return Response.json({ error: 'action and idempotencyKey are required' }, { status: 400 });
    }
    if (body.action === 'start') {
      if (!body.agentKey) return Response.json({ error: 'agentKey is required' }, { status: 400 });
      return NextResponse.json(await startConversation({
        ...ref, agentKey: body.agentKey, idempotencyKey: body.idempotencyKey,
      }));
    }
    if (!body.conversationId) {
      return Response.json({ error: 'conversationId is required' }, { status: 400 });
    }
    if (body.action === 'close') {
      return NextResponse.json(await closeConversation({
        ...ref, conversationId: body.conversationId,
        idempotencyKey: body.idempotencyKey, inference,
      }));
    }
    const text = body.text?.trim();
    if (!text) return Response.json({ error: 'text is required' }, { status: 400 });
    if (text.length > 2_000) return Response.json({ error: 'utterance is too long' }, { status: 413 });

    // The full turn is validated and committed before anything is exposed to
    // the browser. SSE then reveals that authoritative reply incrementally.
    const result = await takeConversationTurn({
      ...ref, conversationId: body.conversationId, text,
      idempotencyKey: body.idempotencyKey, inference,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const token of result.turn.reply.match(/\S+\s*/g) ?? []) {
          controller.enqueue(encoder.encode(`event: token\ndata: ${JSON.stringify({ token })}\n\n`));
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify(result)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    } });
  } catch (error) { return routeError(error); }
}
