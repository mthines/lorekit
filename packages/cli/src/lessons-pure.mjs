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

// ── the scope grammar + the scope/key argument parser ─────────────────────────
//
// These three live together, in the dependency-free module, because they are ONE
// decision: `::` is the scope separator AND the `<scope>::<key>` shorthand's
// separator, so the only thing that can tell the two uses apart is whether a
// candidate left-hand side is itself a complete valid scope. A parser that does
// not consult the validator cannot be correct, and a second copy of either half
// is how `write`/`show` drifted from `link` in the first place.

// The canonical scope validator: returns null for a well-formed scope, or a
// short human reason. The grammar (docs/scope-format.md):
//   global
//   project::{name}
//   repo::{owner}/{repo}
//   branch::{owner}/{repo}::{branch}
// `::` is RESERVED as the segment separator, so no segment may contain it —
// that is what makes `resolveScopeArg`'s split decidable. Every scope type
// enforces it: `project` and `repo` reject a further `::` outright, and
// `branch` requires exactly two segments after its type.
export function scopeIssue(scope) {
  const s = String(scope == null ? '' : scope);
  if (!s) return 'empty scope';
  if (s === 'global') return null;
  const m = /^(project|repo|branch)::(.+)$/.exec(s);
  if (!m) {
    // A recognized type followed by a single ':' is the canonical malformed case.
    if (/^(global|project|repo|branch):(?!:)/.test(s)) return 'single `:` separator (use `::`)';
    return 'unrecognized scope type (expected global | project | repo | branch)';
  }
  const [, type, rest] = m;
  if (type === 'project') {
    return rest.includes('::') ? 'project scope takes no further `::` segment' : null;
  }
  if (type === 'repo') {
    // The `::` check comes FIRST and is separate from the `owner/name` shape:
    // `repo::owner/name::my-key` satisfies `[^/]+/[^/]+` (the key rides along in
    // the name segment), so without it a `repo::<owner>/<name>::<key>` shorthand
    // reads as a "valid" scope and the key is swallowed into the repo name.
    if (rest.includes('::')) return 'repo scope takes no further `::` segment';
    return /^[^/]+\/[^/]+$/.test(rest) ? null : 'repo scope must be `owner/name`';
  }
  // branch
  const parts = rest.split('::');
  if (parts.length !== 2 || !/^[^/]+\/[^/]+$/.test(parts[0]) || !parts[1]) {
    return 'branch scope must be `owner/name::branch`';
  }
  return null;
}

// Is this string a complete, well-formed scope? The predicate form of
// `scopeIssue`, and the disambiguator every scope/key parse is gated on.
export function isScopeString(s) {
  return scopeIssue(s) === null;
}

// Split a single `<scope>::<key>` argument, or fall back to treating the whole
// argument as a scope.
//
// The rule: split at the LAST `::` and take it as `<scope>::<key>` ONLY when the
// left side is itself a COMPLETE valid scope — otherwise the whole arg is the
// scope. Splitting on the last `::` (not the first) keeps a multi-segment scope
// whole (`repo::owner/name::key` → scope `repo::owner/name`, key `key`); gating
// on a valid left side means a bare `repo::owner/name` is NOT mis-split, because
// its left part `repo` is not a valid scope. This is the fix for the prior
// first-`::` split, which turned `link repo::acme/widget` into scope="repo" plus
// a bogus `acme/widget` key — breaking the shorthand for EVERY non-`global`
// scope. A malformed arg falls through to the scope, never a fabricated key.
//
// `isScope` is injected rather than closed over so the module stays trivially
// testable with a stub predicate; callers pass `isScopeString`.
export function resolveScopeArg(arg, isScope = isScopeString) {
  const s = typeof arg === 'string' ? arg.trim() : '';
  if (!s) return { scope: null, key: null };
  const idx = s.lastIndexOf('::');
  if (idx !== -1) {
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + 2).trim();
    if (right && isScope(left)) return { scope: left, key: right };
  }
  return { scope: s, key: null };
}

// Resolve the scope and key a command was given, from its positionals and its
// `--scope` / `--key` flags. THE single implementation for `write`, `show` and
// `link`, returning how many positionals it consumed so a command with trailing
// positionals (`write`'s value) knows where its own arguments start.
//
// Precedence, in order:
//   1. `--scope` / `--key` win outright — an explicit flag is an assertion, so
//      no `::` split is attempted against the half it names. With BOTH flags no
//      positional is read at all, which is the ONLY way to express a key that
//      itself contains `::` (keys are free-form up to 512 chars).
//   2. A first positional that is ALREADY a complete valid scope is the scope,
//      verbatim, and the second positional (if any) is the key. This is the
//      unambiguous two-positional form: `write repo::owner/name my-key value`.
//   3. Otherwise the first positional is run through `resolveScopeArg` — the
//      `<scope>::<key>` shorthand. It only splits when that yields a valid
//      scope, so an unparseable argument becomes the scope and the caller's
//      `scopeIssue` check reports it as the malformed scope it is.
//
// Checking 2 before 3 is what makes `write global::my-key "value"` (shorthand +
// value) and `write global my-key "value"` (scope + key + value) BOTH resolve
// correctly from two-and-three positionals: `global::my-key` is not a valid
// scope, `global` is.
//
// Returns `{ scope, key, consumed }`. `scope` is '' and `key` null when nothing
// was supplied; the caller decides whether that is a usage error (`write`,
// `show`) or a default (`link`).
export function resolveScopeKeyArgs(positionals = [], options = {}) {
  const { scope: scopeFlag, key: keyFlag, isScope = isScopeString } = options;
  const at = (i) => (typeof positionals[i] === 'string' ? positionals[i].trim() : '');
  const fScope = typeof scopeFlag === 'string' ? scopeFlag.trim() : '';
  const fKey = typeof keyFlag === 'string' ? keyFlag.trim() : '';

  if (fScope && fKey) return { scope: fScope, key: fKey, consumed: 0 };
  if (fScope) {
    const key = at(0);
    return { scope: fScope, key: key || null, consumed: key ? 1 : 0 };
  }
  if (fKey) {
    const scope = at(0);
    return { scope, key: fKey, consumed: scope ? 1 : 0 };
  }

  const first = at(0);
  if (!first) return { scope: '', key: null, consumed: 0 };

  if (isScope(first)) {
    const key = at(1);
    return { scope: first, key: key || null, consumed: key ? 2 : 1 };
  }

  const { scope, key } = resolveScopeArg(first, isScope);
  return { scope: scope || '', key, consumed: 1 };
}
