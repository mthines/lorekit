// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/tags.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
/**
 * Label (`memories.tags`) primitives shared by every surface that filters on
 * them: the dashboard's label picker, the `GET /memories` handler's
 * `tags_mode=all` branch, and anything that talks to PostgREST's array
 * operators.
 *
 * This is `filter.ts`'s reasoning applied to a second case — the logic is
 * (a) pure, (b) part of the wire contract, and (c) needed by more than one
 * runtime — so it lives next to the schemas that validate its input rather
 * than being re-derived in the edge tree, where there is no test harness.
 */

/**
 * Trim, drop empties, and dedupe a raw label list, preserving first-seen order.
 *
 * Total function: `undefined`, a non-array, or an array holding non-strings all
 * degrade to the labels that ARE usable rather than throwing — the input can
 * come from a URL param or a query string a user typed by hand.
 */
export function normalizeTagList(values: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Split the comma-separated `tags` query param into a normalized label list.
 *
 * A label containing a comma is unreachable over this parameter by
 * construction — that is a property of the wire format, not of this function.
 */
export function parseTagsParam(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return normalizeTagList(raw.split(','));
}

/**
 * Derive `{ kind, host }` from a memory's loop tags — the back-compat bridge
 * for the taxonomy columns (migration 00056).
 *
 * A loop bucket has always encoded its kind and host in a `loop::…` tag. When a
 * write does not carry explicit `kind`/`host`, the write path calls this to
 * recover them from the tags so a memory written by an older client is still
 * attributable. Pure and total: an absent, unrecognised, or malformed tag set
 * yields `{}` rather than throwing — the two columns simply stay NULL.
 *
 * The mapping (authoritative reference: agent-skills'
 * `agents/shared/rules/memory-buckets.md`):
 *   `loop::<host>-lessons`             → { kind: 'lesson', host: '<host>' }
 *   `loop::review-outcomes`            → { kind: 'bus',    host: 'review' }
 *   `loop::reviewer-comment-relevance` → { kind: 'signal', host: 'reviewer' }
 *
 * First recognised tag wins, so a stray extra `loop::` tag cannot flip the
 * classification of a bucket that already matched.
 */
export function inferKindHost(
  tags: readonly unknown[] | undefined | null,
): { kind?: 'lesson' | 'bus' | 'signal'; host?: string } {
  for (const tag of normalizeTagList(tags as readonly unknown[] | undefined | null)) {
    if (tag === 'loop::review-outcomes') return { kind: 'bus', host: 'review' };
    if (tag === 'loop::reviewer-comment-relevance') return { kind: 'signal', host: 'reviewer' };
    const m = /^loop::(.+)-lessons$/.exec(tag);
    if (m && m[1]) return { kind: 'lesson', host: m[1] };
  }
  return {};
}

/**
 * Resolve the effective `{ kind, host }` for a write: an explicit, valid value
 * wins; otherwise fall back to what {@link inferKindHost} recovers from the
 * loop tags; otherwise `null`.
 *
 * Shared by every write surface (Node server, edge MCP, and the usage-tracking
 * recorder) so the family/owner STORED on the memory and the family/owner
 * TRACKED in usage_events are classified identically — a write that omits
 * `kind` but carries `loop::reviewer-lessons` is a `lesson`/`reviewer` in both
 * the row and the analytics event. An explicit `kind` outside the closed
 * vocabulary is ignored (falls through to inference) rather than stored.
 */
export function resolveKindHost(params: {
  kind?: unknown;
  host?: unknown;
  tags?: readonly unknown[] | null;
}): { kind: 'lesson' | 'bus' | 'signal' | null; host: string | null } {
  const inferred = inferKindHost(params.tags ?? null);
  const kind =
    params.kind === 'lesson' || params.kind === 'bus' || params.kind === 'signal'
      ? params.kind
      : (inferred.kind ?? null);
  const host =
    typeof params.host === 'string' && params.host ? params.host : (inferred.host ?? null);
  return { kind, host };
}

/**
 * Build a PostgreSQL array literal (`{"a","b,c"}`) from a label list.
 *
 * postgrest-js's `.contains(column, string[])` / `.overlaps(column, string[])`
 * serialise an array with a bare `value.join(',')`, so a label containing a
 * comma, brace, quote, or backslash is silently mis-parsed into different
 * labels — and `memories.tags` is free text with no CHECK constraint, so such a
 * label is reachable. Passing a STRING instead makes postgrest-js emit
 * `cs.<string>` / `ov.<string>` verbatim, which lets this function own the
 * quoting.
 *
 * Every element is double-quoted (legal for any element, and unambiguous) with
 * `\` and `"` backslash-escaped, per the Postgres array-literal rules.
 */
export function pgArrayLiteral(values: readonly string[]): string {
  const quoted = normalizeTagList(values).map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${quoted.join(',')}}`;
}
