import { createLivenessHandler } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createLivenessHandler();
