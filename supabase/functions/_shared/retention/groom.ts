/**
 * Pure candidate/precedence logic for retention policies ("grooming").
 *
 * The AUTHORITATIVE evaluation of "what matches" runs in Postgres
 * (`lorekit_groom_candidates`, migrations 00088/00093) — SQL is what
 * `groom.preview`, `groom.run`, and the nightly sweep all call, so a previewed
 * count always equals what a run archives. This module is a BEHAVIOURAL
 * MIRROR of that SQL, kept here so the matching rules (scope hierarchy, the
 * never-seen coalesce, the dimension-filter semantics, the AND of every
 * condition) are unit-testable without a live database — the same reason
 * `ranking/lesson-rank.ts` exists beside its SQL-adjacent callers. Any change
 * to the matching rule must be made in BOTH `lorekit_groom_candidates` and
 * here, or the two will silently disagree about what a policy catches.
 *
 * `resolveGroomConditions` is the function actually called on the hot path: it
 * turns a `GroomRequest` (a `policy_id` OR inline conditions) plus an
 * already-fetched policy row into the concrete `GroomConditions` struct the
 * SQL RPC takes — so the RPC itself never branches on "was this a saved
 * policy or an inline call".
 *
 * The eight dimension-filter predicates (`matchText` / `matchTags`, 00093)
 * are a SECOND mirror, of `lorekit_match_text` / `lorekit_match_tags`
 * (migration 00066) — same reasoning, same null-handling subtlety: `nin`
 * excludes a row with no value entirely rather than reading a NULL comparison
 * as false, which would otherwise silently ADMIT every unattributed row into
 * a negated filter.
 *
 * Self-contained (no imports) so it can be mirrored verbatim into
 * `supabase/functions/_shared/retention/groom.ts` for the Deno edge runtime.
 * Registered in `packages/mcp-core/src/edge/edge-parity.spec.ts`'s `MIRRORS`.
 */

/** How a scalar multi-value filter combines — mirrors `ScalarFilterModeSchema`. */
export type ScalarFilterMode = 'in' | 'nin';

/** How the label filter combines — mirrors `TagsModeSchema`. */
export type TagsMode = 'any' | 'all' | 'none';

/** A saved retention policy row, as read back from `retention_policies`. */
export interface RetentionPolicyRow {
  id: string;
  scope: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
  max_read_count: number | null;
  max_opened_count: number | null;
  tags: string[] | null;
  tags_mode: TagsMode | null;
  source_agent: string[] | null;
  source_agent_mode: ScalarFilterMode | null;
  trigger: string[] | null;
  trigger_mode: ScalarFilterMode | null;
  kind: string[] | null;
  kind_mode: ScalarFilterMode | null;
  host: string[] | null;
  host_mode: ScalarFilterMode | null;
  origin_repo: string[] | null;
  origin_repo_mode: ScalarFilterMode | null;
  origin_branch: string[] | null;
  origin_branch_mode: ScalarFilterMode | null;
  origin_pr: string[] | null;
  origin_pr_mode: ScalarFilterMode | null;
}

/** The concrete match conditions `lorekit_groom_candidates` takes. */
export interface GroomConditions {
  scope: string;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
  max_read_count: number | null;
  max_opened_count: number | null;
  tags: string[] | null;
  tags_mode: TagsMode | null;
  source_agent: string[] | null;
  source_agent_mode: ScalarFilterMode | null;
  trigger: string[] | null;
  trigger_mode: ScalarFilterMode | null;
  kind: string[] | null;
  kind_mode: ScalarFilterMode | null;
  host: string[] | null;
  host_mode: ScalarFilterMode | null;
  origin_repo: string[] | null;
  origin_repo_mode: ScalarFilterMode | null;
  origin_branch: string[] | null;
  origin_branch_mode: ScalarFilterMode | null;
  origin_pr: string[] | null;
  origin_pr_mode: ScalarFilterMode | null;
}

/** The inline dimension-filter fields `GroomRequestInput`'s scope form can carry. */
export interface GroomDimensionFilterInput {
  tags?: string[];
  tags_mode?: TagsMode;
  source_agent?: string[];
  source_agent_mode?: ScalarFilterMode;
  trigger?: string[];
  trigger_mode?: ScalarFilterMode;
  kind?: string[];
  kind_mode?: ScalarFilterMode;
  host?: string[];
  host_mode?: ScalarFilterMode;
  origin_repo?: string[];
  origin_repo_mode?: ScalarFilterMode;
  origin_branch?: string[];
  origin_branch_mode?: ScalarFilterMode;
  origin_pr?: string[];
  origin_pr_mode?: ScalarFilterMode;
}

/** Either half of `GroomRequestSchema` (@lorekit/schemas), pre-validated. */
export type GroomRequestInput =
  | { policy_id: string }
  | ({
      scope: string;
      min_age_days?: number;
      unseen_days?: number;
      max_seen_count?: number;
      max_read_count?: number;
      max_opened_count?: number;
    } & GroomDimensionFilterInput);

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
    max_read_count: policy.max_read_count,
    max_opened_count: policy.max_opened_count,
    tags: policy.tags,
    tags_mode: policy.tags_mode,
    source_agent: policy.source_agent,
    source_agent_mode: policy.source_agent_mode,
    trigger: policy.trigger,
    trigger_mode: policy.trigger_mode,
    kind: policy.kind,
    kind_mode: policy.kind_mode,
    host: policy.host,
    host_mode: policy.host_mode,
    origin_repo: policy.origin_repo,
    origin_repo_mode: policy.origin_repo_mode,
    origin_branch: policy.origin_branch,
    origin_branch_mode: policy.origin_branch_mode,
    origin_pr: policy.origin_pr,
    origin_pr_mode: policy.origin_pr_mode,
  };
}

/** An inline request's dimension filter, defaulted to "not filtered" (`null`). */
function dimensionOrNull<T>(values: T[] | undefined): T[] | null {
  return values ?? null;
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
    max_read_count: request.max_read_count ?? null,
    max_opened_count: request.max_opened_count ?? null,
    tags: dimensionOrNull(request.tags),
    tags_mode: request.tags_mode ?? null,
    source_agent: dimensionOrNull(request.source_agent),
    source_agent_mode: request.source_agent_mode ?? null,
    trigger: dimensionOrNull(request.trigger),
    trigger_mode: request.trigger_mode ?? null,
    kind: dimensionOrNull(request.kind),
    kind_mode: request.kind_mode ?? null,
    host: dimensionOrNull(request.host),
    host_mode: request.host_mode ?? null,
    origin_repo: dimensionOrNull(request.origin_repo),
    origin_repo_mode: request.origin_repo_mode ?? null,
    origin_branch: dimensionOrNull(request.origin_branch),
    origin_branch_mode: request.origin_branch_mode ?? null,
    origin_pr: dimensionOrNull(request.origin_pr),
    origin_pr_mode: request.origin_pr_mode ?? null,
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

/**
 * Does a scalar text value satisfy a value-list filter? Mirrors
 * `lorekit_match_text` (00066) exactly, including the null-handling
 * subtlety: `nin` requires the value to be NON-NULL, so a row with no value
 * is excluded from a negated filter rather than admitted by a false-reading
 * NULL comparison. A `null`/undefined filter is "not filtered".
 */
export function matchText(
  value: string | null | undefined,
  filter: readonly string[] | null | undefined,
  mode: ScalarFilterMode | null | undefined,
): boolean {
  if (filter == null) return true;
  if ((mode ?? 'in') === 'nin') {
    return value != null && !filter.includes(value);
  }
  return value != null && filter.includes(value);
}

/**
 * Does a label array satisfy a label filter? Mirrors `lorekit_match_tags`
 * (00066): `all` is containment, `any`/default is overlap, `none` is the
 * negation of overlap — never of containment, which would also admit a row
 * carrying all but one named label. A `null`/undefined filter is "not
 * filtered".
 */
export function matchTags(
  value: readonly string[] | null | undefined,
  filter: readonly string[] | null | undefined,
  mode: TagsMode | null | undefined,
): boolean {
  if (filter == null) return true;
  const values = value ?? [];
  const overlaps = filter.some((f) => values.includes(f));
  switch (mode ?? 'any') {
    case 'all':
      return filter.every((f) => values.includes(f));
    case 'none':
      return !overlaps;
    default:
      return overlaps;
  }
}

/** A memory row, projected to the fields grooming conditions need. */
export interface GroomCandidateMemory {
  id: string;
  scope: string;
  key: string;
  created_at: string;
  /**
   * `null` means never individually opened by an agent — see migration
   * 00099. Distinct from `last_read_at` (00084/00098), which also moves on a
   * bulk list/search appearance or a dashboard view; `unseen_days` wants the
   * narrower signal. When null, `unseen_days` measures from `created_at`
   * instead (00100), never from `-infinity`.
   */
  last_opened_at: string | null;
  seen_count: number;
  /**
   * How many times this lesson has been READ (migration 00084) — every
   * read, a bulk `memory.list`/`memory.search` appearance included.
   * Deliberately the BROAD counter, unlike `last_opened_at`: `seen_count`
   * above counts writes, so this is the only field that can express
   * "written once and never actually used".
   */
  read_count: number;
  /**
   * How many times an agent DELIBERATELY fetched this exact lesson (migration
   * 00104) — the count behind `last_opened_at`, moved by the same gate. The
   * NARROW counter, and the one `max_opened_count` reads: `read_count` above
   * counts bulk ride-alongs, so its `0` is unreachable for any lesson in an
   * active scope and it ranks scope breadth. This one's `0` means "nothing
   * ever chose it", in a `global` scope and a `branch` scope alike.
   */
  opened_count: number;
  protected: boolean;
  tags: string[] | null;
  source_agent: string | null;
  trigger: string | null;
  kind: string | null;
  host: string | null;
  origin_repo: string | null;
  origin_branch: string | null;
  origin_pr: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Does one memory match a condition set? ANDs every supplied condition,
 * excludes protected rows unconditionally, and — the case this module exists
 * to make testable — measures `unseen_days` from `created_at` when
 * `last_opened_at` is NULL, mirroring the SQL's
 * `coalesce(last_opened_at, created_at)` (migration 00100).
 *
 * That fallback is the whole point: 00099 used `-infinity`, which made the
 * condition vacuously true for every never-opened row — and since 00099 added
 * the column without a backfill, that was the entire store. Anchoring to
 * `created_at` instead keeps "not opened in N days" literally true of every
 * row returned, and degrades safely on rows that predate the column.
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
    const unseenSince = memory.last_opened_at ?? memory.created_at;
    const unseenDays = (now.getTime() - new Date(unseenSince).getTime()) / MS_PER_DAY;
    if (unseenDays < conditions.unseen_days) return false;
  }

  if (conditions.max_seen_count != null && memory.seen_count > conditions.max_seen_count) {
    return false;
  }

  if (conditions.max_read_count != null && memory.read_count > conditions.max_read_count) {
    return false;
  }

  if (conditions.max_opened_count != null && memory.opened_count > conditions.max_opened_count) {
    return false;
  }

  if (!matchTags(memory.tags, conditions.tags, conditions.tags_mode)) return false;
  if (!matchText(memory.source_agent, conditions.source_agent, conditions.source_agent_mode)) return false;
  if (!matchText(memory.trigger, conditions.trigger, conditions.trigger_mode)) return false;
  if (!matchText(memory.kind, conditions.kind, conditions.kind_mode)) return false;
  if (!matchText(memory.host, conditions.host, conditions.host_mode)) return false;
  if (!matchText(memory.origin_repo, conditions.origin_repo, conditions.origin_repo_mode)) return false;
  if (!matchText(memory.origin_branch, conditions.origin_branch, conditions.origin_branch_mode)) return false;
  if (
    !matchText(
      memory.origin_pr == null ? null : String(memory.origin_pr),
      conditions.origin_pr,
      conditions.origin_pr_mode,
    )
  ) {
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
