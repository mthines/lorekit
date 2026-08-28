/**
 * Pure candidate/precedence logic for retention policies ("grooming").
 *
 * The AUTHORITATIVE evaluation of "what matches" runs in Postgres
 * (`lorekit_groom_candidates`, migration 00088) — SQL is what `groom.preview`,
 * `groom.run`, and the nightly sweep all call, so a previewed count always
 * equals what a run archives. This module is a BEHAVIOURAL MIRROR of that SQL,
 * kept here so the matching rules (scope hierarchy, the never-seen coalesce,
 * the AND of conditions) are unit-testable without a live database — the same
 * reason `ranking/lesson-rank.ts` exists beside its SQL-adjacent callers. Any
 * change to the matching rule must be made in BOTH `lorekit_groom_candidates`
 * and here, or the two will silently disagree about what a policy catches.
 *
 * `resolveGroomConditions` is the function actually called on the hot path: it
 * turns a `GroomRequest` (a `policy_id` OR inline conditions) plus an
 * already-fetched policy row into the concrete `{ scope, min_age_days,
 * unseen_days, max_seen_count }` struct the SQL RPC takes — so the RPC itself
 * never branches on "was this a saved policy or an inline call".
 *
 * Self-contained (no imports) so it can be mirrored verbatim into
 * `supabase/functions/_shared/retention/groom.ts` for the Deno edge runtime.
 * Registered in `packages/mcp-core/src/edge/edge-parity.spec.ts`'s `MIRRORS`.
 */

/** A saved retention policy row, as read back from `retention_policies`. */
export interface RetentionPolicyRow {
  id: string;
  scope: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
}

/** The concrete match conditions `lorekit_groom_candidates` takes. */
export interface GroomConditions {
  scope: string;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
}

/** Either half of `GroomRequestSchema` (@lorekit/schemas), pre-validated. */
export type GroomRequestInput =
  | { policy_id: string }
  | { scope: string; min_age_days?: number; unseen_days?: number; max_seen_count?: number };

/**
 * Project a saved policy row onto the conditions struct the candidate SQL
 * takes. Total — a policy row always yields conditions.
 */
export function resolvePolicyConditions(policy: RetentionPolicyRow): GroomConditions {
  return {
    scope: policy.scope,
    min_age_days: policy.min_age_days,
    unseen_days: policy.unseen_days,
    max_seen_count: policy.max_seen_count,
  };
}

/**
 * Resolve a `GroomRequest` into conditions. When the request names a
 * `policy_id`, the caller must already have fetched the matching row (this
 * function does no I/O) and hand it in as `policy`; a `policy_id` request with
 * no matching row throws — the two request forms are mutually exclusive by
 * their own union type, so this only guards a caller that fetched the
 * wrong/missing policy row.
 */
export function resolveGroomConditions(
  request: GroomRequestInput,
  policy: RetentionPolicyRow | null,
): GroomConditions {
  if ('policy_id' in request) {
    if (!policy) throw new Error(`groom: no policy found for policy_id=${request.policy_id}`);
    return resolvePolicyConditions(policy);
  }
  return {
    scope: request.scope,
    min_age_days: request.min_age_days ?? null,
    unseen_days: request.unseen_days ?? null,
    max_seen_count: request.max_seen_count ?? null,
  };
}

/**
 * Does a policy scope reach a memory scope? Mirrors `lorekit_groom_candidates`'s
 * SQL exactly: `global` reaches everything, an exact match always reaches, and
 * a `repo::owner/repo` policy additionally reaches every
 * `branch::owner/repo::*` memory — a branch scope's repo portion IS the
 * containing repo scope's value. `project::*` and `branch::*` policies reach
 * only their exact scope: no narrower scope type nests under them.
 */
export function scopeMatchesPolicy(memoryScope: string, policyScope: string): boolean {
  if (policyScope === 'global') return true;
  if (memoryScope === policyScope) return true;
  if (policyScope.startsWith('repo::')) {
    const repoPart = policyScope.slice('repo::'.length);
    return memoryScope.startsWith(`branch::${repoPart}::`);
  }
  return false;
}

/** A memory row, projected to the fields grooming conditions need. */
export interface GroomCandidateMemory {
  id: string;
  scope: string;
  key: string;
  created_at: string;
  /** `null` means never seen — see the "unseen_days" header note in 00088. */
  last_seen_at: string | null;
  seen_count: number;
  protected: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Does one memory match a condition set? ANDs every supplied condition,
 * excludes protected rows unconditionally, and — the case this module exists
 * to make testable — a NULL `last_seen_at` (never seen) matches ANY
 * `unseen_days` threshold, mirroring the SQL's
 * `coalesce(last_seen_at, '-infinity')` clamp.
 */
export function isGroomCandidate(
  memory: GroomCandidateMemory,
  conditions: GroomConditions,
  now: Date = new Date(),
): boolean {
  if (memory.protected) return false;
  if (!scopeMatchesPolicy(memory.scope, conditions.scope)) return false;

  if (conditions.min_age_days != null) {
    const ageDays = (now.getTime() - new Date(memory.created_at).getTime()) / MS_PER_DAY;
    if (ageDays < conditions.min_age_days) return false;
  }

  if (conditions.unseen_days != null) {
    const lastSeenMs = memory.last_seen_at == null ? -Infinity : new Date(memory.last_seen_at).getTime();
    const unseenDays = (now.getTime() - lastSeenMs) / MS_PER_DAY;
    if (unseenDays < conditions.unseen_days) return false;
  }

  if (conditions.max_seen_count != null && memory.seen_count > conditions.max_seen_count) {
    return false;
  }

  return true;
}

/** Filter a set of memories down to the ones a condition set catches. */
export function groomCandidates(
  memories: readonly GroomCandidateMemory[],
  conditions: GroomConditions,
  now: Date = new Date(),
): GroomCandidateMemory[] {
  return memories.filter((m) => isGroomCandidate(m, conditions, now));
}
