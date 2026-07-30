import { createReadinessHandler } from '@/lib/health';
import { query } from '@/server/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const timeoutMs = readinessTimeout(process.env.READINESS_TIMEOUT_MS);

export const GET = createReadinessHandler(async () => {
  await query('SELECT 1');
}, { timeoutMs });

function readinessTimeout(value: string | undefined): number {
  if (!value) return 2_000;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000
    ? parsed
    : 2_000;
}
