// Pure core behind BATCH `memory.read` (`refs`) — shared by MCP's `toolRead`
// (`supabase/functions/mcp/tools.ts`) and REST's `handleRead`
// (`supabase/functions/memories/handlers/read.ts`).
//
// Import-free by construction, mirrored byte-identically into
// `supabase/functions/_shared/memory/read-refs.ts` (registered in
// `packages/cli/src/shared/mirror-pairs.mjs`, `driftChecked: true`, so
// `edge-parity.spec.ts` byte-compares the two). Deliberately does not import
// `MemoryRef` or `parseMemoryRefs` from `../scope/scope.ts` — this module only
// operates on an already-parsed `{ scope, key }` ARRAY; the string grammar
// (`scope::key` splitting) is `parseMemoryRefs`' job alone (R3), so there is
// no second reference parser anywhere in the repo.
//
// Every export here is TOTAL: malformed input degrades to an empty/default
// result rather than throwing, matching every other telemetry-adjacent pure
// module in this codebase (a batch read must never fail because one ref in
// the middle of it is odd).

/** One already-parsed `scope::key` pair — the shape `parseMemoryRefs` returns. */
export interface RefEntry {
  scope: string;
  key: string;
}

/**
 * Charset + length guard for a key headed into a PostgREST `.in('key', […])`
 * filter list (R15).
 *
 * postgrest-js's `.in()` quotes a value containing a comma or parenthesis by
 * wrapping it in double quotes (`PostgrestReservedCharsRegexp = /[,()]/`,
 * `PostgrestFilterBuilder.ts`), but does not escape a double quote or a
 * backslash INSIDE the value — either character can break out of that
 * quoting and malform the whole filter list. Rejecting all four here means a
 * bad ref becomes a `missing` entry instead of ever reaching a query; no
 * visibility is at stake either way, since the tenant predicate is a
 * separate query parameter, never part of the `in.(…)` value list.
 *
 * `memories.key` carries no DB-level length constraint, but every existing
 * schema that accepts one (`MemoryReadSchema`, `ListMemoriesBodySchema`, …)
 * caps it at 512 — the same bound enforced here, ahead of the query, rather
 * than relied on downstream.
 */
const STRUCTURAL_KEY_CHARS = /[,()"\\]/;
const KEY_MAX_LENGTH = 512;

export function isQueryableKey(key: string): boolean {
  return (
    typeof key === 'string'
    && key.length > 0
    && key.length <= KEY_MAX_LENGTH
    && !STRUCTURAL_KEY_CHARS.test(key)
  );
}

/**
 * Group refs by scope into `[{ scope, keys }]`, ordered by first occurrence
 * of each distinct scope. One group per distinct scope regardless of how many
 * refs share it — this is what lets the transport issue exactly ONE
 * `.eq('scope', s).in('key', keys)` query per scope (plan D5, R6), awaited
 * concurrently, instead of one query per ref.
 *
 * A ref whose key fails `isQueryableKey` is dropped from every group — it
 * never reaches a query — and resolves to `missing` via `missingRefs` below,
 * exactly as an unresolvable scope or key does.
 */
export function groupRefsByScope(refs: readonly RefEntry[]): { scope: string; keys: string[] }[] {
  const order: string[] = [];
  const byScope = new Map<string, string[]>();
  for (const { scope, key } of refs) {
    if (!isQueryableKey(key)) continue;
    let keys = byScope.get(scope);
    if (!keys) {
      keys = [];
      byScope.set(scope, keys);
      order.push(scope);
    }
    keys.push(key);
  }
  return order.map((scope) => ({ scope, keys: byScope.get(scope) as string[] }));
}

/**
 * The requested refs that did not resolve to a found row, as `scope::key`
 * strings built from the caller's OWN parsed segments — never `null` holes
 * in `entries`, so a caller always knows exactly which of its refs came back
 * empty. Order follows `requested`.
 */
export function missingRefs(
  requested: readonly RefEntry[],
  found: readonly { scope: string; key: string }[],
): string[] {
  const foundSet = new Set(found.map((f) => `${f.scope}\u0000${f.key}`));
  return requested
    .filter((r) => !foundSet.has(`${r.scope}\u0000${r.key}`))
    .map((r) => `${r.scope}::${r.key}`);
}
