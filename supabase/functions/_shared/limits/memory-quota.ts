/**
 * Self-contained Deno mirror of `packages/mcp-core/src/limits/memory-quota.ts`; `edge-parity.spec.ts`
 * compares the two with comments stripped, so keep the code below behaviourally identical.
 */

import { effectiveOrgIds, restrictsTenancy, type KeyRestriction } from '../auth/tenant-scope.ts';

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
  /** Active org-owned memories across the orgs the caller (and its key's tenancy) reaches. Each org has its own cap. */
  org_count: number;
  /** `personal.count + org_count`: every active memory the caller can see. */
  total: number;
}

/** The two reads `quotaForKey` needs, passed in so this module does no I/O of its own. */
export interface QuotaTenancyReads {
  /** The key owner's member orgs (`lorekit_member_org_ids`). */
  memberOrgIds(): Promise<string[]>;
  /** Active (non-archived) org-owned memories across exactly these orgs. */
  countOrgMemories(orgIds: string[]): Promise<number>;
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

/**
 * The quota as the calling key may see it.
 *
 * `lorekit_memory_count` counts every org the OWNER belongs to. A key narrowed to `personal`
 * or to selected orgs (00068) must not learn what the other orgs hold, so `org_count` and
 * `total` are recounted over `effectiveOrgIds` — the same intersection every tenant-scoped
 * read uses. `personal` is never narrowed: the cap is account-wide, so a count cut to the
 * key's scope allowlist would overstate `remaining`. Without a key, or with one that reaches
 * every org, neither read runs. Never reports more org memories than the owner's own figure.
 *
 * @param quota the owner's quota, from `memoryQuotaFromRow`.
 * @param key the calling key's restriction; `undefined` for a JWT or an unrestricted caller.
 * @param reads the membership read and the org count, supplied by each surface.
 * @returns `quota` unchanged, or a copy with `org_count` and `total` recounted.
 * @throws whatever `reads` throws; a failed read must not fall back to the owner's figure.
 */
export async function quotaForKey(
  quota: MemoryQuota,
  key: KeyRestriction | undefined,
  reads: QuotaTenancyReads,
): Promise<MemoryQuota> {
  if (!restrictsTenancy(key)) return quota;
  const orgIds = effectiveOrgIds(await reads.memberOrgIds(), key);
  const reachable = orgIds.length === 0 ? 0 : nonNegativeInteger(await reads.countOrgMemories(orgIds));
  const orgCount = Math.min(reachable, quota.org_count);
  return { ...quota, org_count: orgCount, total: quota.personal.count + orgCount };
}
