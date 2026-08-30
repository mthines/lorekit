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
// The rule: scan the `::` boundaries left-to-right and split at the FIRST one
// whose left side is a COMPLETE valid scope — otherwise the whole arg is the
// scope. Because `::` is RESERVED as the segment separator (no scope segment may
// contain it, enforced by `scopeIssue`), no valid scope is a `::`-boundary
// prefix of another, so the earliest valid-scope prefix is unambiguously THE
// scope and everything after it is the key — even a key that itself contains
// `::` (a namespaced key like `implement-suggestion-lessons::documenting-…`).
//
// This first-valid scan superseded a plain last-`::` split, which broke exactly
// that case: `global::foo-lessons::bar` split at the last `::` gave the left
// side `global::foo-lessons`, not a valid scope, so the whole arg fell through
// to the scope and `scopeIssue` rejected it. Gating on a valid left side is what
// keeps a bare `repo::owner/name` from mis-splitting (its `repo` prefix is not a
// valid scope) and a multi-segment scope whole (`branch::o/n::main::key` → scope
// `branch::o/n::main`, key `key`, since the shorter prefixes are all invalid). A
// malformed arg falls through to the scope, never a fabricated key.
//
// `isScope` is injected rather than closed over so the module stays trivially
// testable with a stub predicate; callers pass `isScopeString`.
export function resolveScopeArg(arg, isScope = isScopeString) {
  const s = typeof arg === 'string' ? arg.trim() : '';
  if (!s) return { scope: null, key: null };
  for (let idx = s.indexOf('::'); idx !== -1; idx = s.indexOf('::', idx + 2)) {
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
// The score is a weighted sum of four factors, each normalised to [0,1]:
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
//   outcome   — applied/resolution history in [0,1]. The factor only ever
//               LIFTS: a lesson tagged on an outcome bus scores 1.0 and one
//               carried to a PR 0.75, while a lesson with no history gets the
//               COLD_START_OUTCOME_PRIOR (0.5) — the neutral floor, never 0.
//               So a proven lesson ranks up; an unproven one is not penalised
//               for lacking history and rides on recency and relevance.
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

// Equal quarters. Deliberately not tuned: with no corpus to tune against, an
// invented weighting is a guess wearing a decimal point. They are a parameter
// so a caller can experiment, and so a future PR can change them with evidence.
//
// FROZEN. An exported mutable object is shared state, and this one is the
// fallback the totality guarantee rests on: a caller that zeroed its fields
// turned `scoreLesson`'s "fall back to the defaults" branch into unbounded
// recursion (a real `RangeError`, raised inside a hook the header promises will
// never throw). Freezing makes the corruption a `TypeError` at the assignment,
// in the caller's own frame, instead of a stack overflow three layers down.
export const DEFAULT_RANK_WEIGHTS = Object.freeze({ recency: 1, salience: 1, relevance: 1, outcome: 1 });

/**
 * The cold-start prior for the outcome factor. A new lesson with no applied /
 * resolution history gets this value rather than 0. The rationale: scoring
 * absent outcome at 0 would sink every new lesson below stale ones purely for
 * lacking outcome history (outcome-lag). 0.5 is the neutral midpoint of [0,1]
 * — a cold lesson contributes an average outcome term, so it ranks on
 * recency and relevance instead of being penalised for being new.
 *
 * This is the ONE deliberate asymmetry vs `normalizeRelevance` (which returns
 * 0 for absent / unreadable input). Mirrored byte-identically in
 * `packages/mcp-core/src/ranking/lesson-rank.ts` and its edge twin.
 */
export const COLD_START_OUTCOME_PRIOR = 0.5;

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
 * `terms` is a list, a lone term, or any `Set` — every form is normalised the
 * same way, so `new Set([' Timeout '])` and `[' Timeout ']` score identically.
 * Normalisation is NOT a caller responsibility and there is no pre-normalised
 * fast path on this function: an unnormalised `Set` reaching the matcher scored
 * `''` as a match on everything and a padded term as a match on nothing.
 * `rankLessons` gets the once-per-ranking saving from the internal
 * `relevanceFromTerms` instead, where the set is one this module built.
 */
export function relevanceFactor(entry, terms) {
  return relevanceFromTerms(entry, distinctTerms(terms));
}

// The matcher, over a set this module has already normalised. Internal on
// purpose: it is the seam that lets `rankLessons` normalise the query ONCE for
// the whole ranking instead of once per candidate (O(entries × terms) for a
// result that cannot differ between entries) without turning "hand me a
// correctly-shaped Set" into part of the public contract.
function relevanceFromTerms(entry, distinct) {
  if (distinct.size === 0) return 0;
  let hits = 0;
  for (const term of distinct) if (matchesQuery(entry, term)) hits += 1;
  return hits / distinct.size;
}

// The caller's query as a set of distinct, lowercased, non-empty terms. Accepts
// a list, a `Set`, or a lone value, and normalises the CONTENTS in every case —
// an earlier version short-circuited on `instanceof Set`, which let a
// hand-built set skip trimming and empty-filtering and diverge from the list
// path.
function distinctTerms(terms) {
  const list = Array.isArray(terms) || terms instanceof Set ? [...terms] : [terms];
  return new Set(
    list
      .map((t) => String(t == null ? '' : t).toLowerCase().trim())
      .filter(Boolean),
  );
}

/**
 * Normalize an outcome value into [0,1]. Absent or unreadable input returns
 * `COLD_START_OUTCOME_PRIOR` — the deliberate asymmetry vs `normalizeRelevance`
 * (which returns 0 for absent input). A present value is clamped to [0,1].
 *
 * The cold-start prior ensures a new lesson with no outcome history is not
 * penalised during outcome-lag — it contributes an average outcome term and
 * ranks on recency + relevance instead.
 */
export function normalizeOutcome(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return COLD_START_OUTCOME_PRIOR;
  return Math.min(1, Math.max(0, n));
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
 * than dividing by zero — ONCE, by substitution rather than by recursion. The
 * recursive form was total only while `DEFAULT_RANK_WEIGHTS` still summed above
 * zero, which made a totality guarantee depend on an exported object nobody had
 * mutated yet. If even the defaults are degenerate every lesson scores 0, which
 * is honest (no weighted signal is left) and hands the ordering to the
 * tiebreakers instead of to a stack overflow.
 */
export function scoreLesson(entry, {
  terms = [],
  now = Date.now(),
  weights = DEFAULT_RANK_WEIGHTS,
  maxSeenCount = 0,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS,
} = {}) {
  return scoreWithTerms(entry, distinctTerms(terms), { now, weights, maxSeenCount, halfLifeDays });
}

// `scoreLesson` with the query already normalised. `rankLessons` calls this so
// the whole ranking normalises the query once; `scoreLesson` normalises and
// delegates, so no caller has to know a normalised set exists.
function scoreWithTerms(entry, termSet, { now, weights, maxSeenCount, halfLifeDays }) {
  let w = {
    recency: numberOr(weights?.recency, DEFAULT_RANK_WEIGHTS.recency),
    salience: numberOr(weights?.salience, DEFAULT_RANK_WEIGHTS.salience),
    relevance: numberOr(weights?.relevance, DEFAULT_RANK_WEIGHTS.relevance),
    outcome: numberOr(weights?.outcome, DEFAULT_RANK_WEIGHTS.outcome),
  };
  let total = w.recency + w.salience + w.relevance + w.outcome;
  if (!(total > 0)) {
    w = {
      recency: numberOr(DEFAULT_RANK_WEIGHTS.recency, 0),
      salience: numberOr(DEFAULT_RANK_WEIGHTS.salience, 0),
      relevance: numberOr(DEFAULT_RANK_WEIGHTS.relevance, 0),
      outcome: numberOr(DEFAULT_RANK_WEIGHTS.outcome, 0),
    };
    total = w.recency + w.salience + w.relevance + w.outcome;
  }
  if (!(total > 0)) return 0;
  const recency = recencyFactor(entry?.updatedAt ?? entry?.updated_at ?? entry?.updated, now, halfLifeDays);
  const salience = salienceFactor(seenCountFrom(entry), maxSeenCount);
  const relevance = relevanceFromTerms(entry, termSet);
  const outcome = normalizeOutcome(entry?.outcome);
  return (w.recency * recency + w.salience * salience + w.relevance * relevance + w.outcome * outcome) / total;
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
 * MMR λ (lambda) — weight given to relevance vs diversity in the MMR objective.
 * At 0.7 the selector favours relevance, with 0.3 of the budget for diversity.
 * Anchored to Carbonell & Goldstein (1998), the original MMR paper.
 * Mirrored byte-identically in the edge twin and `packages/mcp-core/src/ranking/lesson-rank.ts`.
 */
export const MMR_LAMBDA = 0.7;

/**
 * Tokenise a lesson `value` into a deduplicated Set: case-fold, split on
 * non-alphanumeric characters, drop empties. Dependency-free and deterministic
 * so it mirrors the TS/Deno twin's `tokenizeValue`.
 *
 * PERF: `selectDiverse` calls this ONCE per candidate before the MMR loop and
 * caches the result. `jaccardSimilarity` takes the cached Sets, so the O(k²)
 * pairwise comparisons inside the loop cost no tokenisation. Do NOT re-introduce
 * a `tokenize(value)` call inside the loop: that regresses the hot path to
 * O(n·k²) tokenisations (measured 34s CPU at n=200/k=100 with 1.5KB values).
 */
function tokenizeValue(v) {
  const tokens = String(v ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(tokens);
}

/**
 * Word/token Jaccard similarity between two PRE-TOKENISED value Sets:
 * |A∩B| / |A∪B|. Both-empty → 0.
 *
 * Takes Sets rather than raw values on purpose — the caller tokenises each
 * candidate once (see `tokenizeValue`) so this stays allocation-free on the
 * O(k²) hot path.
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Select the top-K lessons from a ranked list using Maximal Marginal Relevance
 * (Carbonell & Goldstein, 1998).
 *
 * Accepts bare entries (the shape `rankLessons` returns in the `.mjs` twin)
 * plus a parallel `scores` array — REQUIRED, one score per entry. This is the
 * MMR relevance term; there is no meaningful default. A missing `scores`, a
 * non-array, or a length that does not match `entries` throws rather than
 * silently defaulting to 0 for every entry (which would degrade selection to
 * pure diversity and quietly discard the ranking). The TS twin cannot hit this
 * footgun — it reads the score off each `{ entry, score }` input.
 *
 * Greedy MMR: seed with index 0 (highest-ranked), then at each step pick
 * the unselected candidate that maximises
 *   λ·quantise(score(i)) − (1−λ)·max_{j∈selected} jaccardSimilarity(value_i, value_j)
 * Ties break by input order (first-wins) for determinism.
 *
 * SCORE QUANTISATION: the relevance term uses the score SNAPPED onto the
 * `SCORE_EPSILON` grid — the exact grid `rankLessons` buckets on for its
 * scope-precedence tie-break. Two scores within `SCORE_EPSILON` land in the same
 * bucket, so the MMR objective sees them as equal and the input order (which
 * `rankLessons` already sorted by scope precedence, then key) decides. Comparing
 * the RAW score would let a 1e-10 float difference override scope precedence.
 *
 * PERF — the algorithm is O(n·k), and BOTH factors that could regress it to
 * O(n·k²) are held down explicitly:
 *   1. TOKENISE axis: each candidate's `value` is tokenised ONCE up front (the
 *      `tokens` field) so the pairwise Jaccard comparisons never tokenise —
 *      O(n) tokenisations total. See `tokenizeValue`.
 *   2. INTERSECTION axis: each remaining candidate carries a RUNNING `maxSim`
 *      (its greatest Jaccard similarity to anything selected so far). The
 *      objective reads that cached scalar — it does NOT loop over `selected`.
 *      After each pick we update `maxSim` for the still-remaining candidates
 *      against the ONE just-selected entry only. That is k picks × n candidates
 *      = O(n·k) Jaccard intersections total, not O(n·k²).
 * Re-introducing either an in-loop `tokenizeValue` call OR an inner
 * `for (… of selected)` maxSim recomputation silently restores O(n·k²) —
 * measured 2.6s CPU at n=200/k=100 vs 58ms for the running form. Don't.
 *
 * Always-on for ranked mode — no optional param needed. The recency wire path is
 * never affected.
 */
export function selectDiverse(entries, k, { lambda: lambdaOpt, scores } = {}) {
  // Match the TS twin: fall back to MMR_LAMBDA unless `lambda` is a FINITE
  // number. A bare destructuring default only catches `undefined`, so
  // `{ lambda: NaN }` would otherwise poison every MMR objective here while the
  // TS twin quietly used MMR_LAMBDA — a silent cross-twin divergence.
  const lambda = typeof lambdaOpt === 'number' && Number.isFinite(lambdaOpt) ? lambdaOpt : MMR_LAMBDA;
  if (!Array.isArray(entries) || entries.length === 0 || k <= 0) return [];
  if (!Array.isArray(scores) || scores.length !== entries.length) {
    throw new TypeError(
      `selectDiverse: \`scores\` must be an array with one score per entry `
        + `(got ${Array.isArray(scores) ? `length ${scores.length}` : typeof scores} `
        + `for ${entries.length} entries)`,
    );
  }
  const selected = [];
  // Pre-tokenise every candidate ONCE and snap its score onto the SCORE_EPSILON
  // grid up front. `maxSim` is the running greatest Jaccard similarity to any
  // already-selected entry — 0 while nothing is selected. The loop below reads
  // these caches; it never tokenises, re-quantises, or rescans `selected`.
  const remaining = entries.map((e, i) => ({
    entry: e,
    tokens: tokenizeValue(e?.value),
    qScore: Math.round((scores[i] ?? 0) / SCORE_EPSILON) * SCORE_EPSILON,
    maxSim: 0,
  }));
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      // Reads the cached running maxSim — no inner scan over `selected`.
      const mmr = lambda * candidate.qScore - (1 - lambda) * candidate.maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    const [justSelected] = remaining.splice(bestIdx, 1);
    selected.push(justSelected.entry);
    // Fold the just-selected entry into every remaining candidate's running
    // maxSim — one Jaccard per remaining candidate per pick, so O(n·k) total.
    for (const candidate of remaining) {
      const sim = jaccardSimilarity(candidate.tokens, justSelected.tokens);
      if (sim > candidate.maxSim) candidate.maxSim = sim;
    }
  }
  return selected;
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
 *
 * That tie is applied by QUANTISING each score onto a `SCORE_EPSILON` grid, not
 * by an `abs(a - b) <= SCORE_EPSILON` comparison. The comparison form reads
 * more naturally and is wrong: approximate equality is not TRANSITIVE, so three
 * scores a grid-step apart give a≈b, b≈c and c>a, the comparator stops being a
 * strict weak ordering, and the result depends on the order the rows arrived in
 * — exactly the determinism this docblock claims. Measured before the fix:
 * three lessons 3ms apart produced three different orderings across the six
 * permutations of one input. Rounding first makes "same score" an equivalence
 * relation, so the scope/key tiebreak is what decides every near tie.
 *
 * The residual cost is a boundary: two scores closer than a grid step can still
 * land in adjacent buckets and be ordered by score. That is unavoidable for any
 * transitive notion of approximate equality, and it is a far smaller defect
 * than an ordering that changes with input order.
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
  // `scoreWithTerms` takes the set this module built straight through.
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
    // The score rounded onto the SCORE_EPSILON grid. Comparing THIS rather than
    // the raw score is what keeps "close enough to be a tie" transitive — see
    // the docblock. A score is in [0,1] and the grid is 1e-9, so the bucket is
    // always a safe integer.
    bucket: Math.round(
      scoreWithTerms(entry, termSet, { now, weights, maxSeenCount, halfLifeDays }) / SCORE_EPSILON,
    ),
    scopeRank: rankByScope.has(entry.scope) ? rankByScope.get(entry.scope) : Number.MAX_SAFE_INTEGER,
    key: String(entry.key ?? ''),
  }));

  scored.sort((a, b) => {
    if (a.bucket !== b.bucket) return b.bucket - a.bucket;
    if (a.scopeRank !== b.scopeRank) return a.scopeRank - b.scopeRank;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.index - b.index; // stable: equal in every respect keeps input order
  });

  return scored.map((s) => s.entry);
}

/**
 * Rank-then-diversify in one call — the `.mjs` twin's convenience for what the
 * TS twin gets for free by carrying `{ entry, score }` pairs into `selectDiverse`.
 *
 * `selectDiverse` needs a parallel `scores` array, and those scores MUST be the
 * same set-relative values the list was sorted on: the salience factor is
 * normalised against the max `seen_count` in the candidate SET, so a score
 * recomputed over a different population would not line up with the order. This
 * helper recomputes the scores over exactly the list it diversifies, beside the
 * unexported `seenCountFrom`/`scoreWithTerms`, so callers can apply MMR without
 * reconstructing that alignment (and without `seenCountFrom` leaking out).
 *
 * `entries` is expected to be `rankLessons` output (best-first) so the seed of
 * the greedy MMR is the top-ranked lesson; the pass-through
 * `terms`/`weights`/`halfLifeDays`/`now` MUST match the `rankLessons` call that
 * produced it, or the recomputed scores diverge from the sort. `k` caps the
 * returned count (default: all). Empty/degenerate input returns `[]`.
 */
export function diversifyRankedLessons(entries = [], {
  terms = [],
  now = Date.now(),
  weights = DEFAULT_RANK_WEIGHTS,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS,
  k = Infinity,
  lambda,
} = {}) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  if (list.length === 0) return [];
  const termSet = distinctTerms(terms);
  let maxSeenCount = 0;
  for (const e of list) maxSeenCount = Math.max(maxSeenCount, seenCountFrom(e));
  const scores = list.map((e) => scoreWithTerms(e, termSet, { now, weights, maxSeenCount, halfLifeDays }));
  // `numberOr` is the module's coercion convention: a non-finite `k` (the
  // `Infinity` default, `null`, or a stringy `'40'`) resolves to a real cap —
  // the default falls through to the whole list, `'40'` becomes 40 — rather than
  // silently returning everything on a shape a caller plausibly passes.
  const limit = numberOr(k, list.length);
  return selectDiverse(list, limit, { scores, lambda });
}

/**
 * The loop BUCKET a lesson belongs to, or null for a general (non-loop) lesson.
 *
 * A self-improvement loop writes into a `loop::<bucket>` tag namespace
 * (`loop::review-outcomes`, `loop::implement-suggestion-lessons`, …) — the
 * bucket convention `lorekit-setup` installs. Those lessons are a host's PRIVATE
 * working memory, read back by that host through a tag filter; a general session
 * reading a whole scope should not let one prolific loop's bookkeeping take
 * every slot. Returns the first `loop::`-prefixed tag — the group key a cap
 * counts against, matching `inferKindHost`'s first-recognised-wins order — or
 * null when the lesson carries no loop tag (general knowledge, never capped).
 * Keys on the `loop::` PREFIX convention ONLY; it re-encodes no specific bucket
 * name, so a new loop bucket groups correctly without a code change here.
 */
export function loopBucketOf(entry) {
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const tag = t.trim();
    if (tag.startsWith('loop::') && tag.length > 'loop::'.length) return tag;
  }
  return null;
}

/**
 * Cap how many lessons any one bucket may contribute, preserving input order.
 *
 * Walks the (already-ranked) list once: a lesson whose `bucketOf` is null is
 * ALWAYS kept — those are the general lessons the cap exists to protect — and a
 * bucketed lesson is kept only while its bucket is still under `cap`. So one
 * loop's dozen recent rows no longer evict every general lesson; at most `cap`
 * of them survive and the freed slots go to the next-ranked variety. Pure and
 * total: a non-array input is []; `cap: 0` drops every bucketed lesson (read
 * ONLY general knowledge) while still keeping the null-bucket ones — a negative
 * cap is not finite-and-non-negative, so `numberOr` reads it as "no cap", not as
 * a stricter zero; a missing
 * `bucketOf` treats everything as general (a no-op cap). `cap` is coerced with
 * the module's `numberOr` convention (as `diversifyRankedLessons` does for `k`),
 * so a `NaN`/absent cap falls back to "no cap" rather than silently dropping
 * every bucketed lesson, while a stringy `'2'` still caps.
 */
export function capPerBucket(entries, { cap = Infinity, bucketOf } = {}) {
  if (!Array.isArray(entries)) return [];
  const of = typeof bucketOf === 'function' ? bucketOf : () => null;
  const limit = numberOr(cap, Infinity);
  const counts = new Map();
  const out = [];
  for (const e of entries) {
    const bucket = of(e);
    if (bucket == null) {
      out.push(e);
      continue;
    }
    const n = counts.get(bucket) ?? 0;
    if (n < limit) {
      counts.set(bucket, n + 1);
      out.push(e);
    }
  }
  return out;
}
