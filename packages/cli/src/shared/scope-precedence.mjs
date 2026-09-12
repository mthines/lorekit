// Which entry wins when a read named NO scope — the CLI's twin of
// `packages/mcp-core/src/scope/scope-precedence.ts` (and its edge mirror,
// `supabase/functions/_shared/scope/scope-precedence.ts`).
//
// Kept as a separate zero-dep module rather than imported: this package has no
// dependency on `@lorekit/core`, and the pair is a CROSS-LANGUAGE one (this
// `.mjs` vs that `.ts`), so it is guarded for BEHAVIOURAL parity by
// `scope-precedence-parity.spec.ts` rather than the byte comparison
// `mirror-pairs.mjs` runs over the two TypeScript copies — the same
// arrangement `session-kind-parity.spec.ts` uses.
//
// Distinct from `resolvePrecedence` in `lessons-pure.mjs`, which resolves a
// key across the CALLER'S OWN scope list (`deriveScope().readOrder`,
// narrow-to-broad). That one answers "the agent is standing in this repo, on
// this branch — whose lesson wins?". This one answers the question that only
// arises once NO scope was named at all, where the caller's own scopes are not
// the candidate set: every scope the account can see is. The server has no
// working directory to derive `readOrder` from, so this is the only definition
// MCP, REST and the CLI can all compute — which is why `show <key>` uses it
// too, instead of quietly resolving differently from the hosted surfaces.

/**
 * Scope types in resolution order, most-specific first. The SAME order as
 * `readOrder` — see the TS twin for why it is a list rather than a segment
 * count.
 */
export const SCOPE_PRECEDENCE = ['project', 'branch', 'repo', 'global'];

/**
 * Rank a scope by type: 0 for the most specific, higher for broader. An
 * unrecognised scope ranks LAST rather than throwing.
 */
export function scopePrecedenceRank(scope) {
  const raw = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
  const sep = raw.indexOf('::');
  const prefix = sep === -1 ? raw : raw.slice(0, sep);
  const at = SCOPE_PRECEDENCE.indexOf(prefix);
  return at === -1 ? SCOPE_PRECEDENCE.length : at;
}

/**
 * Order two candidates: precedence band, then most-recently-updated, then
 * scope ascending. Total and deterministic — see the TS twin for why the last
 * two tie-breaks are load-bearing rather than decoration.
 */
export function compareScopePrecedence(a, b) {
  const byRank = scopePrecedenceRank(a?.scope) - scopePrecedenceRank(b?.scope);
  if (byRank !== 0) return byRank;
  const at = typeof a?.updated_at === 'string' ? a.updated_at : '';
  const bt = typeof b?.updated_at === 'string' ? b.updated_at : '';
  if (at !== bt) return at < bt ? 1 : -1;
  const as = typeof a?.scope === 'string' ? a.scope : '';
  const bs = typeof b?.scope === 'string' ? b.scope : '';
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** The entry an unscoped read resolves to, or `null` when there were none. */
export function pickScopeWinner(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let winner = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    if (compareScopePrecedence(rows[i], winner) < 0) winner = rows[i];
  }
  return winner;
}

/**
 * Every scope the candidates cover EXCEPT the winner's, in precedence order,
 * de-duplicated — what an unscoped read reports so the caller can see its key
 * was ambiguous and pass an explicit scope next time.
 */
export function shadowedScopes(rows, winner) {
  if (!Array.isArray(rows) || !winner) return [];
  const seen = new Set([winner.scope]);
  const out = [];
  for (const row of [...rows].sort(compareScopePrecedence)) {
    if (seen.has(row.scope)) continue;
    seen.add(row.scope);
    out.push(row.scope);
  }
  return out;
}
