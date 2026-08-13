// Pure local-entry → `MemoryEntry` translation — the inverse of the
// dashboard's `lessonFromMemoryEntry` (packages/web/src/lib/lesson-entry.ts):
// that one turns a wire `MemoryEntry` into a `LessonEntry`; this one turns a
// raw local-store row (LocalStore/TwoTierStore frontmatter) into the wire
// shape every `@lorekit/schemas` `MemoryEntrySchema` consumer expects.
//
// The local store has no `id` (D2 — see synthetic-id.mjs), no `kind`/`host`
// columns (00056 has no local-store equivalent yet), and no org/authorship
// columns (local mode is always exactly one implicit user, D8 keeps local-file
// mode out of the BYOD/org seam entirely) — every one of those fields is
// either synthesized or `null`, never fabricated as a non-null placeholder.
//
// Zero-dependency: no imports, not even node builtins — the same posture as
// `entry-fields.mjs` and `ttl.mjs`, so this can run on any path without
// dragging in fs/crypto.
import { syntheticId } from './synthetic-id.mjs';

/**
 * An ISO 8601 instant, or `null` for anything unparseable/absent.
 *
 * `MemoryEntrySchema` requires `created_at`/`updated_at` to be a `datetime()`
 * string — a local frontmatter field that was hand-edited into garbage must
 * degrade to `null` rather than crash the response; the caller decides how to
 * handle a missing required field (memoryEntryFromLocal falls back to `now`
 * for created/updated, since the schema does not admit `null` there).
 */
function isoOrNull(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A finite integer, or `null`. `origin_pr` is `number | null` on the wire;
 * the local store may hold it as a number, a numeric string, or nothing.
 */
function intOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Translate one raw local-store row into a `MemoryEntry`-shaped object.
 *
 * `row` is whatever `LocalStore`/`TwoTierStore.listRaw()` hands back — the
 * parsed frontmatter (`scope`, `key`, `tags`, `source_agent`, `trigger`,
 * `origin_*`, `created`, `updated`, `archived_at`, `expires_at`,
 * `seen_count`, `value`), optionally already carrying the additive
 * `seenCount`/`updatedAt` read fields `withReadFields` adds (ignored here —
 * this function reads the raw columns directly so it does not depend on that
 * projection having run).
 *
 * Total: a malformed row still yields a schema-shaped object (empty
 * scope/key/value strings, empty tags, every optional field null) rather than
 * throwing, because a listing must not fail wholesale over one bad file.
 */
export function memoryEntryFromLocal(row) {
  const r = row && typeof row === 'object' ? row : {};
  const scope = typeof r.scope === 'string' ? r.scope : '';
  const key = typeof r.key === 'string' ? r.key : '';
  const now = new Date().toISOString();

  return {
    id: syntheticId(scope, key),
    scope,
    key,
    value: r.value == null ? '' : String(r.value),
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string') : [],
    source_agent: typeof r.source_agent === 'string' && r.source_agent ? r.source_agent : null,
    trigger: typeof r.trigger === 'string' && r.trigger ? r.trigger : null,
    // MemoryEntrySchema requires these two — fall back to "now" rather than
    // emit a non-ISO value the schema would reject.
    created_at: isoOrNull(r.created) ?? now,
    updated_at: isoOrNull(r.updated) ?? now,
    expires_at: isoOrNull(r.expires_at),
    archived_at: isoOrNull(r.archived_at),
    origin_repo: typeof r.origin_repo === 'string' && r.origin_repo ? r.origin_repo : null,
    origin_branch: typeof r.origin_branch === 'string' && r.origin_branch ? r.origin_branch : null,
    origin_commit: typeof r.origin_commit === 'string' && r.origin_commit ? r.origin_commit : null,
    origin_pr: intOrNull(r.origin_pr),
    // No local-store column yet (00056 has no offline equivalent) — always
    // null, never fabricated.
    kind: typeof r.kind === 'string' && r.kind ? r.kind : null,
    host: typeof r.host === 'string' && r.host ? r.host : null,
    seen_count: seenCount(r.seen_count),
    // Local mode is always exactly one implicit user (D3/D8) — there is no
    // org, no authorship. Omitted rather than set to a fabricated null-object,
    // matching how an older backend's response is unaffected by these being
    // optional in MemoryEntrySchema.
    org_id: null,
    org: null,
    created_by: null,
    updated_by: null,
  };
}

function seenCount(raw) {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  return Math.max(0, Math.floor(n));
}
