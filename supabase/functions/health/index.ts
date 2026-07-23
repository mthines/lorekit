/**
 * LoreKit public health check — no JWT required.
 * Deploy with: supabase functions deploy health --no-verify-jwt
 *
 * Returns:
 *   200 { status: "ok", db: "ok", version: "1.0.0", ts: "<iso>" }
 *   503 { status: "degraded", db: "error", error: "<message>", ... }
 *
 * Used by uptime monitors (Better Uptime, UptimeRobot, Checkly, etc.)
 * URL: https://<project>.supabase.co/functions/v1/health
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VERSION = '1.0.0';

Deno.serve(async (_req: Request) => {
  const ts = new Date().toISOString();

  let dbStatus: 'ok' | 'error' = 'ok';
  let dbError: string | undefined;

  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await db
      .from('memories')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    if (error) throw new Error(error.message);
  } catch (err) {
    dbStatus = 'error';
    dbError = (err as Error).message;
  }

  const healthy = dbStatus === 'ok';
  const body = JSON.stringify({
    status: healthy ? 'ok' : 'degraded',
    version: VERSION,
    db: dbStatus,
    ...(dbError ? { error: dbError } : {}),
    ts,
  });

  return new Response(body, {
    status: healthy ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, max-age=30',
    },
  });
});
