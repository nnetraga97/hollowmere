import { NextRequest } from 'next/server';

import { assertColocated, converse, query } from '@/server/engine';
import { jsonBody, requireSameOrigin, requireSession } from '@/server/http';
import { inference } from '@/server/inference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireSameOrigin(request);
    const ref = await requireSession();
    const body = await jsonBody<{ agentKey?: string; text?: string; idempotencyKey?: string }>(request);
    const agentKey = body.agentKey?.trim();
    const utterance = body.text?.trim();
    if (!agentKey || !utterance || !body.idempotencyKey) {
      return Response.json({ error: 'agentKey, text, and idempotencyKey are required' }, { status: 400 });
    }
    if (utterance.length > 2_000) return Response.json({ error: 'utterance is too long' }, { status: 413 });
    await assertColocated(ref, agentKey);

    const recent = await query<{ count: number }>(
      `SELECT count(*)::INT8 AS count FROM world_commands
        WHERE world_id = $1 AND kind = 'converse'
          AND received_at > now() - INTERVAL '1 minute'`, [ref.worldId],
    );
    const limit = Number(process.env.CONVERSATION_RATE_LIMIT_PER_MINUTE ?? 20);
    if ((recent[0]?.count ?? 0) >= limit) {
      return Response.json({ error: 'conversation rate limit reached; wait a moment' }, { status: 429 });
    }

    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, value: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
          } catch {
            open = false;
          }
        };
        void converse({
          worldId: ref.worldId,
          sessionId: ref.sessionId,
          agentKey,
          text: utterance,
          idempotencyKey: body.idempotencyKey!,
          inference,
          onToken: (token) => emit('token', { token }),
        }).then((result) => {
          emit('result', result);
        }).catch((error: unknown) => {
          emit('error', { error: error instanceof Error ? error.message : String(error) });
        }).finally(() => {
          if (open) controller.close();
          open = false;
        });
      },
      cancel() {
        // converse intentionally continues: its effects are already durable,
        // and the completed reply still needs to be recorded for replay.
        open = false;
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
