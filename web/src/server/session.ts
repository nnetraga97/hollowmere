import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import type { SessionRef } from './engine';

const COOKIE_NAME = 'hollowmere_session';

interface CookiePayload {
  v: 1;
  sid: string;
  wid: string;
}

function secret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  // A process-local fallback is intentionally development-only. Reloading the
  // server invalidates the cookie, which is safer than checking in a secret.
  return developmentSecret;
}

const developmentSecret = randomBytes(32).toString('base64url');

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export async function readSession(): Promise<SessionRef | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  const expected = signature(encoded);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CookiePayload;
    if (parsed.v !== 1 || !parsed.sid || !parsed.wid) return null;
    return { sessionId: parsed.sid, worldId: parsed.wid };
  } catch {
    return null;
  }
}

export async function writeSession(ref: SessionRef): Promise<void> {
  const payload: CookiePayload = { v: 1, sid: ref.sessionId, wid: ref.worldId };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  (await cookies()).set(COOKIE_NAME, `${encoded}.${signature(encoded)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 24 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}
