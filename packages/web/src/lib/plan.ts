'use server';

/**
 * Server actions for the /settings/plan page.
 *
 * Returns the user's active memory count, plan name, and effective limit in
 * one round-trip via the lorekit_memory_count() SECURITY DEFINER RPC
 * (supabase/migrations/00035_memory_count.sql, fixed in 00036).
 */

import { createServerClient } from '@/lib/supabase/server';
import { withSpan, logger } from '@/lib/telemetry';

export interface PlanUsage {
  /** Combined active memory count (personal + org). */
  count: number;
  /** Personal memories only (user_id = self, archived_at IS NULL). */
  personalCount: number;
  /** Org-owned memories across all orgs the user belongs to. */
  orgCount: number;
  /** Effective memory cap for the user's plan (or manual override). */
  limit: number;
  /** Plan name, e.g. 'free'. */
  plan: string;
}

/**
 * Fetch the current user's plan + memory usage.
 * Returns null on auth failure or RPC error — callers degrade gracefully.
 */
export async function getPlanUsage(): Promise<PlanUsage | null> {
  return withSpan('lorekit.plan.get_usage', {}, async (span) => {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

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

    const row = data as {
      count: number;
      personal_count: number;
      org_count: number;
      limit: number;
      plan: string;
    };

    span.setAttribute('lorekit.plan', row.plan);
    span.setAttribute('lorekit.memory.count', row.count);
    span.setAttribute('lorekit.memory.personal_count', row.personal_count);
    span.setAttribute('lorekit.memory.org_count', row.org_count);
    span.setAttribute('lorekit.memory.limit', row.limit);

    return {
      count: row.count,
      personalCount: row.personal_count,
      orgCount: row.org_count,
      limit: row.limit,
      plan: row.plan,
    };
  });
}
