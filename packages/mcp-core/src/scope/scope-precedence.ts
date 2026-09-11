// Which row wins when a read named NO scope.
//
// Every read surface — MCP `memory.read`, the REST list route the CLI's remote
// `show` reads through, and the CLI's own offline store — used to REQUIRE a
// scope up front. That made the common agent call (`memory.read { key }`, no
// scope) a hard error: `scope and key are required`. Dropping the requirement
// means a key can now match in more than one scope at once, and something has
// to decide which one the caller gets.
//
// It cannot be the caller's own scope list. The CLI knows its project, branch
// and repo from git (`deriveScope().readOrder`), but the edge functions see
// only a bearer token — there is no working directory behind an MCP call. So
// the ONE definition both runtimes can compute is scope TYPE specificity, and
// that is what lives here. A surface that DOES know the caller's scopes still
// resolves them the narrow-to-broad way it always has (`resolvePrecedence` in
// the CLI's `lessons-pure.mjs`); this module only answers the question that
// arises once no scope was named at all.
//
// Import-free on purpose: this file is mirrored byte-for-byte into
// `supabase/functions/_shared/scope/scope-precedence.ts` and the drift guard
// (`edge-parity.spec.ts`, driven by `mirror-pairs.mjs`) only covers pairs with
// no imports to diverge on.

/**
 * Scope types in resolution order, most-specific first.
 *
 * The SAME order the hook engine's `readOrder` uses (`[project, branch, repo,
 * global]` — see the "Hook scope ordering unified" decision). Deliberately not
 * re-derived from a notion of "how many `::` segments" — `branch::o/r::x` has
 * more segments than `project::x` but does not outrank it, and encoding the
 * order as a list is what keeps this identical to the precedence the read
 * commands and the SessionStart injection already apply.
 */
export const SCOPE_PRECEDENCE = ['project', 'branch', 'repo', 'global'] as const;

/**
 * A candidate row, as thin as the comparison needs. `updated_at` is optional
 * because the offline store's entries do not always carry one — an absent
 * timestamp sorts LAST within its precedence band rather than throwing, so a
 * store that cannot supply it still resolves deterministically.
 */
export interface ScopedCandidate {
  scope: string;
  updated_at?: string | null;
}

/**
 * Rank a scope by type: 0 for the most specific, higher for broader. An
 * unrecognised scope (one no transport validated, or a type added to the
 * grammar but not to this list) ranks LAST rather than throwing — a read that
 * found something should never fail on how it is ordered.
 */
export function scopePrecedenceRank(scope: string): number {
  const raw = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
  const sep = raw.indexOf('::');
  const prefix = sep === -1 ? raw : raw.slice(0, sep);
  const at = (SCOPE_PRECEDENCE as readonly string[]).indexOf(prefix);
  return at === -1 ? SCOPE_PRECEDENCE.length : at;
}

/**
 * Order two candidates: precedence band first, then most-recently-updated,
 * then scope ascending.
 *
 * The last two are not decoration. A key living in two repos is a real
 * possibility, and without a total order the "winner" of an unscoped read
 * would be whatever order Postgres happened to return — the same call
 * answering differently on consecutive runs. `updated_at desc` picks the
 * lesson someone actually maintained; `scope asc` settles the remainder so the
 * result is reproducible even when two rows were written in the same
 * millisecond.
 */
export function compareScopePrecedence(a: ScopedCandidate, b: ScopedCandidate): number {
  const byRank = scopePrecedenceRank(a.scope) - scopePrecedenceRank(b.scope);
  if (byRank !== 0) return byRank;
  const at = typeof a.updated_at === 'string' ? a.updated_at : '';
  const bt = typeof b.updated_at === 'string' ? b.updated_at : '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
}

/**
 * The row an unscoped read resolves to, or `null` when there were none.
 *
 * Does not mutate the input — a caller that also reports the runners-up (MCP's
 * `other_scopes`) needs the original list intact.
 */
export function pickScopeWinner<T extends ScopedCandidate>(rows: readonly T[]): T | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let winner = rows[0] as T;
  for (let i = 1; i < rows.length; i += 1) {
    if (compareScopePrecedence(rows[i] as T, winner) < 0) winner = rows[i] as T;
  }
  return winner;
}

/**
 * Every scope a candidate list covers EXCEPT the winner's, in the same
 * precedence order, de-duplicated.
 *
 * This is what a single read reports as `other_scopes`. Without it an unscoped
 * read is silently lossy: the caller is handed one lesson with no indication
 * that the key it asked for also exists somewhere else, which is precisely the
 * case where it should pass an explicit scope next time.
 */
export function shadowedScopes(rows: readonly ScopedCandidate[], winner: ScopedCandidate | null): string[] {
  if (!Array.isArray(rows) || winner === null) return [];
  const seen = new Set<string>([winner.scope]);
  const out: string[] = [];
  for (const row of [...rows].sort(compareScopePrecedence)) {
    if (seen.has(row.scope)) continue;
    seen.add(row.scope);
    out.push(row.scope);
  }
  return out;
}
