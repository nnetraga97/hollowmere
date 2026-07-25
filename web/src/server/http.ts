import { NextRequest, NextResponse } from 'next/server';

import { SessionAccessError } from './engine';
import { readSession } from './session';

export function requireSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) throw new HttpError(403, 'cross-origin request refused');
}

export async function requireSession() {
  const session = await readSession();
  if (!session) throw new HttpError(401, 'no valid Hollowmere session');
  return session;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function routeError(error: unknown): NextResponse {
  const status = error instanceof HttpError
    ? error.status
    : error instanceof SessionAccessError ? 403 : 400;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error(JSON.stringify({ level: 'error', event: 'web_route_failed', message }));
  return NextResponse.json({ error: message }, { status });
}

export async function jsonBody<T>(request: NextRequest, maxBytes = 4_096): Promise<T> {
  const size = Number(request.headers.get('content-length') ?? 0);
  if (size > maxBytes) throw new HttpError(413, 'request body is too large');
  return request.json() as Promise<T>;
}
