// Pure, DEPENDENCY-FREE lesson primitives shared by the hook engine
// (`core/lessons.mjs`, the hot path) and the read-command view layer
// (`lessons-view.mjs`, which re-exports these). Kept in its own module so the
// hook can import the exact precedence + match logic the read commands use —
// one source of truth, no drift — WITHOUT dragging in the rendering/`util`
// stack (`heading`/`log`/`c`, plus the lint/dedupe/diff cores) that the rest of
// `lessons-view.mjs` carries. Zero imports on purpose.

// ── cross-scope precedence resolution (the `tree` + hook merge core) ──────────

// Given per-scope groups in RESOLUTION ORDER — most-specific first, exactly the
// order `deriveScope().readOrder` produces — compute which scope's lesson WINS
// each key and which are shadowed. This is the hook engine's merge: it iterates
// the scopes narrow-to-broad and keeps the FIRST value seen per key (`if
// (!winnerScopeByKey.has(key)) set`), so a more-specific scope shadows a broader
// scope's same-key lesson. Returns the same groups with every entry tagged
// `{ winning, shadowedBy }` (`shadowedBy` = the scope that won the key, or null
// for a winner), plus the resolved `winners` list (`{ scope, key }`, one per
// key) and winning/shadowed counts. A per-scope read error is passed through
// untouched (empty entries), so one unreadable scope never derails resolution.
// Pure — consumed by both `tree` (display) and `fetchLessons` (injection).
export function resolvePrecedence({ groups = [] } = {}) {
  const winnerScopeByKey = new Map(); // key → the scope that first claimed it
  const outGroups = [];
  let winningTotal = 0;
  let shadowedTotal = 0;
  for (const g of groups) {
    if (g.error) {
      outGroups.push({ scope: g.scope, error: g.error, entries: [] });
      continue;
    }
    const entries = [];
    for (const e of g.entries || []) {
      const prior = winnerScopeByKey.get(e.key);
      if (prior === undefined) {
        winnerScopeByKey.set(e.key, g.scope);
        entries.push({ ...e, winning: true, shadowedBy: null });
        winningTotal += 1;
      } else {
        entries.push({ ...e, winning: false, shadowedBy: prior });
        shadowedTotal += 1;
      }
    }
    outGroups.push({ scope: g.scope, error: null, entries });
  }
  const winners = [...winnerScopeByKey.entries()].map(([key, scope]) => ({ scope, key }));
  return { groups: outGroups, winners, winningTotal, shadowedTotal };
}

// ── literal, case-insensitive substring matching (the `search` + hook core) ───

// Case-insensitive, LITERAL substring match of `query` against a normalized
// entry's key OR value — the `search` command's matcher, and the hook's
// failure-relevance matcher. Deliberately a plain `String.includes` (never
// `new RegExp(query)`) so a query full of regex metacharacters like `a.*(b)`
// matches those characters verbatim, never as a pattern. An empty query matches
// everything (the command guards emptiness as a usage error before ever calling
// this). Pure — trivially unit-testable.
export function matchesQuery(entry, query) {
  const needle = String(query == null ? '' : query).toLowerCase();
  if (!needle) return true;
  const key = String(entry?.key ?? '').toLowerCase();
  const value = String(entry?.value ?? '').toLowerCase();
  return key.includes(needle) || value.includes(needle);
}
