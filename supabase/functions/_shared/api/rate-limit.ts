/**
 * Rate limiting for LoreKit REST Edge Functions.
 *
 * Delegates to the existing lorekit_check_rate_limit Postgres RPC — the same
 * DB-backed fixed-window enforcer used by the MCP function. No new infra.
 *
 * Usage:
 *   const rl = await checkRateLimit(db, userId, span);
 *   if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);
 *
 * Service-role callers (userId = null) are exempt — same as the MCP path.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createTracedClient, type Span } from '../otel.ts';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  currentCount?: number;
  limitValue?: number;
}

/**
 * Check the rate limit for a user. Fails OPEN on any RPC error —
 * availability over strict throttling; the cap trigger still protects storage.
 */
export async function checkRateLimit(
  db: ReturnType<typeof createClient>,
  userId: string | null,
  span: Span,
  windowSeconds = 60,
): Promise<RateLimitResult> {
  // Service-role callers (CI, internal) are exempt
  if (!userId) return { allowed: true, retryAfterSeconds: 0 };

  const tracedDb = createTracedClient(db, span);
  try {
    const { data, error } = await tracedDb.rpc('lorekit_check_rate_limit', {
      p_user_id: userId,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      span.error(`RateLimitRpcError: ${error.message}`);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: Boolean(row?.allowed),
      retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
      currentCount: row?.current_count != null ? Number(row.current_count) : undefined,
      limitValue: row?.limit_value != null ? Number(row.limit_value) : undefined,
    };
  } catch (err) {
    span.error(`RateLimitException: ${(err as Error).message}`);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
