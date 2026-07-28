import { NextRequest, NextResponse } from 'next/server';

import { errorLogFields, logError, logWarn, SessionAccessError } from './engine';
import { readSession } from './session';

export function requireSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  const configured = process.env.PUBLIC_ORIGIN;
  let expected = request.nextUrl.origin;
  if (configured) {
    try {
      expected = new URL(configured).origin;
    } catch {
      throw new Error('PUBLIC_ORIGIN must be an absolute URL');
    }
  }
  if (origin && origin !== expected) throw new HttpError(403, 'cross-origin request refused');
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

export interface RouteLogContext {
  method: string;
  route: string;
}

export function routeError(error: unknown, context: RouteLogContext): NextResponse {
  const status = error instanceof HttpError
    ? error.status
    : error instanceof SessionAccessError ? 403 : 400;
  const message = error instanceof Error ? error.message : String(error);
  const fields = { ...context, status, ...errorLogFields(error) };
  if (status >= 500) logError('web_request_failed', fields);
  else logWarn('web_request_rejected', fields);
  return NextResponse.json({ error: message }, { status });
}

export async function jsonBody<T>(request: NextRequest, maxBytes = 4_096): Promise<T> {
  const size = Number(request.headers.get('content-length') ?? 0);
  if (size > maxBytes) throw new HttpError(413, 'request body is too large');
  return request.json() as Promise<T>;
}
