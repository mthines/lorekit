/**
 * The caller's memory quota: how many active memories they hold against the
 * cap that will refuse their next write, and how many they can still write.
 *
 * Shapes `lorekit_memory_count` (00047) for `GET /memories/quota`, the
 * `memory.quota` MCP tool and `lorekit quota`. Pure and shared (mirrored into
 * `supabase/functions/_shared/limits/memory-quota.ts`, guarded by
 * `edge-parity.spec.ts`) because the contract decision lives here: the RPC's
 * `count` adds personal AND org-owned memories, while its `limit` is the
 * PERSONAL cap. The cap trigger (00018) counts them separately — personal rows
 * against the personal limit, org rows against each org's own limit — so a
 * "remaining" computed from the combined count would be wrong for both. The
 * quota therefore reports the personal pair, and the org total beside it.
 */

/**
 * The row `lorekit_memory_count` returns (migration 00047): jsonb, so every
 * field arrives untyped and is coerced below rather than trusted.
 */
export interface MemoryCountRow {
  count?: unknown;
  personal_count?: unknown;
  org_count?: unknown;
  limit?: unknown;
  plan?: unknown;
}

/** The caller's quota, as `GET /memories/quota` and `memory.quota` answer it. */
export interface MemoryQuota {
  /** Plan name (`free` when the caller has no `user_plans` row). */
  plan: string;
  /** Personal memories against the personal cap: the pair the cap trigger enforces. */
  personal: { count: number; limit: number; remaining: number };
  /** Active org-owned memories across the caller's orgs. Each org has its own cap. */
  org_count: number;
  /** `personal.count + org_count`: every active memory the caller can see. */
  total: number;
}

const DEFAULT_PLAN = 'free';

function nonNegativeInteger(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Shape a `lorekit_memory_count` row into the quota contract. Total: never throws. */
export function memoryQuotaFromRow(row: MemoryCountRow | null | undefined): MemoryQuota {
  const personalCount = nonNegativeInteger(row?.personal_count);
  const orgCount = nonNegativeInteger(row?.org_count);
  const limit = nonNegativeInteger(row?.limit);
  const plan = typeof row?.plan === 'string' && row.plan.trim() !== '' ? row.plan : DEFAULT_PLAN;
  return {
    plan,
    personal: { count: personalCount, limit, remaining: Math.max(limit - personalCount, 0) },
    org_count: orgCount,
    total: personalCount + orgCount,
  };
}
