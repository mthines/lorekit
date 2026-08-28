'use server';

/**
 * Server actions for the /settings/plan page.
 *
 * Returns the user's active memory count, plan name, and effective limit in
 * one round-trip via the lorekit_memory_count() SECURITY DEFINER RPC
 * (supabase/migrations/00035_memory_count.sql).
 */

import { createServerClient } from '@/lib/supabase/server';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { withSpan, logger } from '@/lib/telemetry';

export interface PlanUsage {
  count: number;
  limit: number;
  plan: string;
}

/**
 * Fetch the current user's plan + memory usage.
 * Returns null on auth failure or RPC error — callers degrade gracefully.
 */
export async function getPlanUsage(): Promise<PlanUsage | null> {
  return withSpan('lorekit.plan.get_usage', {}, async (span) => {
    const supabase = await createServerClient();
    const user = await getVerifiedUser();

    if (!user) return null;

    const { data, error } = await supabase.rpc('lorekit_memory_count', {
      p_user_id: user.id,
    });

    if (error) {
      logger.error('lorekit.plan.get_usage.failed', {
        'exception.type': 'SupabaseRpcError',
        'exception.message': error.message,
      });
      return null;
    }

    const row = data as { count: number; limit: number; plan: string };
    span.setAttribute('lorekit.plan', row.plan);
    span.setAttribute('lorekit.memory.count', row.count);
    span.setAttribute('lorekit.memory.limit', row.limit);

    return { count: row.count, limit: row.limit, plan: row.plan };
  });
}
