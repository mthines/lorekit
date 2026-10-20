/**
 * The caller's memory quota: how many active memories they hold against the
 * cap that will refuse their next write, and how many they can still write.
 *
 * Self-contained Deno mirror of `packages/mcp-core/src/limits/memory-quota.ts` —
 * the edge tree cannot cross-import the Node package. `edge-parity.spec.ts`
 * compares the two with comments stripped, so this file is free to say
 * something different here but must stay behaviourally identical below.
 *
 * Why the personal pair and not the RPC's combined `count`: the cap trigger
 * (00018) counts personal rows against the personal limit and org rows against
 * each org's own limit, so a "remaining" from the combined count would be wrong
 * for both.
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
