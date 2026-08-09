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

// ── ranking: which lessons are worth the context budget ──────────────────────
//
// `resolvePrecedence` above answers "which SCOPE's copy of a key wins". This
// answers the different question the injection path actually has: given the
// winners, which ones does a reader most need to see FIRST.
//
// It exists because ordering by recency alone is actively harmful on a busy
// repo. The newest cluster of writes is usually one task's iteration log — a
// dozen near-identical one-off lessons — and under a recency sort that cluster
// takes every slot, evicting the durable lessons that have been re-learned a
// dozen times. Recency is a signal, not the ranking.
//
// The score is a weighted sum of three factors, each normalised to [0,1]:
//
//   recency   — exponential decay on age. Half-life, not a cliff: a lesson does
//               not stop mattering on a particular day.
//   salience  — log(1 + seenCount), normalised across the candidate set. A
//               lesson written eight times has been re-learned; one written
//               once may just be noise. Logarithmic because the interesting
//               step is 1 → 3, not 40 → 42, and normalised across the set
//               because "recurring" only means anything relative to its peers.
//   relevance — how much of the caller's query this lesson matches. Exactly 0
//               when no terms are supplied, which is the SessionStart case: it
//               then contributes the same constant to every candidate and the
//               ordering is recency + salience alone.
//
// PURE AND TOTAL, with one scoped exception. `now` is a PARAMETER: the
// arithmetic never reads the clock, every factor is a function of the value
// passed in, and a caller that supplies one gets a ranking that is exactly
// reproducible in a test and in a bug report. `scoreLesson` and `rankLessons`
// default it to `Date.now()` at the call boundary so the common caller need not
// thread a clock through — that default is the ONLY clock read, it happens once
// per call, and passing `now` explicitly removes it. Every missing or malformed
// field degrades to its zero rather than throwing — this runs on the
// SessionStart hot path behind a hook that must exit 0, and losing the whole
// injection to save one unparseable timestamp is a bad trade.

// Age at which a lesson's recency factor halves. Two weeks is roughly the span
// over which a repo's "what am I working on" context turns over: yesterday's
// lesson should clearly outrank last month's, without last month's dropping to
// nothing — a year-old lesson that has recurred 30 times still deserves a slot.
export const RECENCY_HALF_LIFE_DAYS = 14;

// Equal thirds. Deliberately not tuned: with no corpus to tune against, an
// invented weighting is a guess wearing a decimal point. They are a parameter
// so a caller can experiment, and so a future PR can change them with evidence.
export const DEFAULT_RANK_WEIGHTS = { recency: 1, salience: 1, relevance: 1 };

// Two scores closer than this are the same score. Sized well below any
// difference the factors can produce meaningfully (a one-second age gap moves a
// score by ~1e-6 at the default half-life) and well above float noise.
export const SCORE_EPSILON = 1e-9;

const MS_PER_DAY = 86400000;

// Milliseconds since the epoch for a value that may be an ISO string, a Date, a
// number, or junk. `null` when it cannot be read as a time — never NaN, which
// would propagate silently through the arithmetic below and sort the entry to
// wherever NaN happens to land.
function timeOf(value) {
  if (value == null || value === '') return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Recency factor in [0,1]: 1 for something written now, 0.5 at one half-life.
 *
 * An unknown timestamp scores 0, NOT 0.5. The alternative — treating unknown as
 * average — would let a lesson with no `updatedAt` outrank a real one that is
 * merely a month old, on the strength of having less information about it.
 *
 * A FUTURE timestamp is clamped to 1 rather than allowed to exceed it. Clock
 * skew between a writer and a reader is ordinary; a lesson from thirty seconds
 * in the future is simply new, and letting age go negative would hand it an
 * unbounded score that beats every honestly-dated lesson in the set.
 */
export function recencyFactor(updatedAt, now, halfLifeDays = RECENCY_HALF_LIFE_DAYS) {
  const t = timeOf(updatedAt);
  const nowMs = timeOf(now);
  if (t === null || nowMs === null) return 0;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0
    ? halfLifeDays
    : RECENCY_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.exp((-Math.LN2 * ageDays) / halfLife);
}

/**
 * Salience factor in [0,1] — recurrence, relative to the most-recurring lesson
 * in the same candidate set.
 *
 * `maxSeenCount` is passed in rather than derived here because the factor is
 * only meaningful within a set: eight sightings is remarkable next to a set of
 * one-offs and unremarkable next to a set of hundreds. `rankLessons` computes
 * it once for the whole set.
 *
 * A set whose maximum is 0 or 1 yields 0 for every member — no lesson in it has
 * recurred, so salience has nothing to say and the other factors decide. Note
 * this makes a set of all-one-offs rank purely on recency, which is correct:
 * the ranking only claims to separate recurring from non-recurring.
 *
 * A `seenCount` ABOVE `maxSeenCount` is clamped to 1 rather than allowed to
 * exceed it, for the same reason `recencyFactor` clamps a future timestamp.
 * `rankLessons` derives the maximum from the set, so in-set the clamp never
 * binds; it binds when a caller reaches this (or `scoreLesson`) directly with a
 * maximum that is not the set's, and without it the `[0,1]` both docblocks
 * promise would simply be false — `salienceFactor(5, 2)` is 1.63.
 */
export function salienceFactor(seenCount, maxSeenCount) {
  const n = Number.isFinite(seenCount) ? Math.max(0, seenCount) : 0;
  const max = Number.isFinite(maxSeenCount) ? Math.max(0, maxSeenCount) : 0;
  if (max <= 1) return 0;
  return Math.min(1, Math.log1p(n) / Math.log1p(max));
}

/**
 * Relevance factor in [0,1] — the fraction of the caller's terms this lesson
 * matches.
 *
 * Matching is `matchesQuery`'s: a LITERAL, case-insensitive substring of the
 * key or the value. That is the same primitive `search` and the failure hook
 * use, so a lesson that a `lorekit search <term>` would surface is a lesson
 * this ranks up — one matcher, one meaning of "matches".
 *
 * The fraction is over DISTINCT terms, so a term repeated in the caller's list
 * cannot inflate a lesson's score, and it is a fraction rather than a count so
 * a three-term query and a ten-term query produce comparable numbers.
 *
 * Empty terms is 0, never 1. This is the SessionStart case and it must not
 * silently become "everything is maximally relevant" — which, being a constant,
 * would not change the ORDER but would compress the score range and make every
 * downstream threshold meaningless.
 *
 * `terms` may be a raw list OR an already-normalised `Set` from
 * `distinctTerms`. `rankLessons` passes the Set so the query is normalised once
 * per ranking rather than once per candidate; a caller with a list is
 * unaffected and passing one is still correct.
 */
export function relevanceFactor(entry, terms) {
  const distinct = distinctTerms(terms);
  if (distinct.size === 0) return 0;
  let hits = 0;
  for (const term of distinct) if (matchesQuery(entry, term)) hits += 1;
  return hits / distinct.size;
}

// The caller's query as a set of distinct, lowercased, non-empty terms.
//
// Idempotent by design: a `Set` is returned as-is, which is what lets
// `rankLessons` normalise once and hand the SAME set to every candidate. This
// module's whole reason to exist is the SessionStart hot path, and rebuilding
// the set per entry made the query's normalisation O(entries × terms) for a
// result that cannot differ between entries.
function distinctTerms(terms) {
  if (terms instanceof Set) return terms;
  const list = Array.isArray(terms) ? terms : [terms];
  return new Set(
    list
      .map((t) => String(t == null ? '' : t).toLowerCase().trim())
      .filter(Boolean),
  );
}

/**
 * Score one lesson in [0,1].
 *
 * `maxSeenCount` belongs to the candidate SET, so this is normally reached
 * through `rankLessons` rather than called directly; it is exported so a caller
 * can explain a ranking ("why is this one third?") without re-deriving the
 * arithmetic.
 *
 * The weighted sum is divided by the total weight, so the result stays in [0,1]
 * whatever weights are supplied and two runs with different weightings remain
 * comparable. A weight set that sums to zero falls back to the defaults rather
 * than dividing by zero.
 */
export function scoreLesson(entry, {
  terms = [],
  now = Date.now(),
  weights = DEFAULT_RANK_WEIGHTS,
  maxSeenCount = 0,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS,
} = {}) {
  const w = {
    recency: numberOr(weights?.recency, DEFAULT_RANK_WEIGHTS.recency),
    salience: numberOr(weights?.salience, DEFAULT_RANK_WEIGHTS.salience),
    relevance: numberOr(weights?.relevance, DEFAULT_RANK_WEIGHTS.relevance),
  };
  const total = w.recency + w.salience + w.relevance;
  if (!(total > 0)) {
    return scoreLesson(entry, { terms, now, weights: DEFAULT_RANK_WEIGHTS, maxSeenCount, halfLifeDays });
  }
  const recency = recencyFactor(entry?.updatedAt ?? entry?.updated_at ?? entry?.updated, now, halfLifeDays);
  const salience = salienceFactor(seenCountFrom(entry), maxSeenCount);
  const relevance = relevanceFactor(entry, terms);
  return (w.recency * recency + w.salience * salience + w.relevance * relevance) / total;
}

// A non-negative finite number, or the fallback. Guards a caller passing a
// string, null, or NaN as a weight.
function numberOr(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The recurrence count off an entry, in either the store-projected form
// (`seenCount`, what `store/entry-fields.mjs` produces) or the raw REST/
// frontmatter spelling. Anything unreadable is 0 — no evidence of recurrence,
// which is not the same claim as one sighting.
function seenCountFrom(entry) {
  const raw = entry?.seenCount ?? entry?.seen_count;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Rank lessons best-first, returning a NEW array — the input is never reordered
 * in place, because callers hold it (`fetchLessons` builds it from the
 * precedence resolution and `tree` renders the same objects).
 *
 * Ties are broken deterministically, and the order of the tiebreakers is the
 * design:
 *
 *   1. score, descending.
 *   2. SCOPE PRECEDENCE — the position of the entry's scope in `scopeOrder`,
 *      which defaults to the order scopes first appear in the input. That
 *      default is not a convenience: `fetchLessons` hands entries over in
 *      `readOrder`, most-specific first, so the default IS the precedence
 *      hierarchy, and a project lesson beats a global one it ties with, for
 *      free and without this module knowing what a scope is.
 *   3. key, lexicographically — the last resort, so the answer cannot depend on
 *      hash iteration order or on which page a row arrived in.
 *
 * Sorting on floats makes exact ties rarer than they look, so tiebreaker 2 also
 * quietly matters for NEAR ties: two lessons written in the same minute with
 * the same count differ in the tenth decimal place, which is noise, not a
 * preference. `SCORE_EPSILON` treats a difference that small as a tie so the
 * meaningful tiebreaker decides instead of floating-point dust.
 */
export function rankLessons(entries = [], {
  terms = [],
  now = Date.now(),
  weights = DEFAULT_RANK_WEIGHTS,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS,
  scopeOrder = null,
} = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  if (list.length === 0) return [];

  // Normalise the query ONCE for the whole ranking, not once per candidate —
  // `relevanceFactor` takes the set straight through.
  const termSet = distinctTerms(terms);

  // One pass for the set-relative normaliser, so scoring stays O(n).
  let maxSeenCount = 0;
  for (const e of list) maxSeenCount = Math.max(maxSeenCount, seenCountFrom(e));

  // Scope precedence: an explicit order wins, else first-appearance order.
  const rankByScope = new Map();
  for (const s of Array.isArray(scopeOrder) ? scopeOrder : []) {
    if (!rankByScope.has(s)) rankByScope.set(s, rankByScope.size);
  }
  for (const e of list) {
    const s = e.scope;
    if (s !== undefined && !rankByScope.has(s)) rankByScope.set(s, rankByScope.size);
  }

  const scored = list.map((entry, index) => ({
    entry,
    index,
    score: scoreLesson(entry, { terms: termSet, now, weights, maxSeenCount, halfLifeDays }),
    scopeRank: rankByScope.has(entry.scope) ? rankByScope.get(entry.scope) : Number.MAX_SAFE_INTEGER,
    key: String(entry.key ?? ''),
  }));

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > SCORE_EPSILON) return b.score - a.score;
    if (a.scopeRank !== b.scopeRank) return a.scopeRank - b.scopeRank;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.index - b.index; // stable: equal in every respect keeps input order
  });

  return scored.map((s) => s.entry);
}

