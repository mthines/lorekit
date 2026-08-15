// Shared hook logic: fetch and format lessons; build the nudge text.
// Framework-agnostic — adapters shape these strings into each tool's contract.
// Storage is reached through the resolved store (local | remote), never a
// backend directly, so the same read path serves every mode.
import { deriveScope } from '../scope.mjs';
// The cross-scope precedence merge comes from the dependency-free
// `lessons-pure.mjs` — the SAME `resolvePrecedence` `tree` uses, so the hook
// can't drift from it, and the hot path never pulls in the `lessons-view.mjs`
// render/`util` stack. (Failure-relevance matching is the store's job now, so
// the hook no longer needs `matchesQuery` — `search` still does.)
// `rankLessons` comes from the same dependency-free module for the same reason:
// the injected set is chosen by ONE scorer, and a future `memory.relevant` verb
// must be able to reuse it rather than grow a second ranking with its own idea
// of what "most useful" means.
import {
  resolvePrecedence, rankLessons, diversifyRankedLessons, capPerBucket, loopBucketOf,
} from '../lessons-pure.mjs';
// The store's own scope inventory, normalised — the SAME helper `memory.scopes`
// uses, so the map and the MCP tool cannot disagree about what a scope holds or
// about what a failed enumeration looks like.
import { readScopeInventory } from '../store/scope-inventory.mjs';
// The deep-link builder is the SAME pure module the `link` command and the
// `--link` flag use, so the hook's confirmation/nudge links are JSON-encoded
// correctly (a raw `?scope=global` silently means "all scopes") and can't drift
// from the command-line links.
import { loreScopeUrl, buildLessonUrl } from '../deeplink-pure.mjs';
// The SAME resolver `lorekit write` applies, so the TTL the nudge advises an
// agent to send is byte-for-byte the one the CLI would have applied itself. A
// hook cannot set a TTL — it only reads and emits text; the write happens later,
// over MCP, in the agent's context. Advising the number is the only lever the
// hook has, which is exactly why it must not be a second, hand-kept copy.
import { resolveDefaultTtlDays, matchesScopePrefix } from '../store/ttl.mjs';
// The budget default lives with the rest of the config vocabulary in
// `control.mjs`, so the resolver and the renderer cannot disagree about what an
// unconfigured workspace gets. `formatLessons` is called directly by tests and
// by the no-store path in `hook.mjs`, so it needs its own fallback rather than
// relying on every caller to pass one.
import {
  DEFAULT_SESSION_START_LOOP_CAP,
  DEFAULT_SESSION_START_MAX_CHARS,
  DEFAULT_SESSION_START_MAX_LESSONS,
  MAX_SESSION_START_MAX_LESSONS,
  SESSION_START_MODES,
} from '../control.mjs';
import { FRICTION_FAILURE, FRICTION_STUCK_LOOP } from './friction.mjs';

// THE INJECTED SET IS BOUNDED BY A CHARACTER BUDGET, NOT BY A COUNT.
//
// It used to be `MAX_LESSONS = 15` — a number with no derivation. Fifteen of
// what? A fifteen-line index of terse keys and a fifteen-line index of long ones
// differ by an order of magnitude in what they cost the context window, and the
// number said nothing about either. Worse, it was a HARD floor as well as a
// ceiling: a workspace with six lessons and a workspace with six hundred both
// got fifteen, so the small store was padded to a number and the large one was
// truncated to it, silently, with no way for the reader to know which had
// happened.
//
// What actually matters is how much of the window the block occupies, so that is
// what is spent. `hooks.sessionStart.maxChars` (control.mjs) sets it; the shape
// the remainder takes is `hooks.sessionStart`. Characters, not tokens: a real
// tokenizer is a dependency this package does not have and will not take, and
// the ~4-chars-per-token heuristic is accurate enough for a budget whose job is
// to bound an order of magnitude.
//
// The LINE ceiling is the second bound, from the other direction. A budget alone
// cannot stop a store of 500 one-word keys from rendering 400 lines inside it,
// and a 400-line index is unreadable however few characters it costs. At its
// default (`DEFAULT_SESSION_START_MAX_LESSONS`, 100) it sits well above any block
// a default `maxChars` can fill, so in normal operation it never binds as a
// RENDER bound — its working job is to set the depth of the fetch (see
// `scopeReadLimit`), and bounding the worst-case line count is the backstop.
//
// It is CONFIGURABLE (`hooks.sessionStart.maxLessons`), which is why the two
// numbers are separate: the config is a preference, and `HARD_LESSON_CEILING` is
// the absolute clamp no caller can exceed — the same 200 the config normaliser
// clamps to, applied a second time here because `fetchLessons`/`formatLessons`
// take `maxLessons` as a plain option and a direct caller never passes through
// that normaliser.
const HARD_LESSON_CEILING = MAX_SESSION_START_MAX_LESSONS;

// The line ceiling a caller actually gets: their `maxLessons` ROUNDED (not
// truncated — `Math.round`, so 40.6 becomes 41) and clamped into
// [1, HARD_LESSON_CEILING], or the default when the value is unusable. `1` and
// not the config floor of 3 — this is the last-resort clamp on an already
// normalised number, and a caller that deliberately asks for one line should get
// one, not three. Pure.
//
// UNUSABLE INCLUDES ZERO AND NEGATIVES, not just NaN, and that is the whole
// reason this reads as it does rather than as a bare `Math.max(1, …)`.
// `Number(null)` is `0` and `Number('')` is `0`, so a caller passing an explicit
// `maxLessons: null` — which the option default does NOT catch, since only
// `undefined` triggers a destructuring default — would clamp UP to a ONE-LINE
// block: a near-total, silent loss of the injection dressed up as a valid
// ceiling. A zero or negative ceiling is not a request for a short block, it is
// a value that has no reading, so it falls back to the default exactly like
// `normalizeSessionStartMaxLessons` returning `null` does. An explicit `1` is a
// reading, and still gets one line.
function resolveLessonCeiling(maxLessons) {
  const n = Number(maxLessons);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_START_MAX_LESSONS;
  return Math.min(HARD_LESSON_CEILING, Math.max(1, Math.round(n)));
}

// How many lessons any ONE self-improvement loop (`loop::<bucket>` tag) may
// contribute to a session-start injection. A prolific loop — the pr-reviewer's
// `loop::review-outcomes` / `loop::reviewer-comment-relevance`, or
// `loop::implement-suggestion-lessons` — writes constantly and recently, so it
// wins recency AND (being built to recur) salience, and a whole scope's read
// can collapse to one bot's private bookkeeping (observed: 13 of 15 slots).
// Ranking and MMR cannot fix that — the flood is real, varied, and high-scoring
// — but it is not what a GENERAL coding session needs; those lessons are read
// back by their own host through a tag filter. One per bucket keeps the signal
// (a loop's best lesson still surfaces) without the flood; general, non-loop
// lessons are never capped. Bounded, not shaped: on a store with no loop lessons
// it never binds. A repo/user can override it with `hooks.sessionStart.loopCap`
// (0 excludes loop buckets entirely), which `fetchLessons` receives as its
// `loopCap` option.
//
// The NUMBER lives in `control.mjs` with the rest of the config vocabulary, and
// is imported rather than restated: a second literal here was a default that
// could silently disagree with the one the resolver hands the hook, so a direct
// caller and a real session would cap differently.

// How many lessons ride along with the scope map in `map` mode. Small on
// purpose: the point of that shape is the inventory, and a "map" that is mostly
// lessons is just `index` with extra steps.
const MAP_TOP_K = 3;

// Cap on lessons injected on a failure — a small, focused "you've seen this
// before" set, never the whole applicable corpus.
const MAX_RELEVANT = 3;
// Cap on the terms distilled from a failure — bounds the relevance scan so a
// huge error blob can never turn into an unbounded match loop.
const MAX_TERMS = 12;
// Terms shorter than this are dropped: too generic to make a match meaningful.
const MIN_TERM_LEN = 4;
// Cap on how much failure text is scanned for terms. A tool can dump a
// multi-megabyte stderr/stdout; the salient error words are always near the
// front, so we bound the input BEFORE lowercasing/splitting it — otherwise a
// giant blob would materialise a giant token array (a CPU/memory spike) even
// though the term COUNT is capped. Generous enough to never clip a real error.
const MAX_SCAN_CHARS = 4096;

// Read lessons narrow-to-broad through the store and resolve cross-scope
// precedence via the shared pure `resolvePrecedence` (the SAME first-seen /
// more-specific-wins merge `tree` renders) — so the hook and `tree` provably
// can't drift. Any per-scope failure is skipped (memory is best-effort).
// Per-scope read cap — the DEFAULT one. It bounds the FETCH, which is a
// different question from how much gets injected, and raising it makes every
// session start pay for rows the budget was never going to show. Its one visible
// consequence is that a scope holding more than this many lessons reports a
// lower-bound count in the scope map — rendered `25+` rather than a number that
// looks exact. `memory.scopes` answers it exactly and is the follow-up that
// replaces this.
export const SCOPE_READ_LIMIT = 25;

// The largest `limit` the hosted route will ACCEPT on one `GET /memories` call.
//
// Mirrored from `MemoryListSchema` / the REST list query schema in
// `@lorekit/schemas` (`limit: …min(1).max(100)`), self-contained here for the
// same reason `limits.ts` is mirrored into the edge function: this package takes
// no dependencies, and the number is a CONTRACT with the other side rather than
// a preference of ours. Keep the two in step — if the route's cap moves, this
// moves with it.
//
// It is a HARD bound on the read, not a soft one, because the failure it
// prevents is silent and total. Zod REJECTS an over-cap `limit` with a 400, so
// `RemoteStore.list` returns `{ ok: false }`, and `fetchLessons` — best-effort by
// design — skips that scope. Every scope fails the same way, so a remote user
// who set `maxLessons` above 100 would get an EMPTY block with no error
// anywhere: the exact shape of bug that survives for months because the hook
// swallows everything by contract. The local store has no such cap, but the
// bound is applied uniformly rather than per-store — one code path, and a
// ceiling above 100 still fills from the several scopes in `readOrder`
// (4 × 100 = 400 candidates for a 200-line ceiling).
export const MAX_STORE_LIST_LIMIT = 100;

// The per-scope read cap for a given line ceiling: the ceiling, held between the
// `SCOPE_READ_LIMIT` floor and the `MAX_STORE_LIST_LIMIT` transport cap.
//
// THE FETCH IS WHAT THIS DIAL IS ACTUALLY FOR. `maxChars` runs out around line 25
// at the default budget, so the ceiling almost never decides how many lines are
// RENDERED — it decides how many rows are FETCHED, and therefore how good the
// ~25 that render are. At the default of 100 the ranker chooses from up to 100
// rows per scope (400 across a four-scope hierarchy) rather than the newest 25.
// On a store of any size that is the difference between ranking a slice of this
// week's churn and ranking a real corpus.
//
// It was previously gated to grow ONLY above the default, so an unconfigured
// workspace kept a 25-row read. That gate died with the default it keyed on: once
// the default IS the depth we want, `ceiling > DEFAULT` can never fire inside the
// config's own 3–200 range, and the fetch would have been pinned at 25 forever
// while the ceiling asked for 100 — a dial that silently could not be fed.
//
// LOWERING the ceiling still does NOT shrink the fetch below `SCOPE_READ_LIMIT`:
// fewer candidates would mean the ranking picks its handful from a worse pool,
// which is a quality regression dressed up as a saving. Monotone in `maxLessons`,
// so the cost never falls as the ask grows.
//
// AND IT NEVER EXCEEDS WHAT THE TRANSPORT ACCEPTS (`MAX_STORE_LIST_LIMIT`). A
// ceiling of 200 is a legal config value, but a 200-row `limit` is not a legal
// request — so the read stops at 100 and the remaining lines fill from the other
// scopes in `readOrder`. Without this the dial's own top half silently emptied
// the block on a remote store. Pure.
export function scopeReadLimit(maxLessons) {
  const ceiling = resolveLessonCeiling(maxLessons);
  return Math.min(Math.max(ceiling, SCOPE_READ_LIMIT), MAX_STORE_LIST_LIMIT);
}

// `scope` may be injected instead of derived from `cwd` — a seam for callers
// that already hold a resolved scope and for tests that need a deterministic
// branch (deriveScope shells out to git, so the ambient branch — often a
// detached `HEAD` in CI — cannot exercise the branch-seeded read otherwise).
export async function fetchLessons(
  store,
  cwd,
  {
    now = Date.now(),
    scope: scopeOverride = null,
    loopCap = DEFAULT_SESSION_START_LOOP_CAP,
    branchHint = true,
    maxLessons = DEFAULT_SESSION_START_MAX_LESSONS,
  } = {},
) {
  const scope = scopeOverride || deriveScope(cwd);
  // ONE ceiling, derived once, spent on both the fetch and the diversifier — the
  // two must agree or a raised ceiling asks for lines the read never fetched.
  // `formatLessons` derives the same number from the same config key, so the
  // render bound matches too.
  const ceiling = resolveLessonCeiling(maxLessons);
  const readLimit = scopeReadLimit(ceiling);
  // Issued BEFORE the per-scope read loop and awaited after it. Nothing in the
  // inventory depends on the loop, so awaiting it afterwards would cost a
  // remote store one extra SERIAL round-trip on the session-start path; started
  // here it overlaps the per-scope reads instead. On a local store `listScopes`
  // is synchronous under its async signature, so the overlap is nil there and
  // the ordering is merely harmless.
  //
  // Leaving the promise unawaited across the loop is safe because
  // `readScopeInventory` cannot reject: its "store cannot enumerate" guard
  // returns before the `try`, and the `try` covers both a synchronous throw and
  // a rejected `listScopes()`. Keep that property if either is ever touched — a
  // floating promise that can reject would take the hook down with it.
  const inventoryPromise = readScopeInventory(store);
  const groups = [];
  // Per scope: did the read come back full? Then the count below is a floor,
  // not a total, and the map must say so rather than quietly under-report.
  const truncatedScopes = new Set();
  for (const s of scope.readOrder) {
    const res = await store.list({ scope: s, limit: readLimit });
    if (!res || !res.ok) continue; // best-effort: a failed scope contributes nothing
    const raw = Array.isArray(res.entries) ? res.entries : [];
    if (raw.length >= readLimit) truncatedScopes.add(s);
    const entries = raw
      .filter((e) => e && e.key)
      .map((e) => ({ ...e, scope: s }));
    groups.push({ scope: s, error: null, entries });
  }
  // First value per key wins (most-specific scope, since `readOrder` is
  // narrow→broad) — exactly what the old inline `byKey` merge did, now via the
  // one shared resolver.
  const { groups: resolved } = resolvePrecedence({ groups });
  const winners = [];
  for (const g of resolved) {
    for (const e of g.entries) if (e.winning) winners.push(e);
  }

  // THE TWO STEPS ANSWER DIFFERENT QUESTIONS, AND THE ORDER MATTERS.
  //
  // `resolvePrecedence` decides WHICH COPY of a key survives — a project
  // lesson shadows the global lesson of the same name — and that is a
  // correctness rule, not a preference. `rankLessons` then decides WHICH OF THE
  // SURVIVORS a reader sees first. Ranking runs on the winners only, so a
  // shadowed lesson can never be promoted back into the set by scoring well;
  // precedence still owns the merge, exactly as `tree` renders it.
  //
  // Before this, the cap took whatever the group order happened to hand it,
  // which is recency within a scope. On an active repo the newest cluster is
  // one task's iteration log, so a dozen near-identical one-offs took the whole
  // budget and evicted the lessons that had been re-learned all month. Recency
  // is one factor now, not the ordering.
  //
  // WHAT PRECEDENCE DOES *NOT* DO, STATED SO IT IS NOT MISREAD AS A BUG.
  // Precedence only settles same-key collisions. Across DIFFERENT keys the cap
  // is now a single cross-scope ranking in which `scopeOrder` is a TIEBREAK
  // (`rankLessons` sorts on score first and only compares `scopeRank` inside
  // `SCORE_EPSILON`) — so a recurring `global::` lesson can and will take a
  // slot from a fresher-but-one-off `project::` one, where the old narrow-first
  // group order always filled the budget from the most-specific scope down.
  // That is the intended trade: the budget goes to what has been re-learned,
  // wherever it lives, and a scope-major sort would reinstate exactly the
  // "whatever the group order hands it" behaviour this change removes. If a
  // narrow scope should instead be guaranteed floor space, that is a weighting
  // change in `rankLessons`, not something to re-derive here.
  //
  // The rank options (see `sessionRankOpts`): a relevance query distilled from
  // the branch NAME, at the DEFAULT weight, so a session on `feat/embedding-…`
  // nudges embedding lessons up. Relevance only ever LIFTS an on-topic lesson —
  // a non-matching lesson scores relevance 0, so a branch that matches nothing
  // does not reorder the read — which is why it need not (and must not, per the
  // Σweights normalisation) be damped by a smaller weight. A trunk branch or
  // detached HEAD yields no terms, and the read is recency + salience exactly as
  // before. `scopeOrder` is passed explicitly rather than left to the scorer's
  // first-appearance default — the hierarchy is `readOrder`'s to state, not an
  // artefact of how this function happens to build its array.
  // ONE options object feeds both the ranking and the diversification below, so
  // the two can never drift on terms, weights OR the `now` clock:
  // `diversifyRankedLessons` recomputes each entry's score to seed the MMR
  // objective, and scored with different options those would not line up with the
  // sorted order. `k` is diversification-only; `scopeOrder` is ranking-only and
  // simply ignored by the diversifier's destructuring.
  const rankOpts = sessionRankOpts(scope, now, { branchHint });
  const ranked = rankLessons(winners, rankOpts);

  // AUDIENCE CAP before diversification: no single self-improvement loop may
  // take more than `loopCap` (the `hooks.sessionStart.loopCap` option, default
  // `DEFAULT_SESSION_START_LOOP_CAP`) of the injected slots, so a general
  // session is not flooded with one bot's private `loop::<bucket>` bookkeeping.
  // General (non-loop) lessons pass through uncapped — they are what the cap
  // frees room for. Applied to the ranked list so the survivors are each
  // bucket's HIGHEST-ranked few, then diversified below. The scope map and
  // `applicable` still read from the full `ranked` set — the cap governs what is
  // shown, not the honest count of what exists per scope.
  //
  // WHERE THE FREED SLOTS FILL FROM, stated so the cap is not oversold. Each
  // scope is read only to its newest `readLimit` rows, so on a scope whose
  // recent writes are ALL one loop's, the general lessons that fill the freed
  // slots come from the OTHER scopes in `readOrder` (a repo's loop churn makes
  // room for `global` principles) — not from that same scope's older generals,
  // which the bounded read never fetched. Reaching those is the recency-window
  // limit (the `order=rank` CANDIDATE_LIMIT problem, one scope down), not this
  // cap's to solve; the cap still does its job of unflooding across scopes.
  const capped = capPerBucket(ranked, { cap: loopCap, bucketOf: loopBucketOf });

  // ── the scope map: EXACT counts when the store can enumerate ───────────────
  //
  // The map's job is to tell a reader how much lore is sitting in each scope
  // that this injection did not show them, so its numbers should be the store's
  // real totals. Deriving them from the bounded read above cannot do that: the
  // read stops at `readLimit`, so a scope holding 400 lessons reported
  // `25+` — technically honest, useless as a quantity, and the `+` was doing a
  // lot of work.
  //
  // `listScopes()` answers exactly, at any size, on BOTH stores: the local one
  // walks its own tree, and the remote one hits `GET /memories/scopes`, which
  // aggregates in Postgres (migration 00039) rather than counting rows a
  // response cap may have truncated. That is the same reason `stats` and
  // `scopes` were moved onto it.
  //
  // TWO SEMANTIC DIFFERENCES, both deliberate, because the map answers a
  // different question from the injected set:
  //
  //   1. It counts EVERY active lesson in the scope, not just the ones that
  //      survived precedence. A key shadowed at a broader scope is still a real
  //      row you can `memory.read` there, and the map is a pointer to what
  //      exists — not a summary of what was injected.
  //   2. It is not bounded by what this session happened to read, so a scope
  //      whose lessons all lost the ranking still appears, which is precisely
  //      when a reader most needs telling it is there.
  //
  // THE COST, STATED RATHER THAN LEFT TO BE DISCOVERED. Exactness is not free
  // on a local or two-tier store: `listScopes()` there is `_walkEntries()`
  // (`store/local.mjs`), which reads and parses EVERY lesson file under the
  // base dir — including the scopes outside `readOrder` that the narrowing
  // below then throws away. So a session start now pays a store-wide walk where
  // the derived counts cost nothing beyond the bounded read it already did. It
  // is accepted deliberately: the walk is local disk over a store of markdown
  // files, the hosted path aggregates in Postgres instead of walking anything,
  // and the alternative — bounding the enumeration — reinstates the `25+` floor
  // this change exists to remove. Narrowing the walk would mean a scope filter
  // on the store contract, which is a change to all three implementations and
  // to `memory.scopes`; if this ever shows up in a session-start profile, that
  // is the fix, not a smaller limit here.
  //
  // Best-effort, like everything on this path: an unreachable remote, a store
  // with no `listScopes`, or a throw all fall back to the derived counts —
  // approximate and `+`-suffixed, exactly what shipped before — rather than
  // costing the user their scope map. `readScopeInventory` never throws.
  const inventory = await inventoryPromise;
  const derivedCounts = scopeInventory(ranked, scope.readOrder, truncatedScopes);
  const scopeCounts = inventory.ok
    ? scopeInventoryFromStore(inventory.scopes, scope.readOrder, derivedCounts)
    : derivedCounts;

  // DIVERSIFY before the ceiling, so the budget is not spent on near-identical
  // lessons. Ranking answers "which lessons score highest"; on an active repo
  // the highest cluster is often one task's iteration log — a dozen
  // `review-outcomes::pr395-it{3,4,5}` rows that score alike AND read alike, so
  // a plain top-N hands the reader the same lesson several times and evicts the
  // variety underneath. `diversifyRankedLessons` applies the SAME MMR
  // (`selectDiverse`, λ=0.7 lexical Jaccard) the hosted `order=rank` path
  // already uses, which was defined and exported here but never wired into the
  // session-start read. It seeds with the top-ranked lesson (score is still
  // 0.7 of the objective) and only spends the remaining 0.3 pushing down a
  // lesson that repeats one already shown — so the best lesson stays first and
  // the set stops being a wall of duplicates. Spreading `rankOpts` here (rather
  // than restating terms/weights) is what keeps the diversifier's recomputed
  // scores in agreement with the `rankLessons` sort above — same terms, same
  // branch-relevance weight, same `now`. The scope map and `applicable` still
  // read from `ranked` — the map is a pointer to what EXISTS per scope, a
  // question diversification does not change.
  //
  // `applicable` is the honest denominator for the header — how many the reader
  // has, as opposed to how many fitted. It is counted BEFORE the ceiling, so
  // "8 of 50" stays true no matter how the render is bounded.
  return {
    scope,
    lessons: diversifyRankedLessons(capped, { ...rankOpts, k: ceiling }),
    scopeCounts,
    applicable: ranked.length,
  };
}

// Per-scope counts from the STORE's own inventory, narrowed to the scopes this
// working directory reads and ordered by the hierarchy.
//
// The narrowing is the point: `listScopes()` is deliberately store-wide (it
// backs the `scopes` command, which enumerates everywhere), but the SessionStart
// map describes THIS workspace. Naming a scope the reader is not working in
// would be noise dressed up as guidance.
//
// An enumerated row is exact and so never carries `atReadLimit` — the `+`
// suffix exists to admit that a number is a floor, and an enumerated one is
// not. A row that fell back to the derived count keeps the flag it came with,
// because that number IS a floor. A scope with no active
// lesson is omitted, matching `scopeInventory`: a row reading `0` is noise, and
// there is nothing to drill into. Pure.
// `fallback` is the derived inventory — the same rows the failure path uses —
// and it is consulted PER SCOPE, not only when the whole enumeration failed.
// `ok: true` means the store answered, not that the answer is complete: a row
// can be missing, or carry a count that `shapeScopeRow` had to coerce to 0.
// Without the per-scope fallback a scope that just contributed injected lessons
// would drop off the map entirely — the reader would see lore in the digest
// with no row saying where it lives, which is a worse answer than the
// approximate one this had in hand all along.
export function scopeInventoryFromStore(scopes, scopeOrder = [], fallback = []) {
  const counts = new Map();
  for (const row of Array.isArray(scopes) ? scopes : []) {
    const s = row?.scope;
    if (!s) continue;
    const n = Number(row.count);
    if (Number.isFinite(n) && n > 0) counts.set(s, n);
  }
  const derived = new Map();
  for (const row of Array.isArray(fallback) ? fallback : []) {
    if (row?.scope) derived.set(row.scope, row);
  }
  return (Array.isArray(scopeOrder) ? scopeOrder : [])
    .filter((s) => counts.has(s) || derived.has(s))
    .map((s) => (counts.has(s)
      ? { scope: s, count: counts.get(s), atReadLimit: false }
      // The derived row keeps its own `atReadLimit`, so a fallen-back scope
      // still renders `25+` rather than posing as an exact number.
      : { ...derived.get(s) }));
}

// Per-scope counts over an already-ranked lesson list, in the given scope order.
// A scope with no surviving lesson is omitted — a map row reading `0` is noise,
// and the reader cannot act on an empty scope. Pure.
export function scopeInventory(lessons, scopeOrder = [], truncated = new Set()) {
  const counts = new Map();
  for (const l of Array.isArray(lessons) ? lessons : []) {
    const s = l?.scope;
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  // `scopeOrder` first (the hierarchy), then anything else that turned up, so a
  // lesson carrying an unexpected scope is still counted rather than dropped.
  const ordered = [...scopeOrder.filter((s) => counts.has(s))];
  for (const s of counts.keys()) if (!ordered.includes(s)) ordered.push(s);
  return ordered.map((s) => ({
    scope: s,
    count: counts.get(s),
    atReadLimit: truncated.has ? truncated.has(s) : false,
  }));
}

// Cap on a lesson's one-line hook in the injected index. Long enough to jog
// recognition, short enough that N lessons stay a scannable list, not a wall —
// the full text is always one `memory.read` away.
const HOOK_LEN = 80;

// A lesson's first meaningful line, cleaned into a short recognisable hook:
// skips leading HTML-comment metadata (`<!-- ... -->`) and markdown heading
// marks, collapses whitespace, and truncates on a word boundary with an
// ellipsis — so nothing is ever cut mid-word into noise like "cascades to GE".
function lessonHook(value, max = HOOK_LEN) {
  let first = '';
  for (const raw of String(value || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue; // skip blanks + meta comments
    first = line.replace(/^#+\s*/, '');              // strip markdown heading marks
    if (first) break;
  }
  first = first.replace(/\s+/g, ' ').trim();
  if (first.length <= max) return first;
  const clipped = first.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

// Render the SessionStart block as a compact INDEX — one terse line per lesson
// (scope, key, and a short hook), never the full bodies. This mirrors the
// lorekit-memory intake rule ("report briefly") and the MEMORY.md index pattern:
// surface WHAT is known so the agent can `memory.read` the one lesson that turns
// out to matter, instead of paying for every body up front. Null when empty.
// `instruction` — an optional extra line appended after the index, sourced from
// `hooks.instructions.SessionStart` in the control config. Lets teams inject
// project-specific guidance (e.g. "focus on migration safety") without touching
// the hook internals. Visible even when there are no lessons.
// `onShown` — an optional callback receiving the lessons this call actually
// RENDERED, which is a subset of `lessons` whenever the budget or the ceiling
// binds. The selection happens in here and nowhere else, so a caller that needs
// to know what the reader saw (the shown-set bookkeeping) has to be told rather
// than re-deriving it — a second copy of the fit maths would drift the moment
// either bound changes.
// `maxLessons` — the LINE ceiling (`hooks.sessionStart.maxLessons`), the second
// bound alongside `maxChars`: whichever binds first decides the block. It is
// passed rather than re-read from config for the same reason `maxChars` is, and
// it must be the SAME number `fetchLessons` was given — a render bound above the
// fetch bound asks for lines that were never fetched, and one below it silently
// discards lessons the read paid for.
export function formatLessons(lessons, scope, {
  instruction = null,
  mode = 'hybrid',
  maxChars = DEFAULT_SESSION_START_MAX_CHARS,
  maxLessons = DEFAULT_SESSION_START_MAX_LESSONS,
  scopeCounts = null,
  applicable = null,
  onShown = null,
} = {}) {
  // Never let bookkeeping break the render: this function's contract is to
  // return a block, and a throwing callback must not cost the reader theirs.
  const report = (rendered) => {
    if (typeof onShown !== 'function') return;
    try { onShown(rendered); } catch { /* best-effort */ }
  };
  const all = Array.isArray(lessons) ? lessons : [];
  if (all.length === 0) {
    report([]);
    // No lessons — only emit if there is a custom instruction to show.
    if (!instruction) return null;
    return (
      `LoreKit: 0 memories loaded · ${scope.repoScope || 'this workspace'} ` +
      `— considerations, not rules; read any in full with memory.read.\n\n` +
      `Project instruction: ${instruction}`
    );
  }

  const budget = Number.isFinite(maxChars) && maxChars > 0
    ? maxChars
    : DEFAULT_SESSION_START_MAX_CHARS;
  const shape = SESSION_START_MODES.includes(mode) ? mode : 'hybrid';
  const total = typeof applicable === 'number' && applicable >= all.length ? applicable : all.length;

  // The map line is composed BEFORE the lessons are chosen, because in `hybrid`
  // its length has to be reserved out of the budget. Appending it afterwards
  // would let the block overrun the very number the config asked for — a budget
  // you can exceed by one more line is not a budget.
  const map = renderScopeMap(scopeCounts);
  const reserve = shape === 'index' || !map ? 0 : map.length + 1;

  // `map` shows a handful of lessons whatever the ceiling says — the point of
  // that shape is the inventory. `Math.min` rather than a flat `MAP_TOP_K` so a
  // ceiling BELOW three still binds: a reader who asked for one line gets one.
  const lineCeiling = resolveLessonCeiling(maxLessons);
  const ceiling = shape === 'map' ? Math.min(MAP_TOP_K, lineCeiling) : lineCeiling;
  const { shown } = fitLines(all, budget - reserve, ceiling);
  report(shown.map((s) => s.lesson));

  // `map` always shows the inventory; `hybrid` shows it only when something was
  // actually left out — otherwise the reader is looking at the complete set and
  // a "…and here is what you are missing" line would be a lie. `index` never
  // shows it, which is the whole difference between `index` and `hybrid`.
  const showMap = Boolean(map) && (shape === 'map' || (shape === 'hybrid' && shown.length < total));

  // Say `8 of 50` whenever the two differ. The old header reported only what it
  // had rendered, so a truncated block was indistinguishable from a complete one
  // and the agent had no way to know that reaching for `memory.search` was worth
  // it. The count is what makes the truncation self-describing.
  const counted = shown.length === total
    ? `${total} ${total === 1 ? 'memory' : 'memories'}`
    : `${shown.length} of ${total} memories`;
  const header =
    `LoreKit: ${counted} loaded · ${scope.repoScope || 'this workspace'} ` +
    `— considerations, not rules; read any in full with memory.read.`;

  const parts = [header, ...shown.map((s) => s.line)];
  if (showMap) parts.push(map);
  const instructionBlock = instruction ? `\n\nProject instruction: ${instruction}` : '';
  return `${parts.join('\n')}${instructionBlock}`;
}

// One index line for a lesson. Pure.
function lessonLine(l) {
  return `- (${l.scope}) ${l.key} — ${lessonHook(l.value)}`;
}

// Take lessons in order until the next line would not fit, or the ceiling is
// reached. Returns `{ shown, used }`.
//
// THE FIRST LINE IS ALWAYS TAKEN, even when it alone exceeds the budget. A
// header with nothing under it is strictly worse than one over-long line: the
// reader learns nothing and cannot tell whether the store is empty or the budget
// is misconfigured. One line over budget is a visible, self-explaining overrun;
// zero lines is a silent one. Pure.
function fitLines(lessons, budget, ceiling) {
  const shown = [];
  let used = 0;
  for (const l of lessons) {
    if (shown.length >= ceiling) break;
    const line = lessonLine(l);
    const cost = line.length + 1; // the newline that joins it
    if (shown.length > 0 && used + cost > budget) break;
    used += cost;
    shown.push({ lesson: l, line });
  }
  return { shown, used };
}

// The scope map: one line naming every scope that holds lessons and how many,
// so a truncated block still tells the reader WHERE the rest live and which verb
// reaches them. A trailing `+` (`25+`) marks a scope whose read hit the per-scope
// limit, so a lower bound never reads as an exact total. Null when there is nothing to
// describe. Pure.
export function renderScopeMap(scopeCounts) {
  const rows = (Array.isArray(scopeCounts) ? scopeCounts : [])
    .filter((s) => s && s.scope && Number(s.count) > 0);
  if (rows.length === 0) return null;
  const body = rows
    .map((s) => `${s.scope} ${s.count}${s.atReadLimit ? '+' : ''}`)
    .join(' · ');
  return `More lore: ${body} — memory.search or memory.read to drill in.`;
}

// Distil a small set of significant, lowercased search TERMS from a tool
// failure — the tool name plus the salient words of its error text — used to
// look up lessons that might already cover this failure. Pure and total: any
// shape of `toolResponse` (object, string, null, malformed) is handled without
// throwing. Terms are de-duplicated, stopword- and length-filtered so a match
// stays meaningful, and the count is capped (`MAX_TERMS`) so a huge error blob
// can't blow up the downstream scan.
export function failureQuery(toolName, toolResponse) {
  return distilTerms(`${toolName ? String(toolName) : ''} ${errorText(toolResponse)}`);
}

// The tokenizer both query builders share. Lowercased `[a-z0-9]+` runs of at
// least `MIN_TERM_LEN` characters, stopword-filtered, de-duplicated, capped at
// `MAX_TERMS`, over at most `MAX_SCAN_CHARS` of input. The floor is INCLUSIVE:
// the filter is `raw.length < MIN_TERM_LEN`, so a term exactly `MIN_TERM_LEN`
// characters long is kept.
//
// The bound is applied to the TEXT before splitting, not to the token array
// after: a multi-megabyte stderr blob (or a pasted file) would otherwise
// materialise a giant token array on the way to being capped — a CPU and memory
// spike for a result that was always going to be twelve words.
//
// Producing `[a-z0-9]+` runs is also what keeps the terms safe to hand to the
// remote store, whose `search` joins them into ONE `websearch` FTS query: no
// FTS metacharacter can survive this filter, so no caller has to escape one.
// Pure and total.
export function distilTerms(text) {
  const scanned = String(text ?? '').slice(0, MAX_SCAN_CHARS).toLowerCase();
  const seen = new Set();
  const terms = [];
  for (const raw of scanned.split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LEN || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

// Single-segment branch names that carry no topic: the trunk names a session is
// most often on. A `<segment>/…` branch always has a leading type/author segment
// (`feat`, `fix`, `claude`, `dependabot`, a username) that is never the topic —
// see `branchQueryTerms` — so those words don't need listing here; this set is
// only consulted for a branch with NO `/`.
const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'head']);

// Distil a relevance query from the branch NAME only — owner/repo never enters,
// because `deriveScope` keeps the raw branch in `scope.branch`. The leading
// `/`-segment of a branch is a type or author by convention (`feat/…`,
// `dependabot/…`, `alice/…`) and never the topic, so it is dropped WHOLESALE when
// a `/` is present; the DESCRIPTION is then tokenised by the shared `distilTerms`
// (so `MIN_TERM_LEN`, dedupe and the FTS-safe shape apply). A word like `release`
// survives when it is in the description (`feat/release-notes`), because only the
// FIRST segment is removed. Empty for a bare trunk name, a detached `HEAD`, or no
// git — the read then behaves exactly as before. Pure and total.
export function branchQueryTerms(scope) {
  const branch = scope && typeof scope.branch === 'string' ? scope.branch : '';
  if (!branch || branch === 'HEAD') return [];
  const slash = branch.indexOf('/');
  if (slash === -1) {
    // No prefix segment: a bare trunk name carries no topic; anything else is
    // its own description.
    return TRUNK_BRANCHES.has(branch.toLowerCase()) ? [] : distilTerms(branch);
  }
  return distilTerms(branch.slice(slash + 1));
}

// The rank options for a session-start read of `scope` at `now` — THE wiring
// seam, so the branch-seeding is unit-testable without a git checkout. The branch
// query rides at the DEFAULT relevance weight, exactly like the prompt/failure
// paths: it only ever LIFTS an on-topic lesson (a non-matching lesson scores
// relevance 0, so a branch that matches nothing is byte-for-byte the old read),
// and it is deliberately NOT damped by a smaller weight — reducing one factor's
// weight shrinks the normaliser (Σweights) and rescales every score, which then
// distorts the unscaled Jaccard term in `selectDiverse`'s MMR even for lessons
// the branch never matched. `fetchLessons` feeds the ONE object this returns to
// both `rankLessons` and (spread) the diversifier, so their scores agree on
// terms and the clock.
export function sessionRankOpts(scope, now, { branchHint = true } = {}) {
  return {
    // `branchHint: false` (config `hooks.sessionStart.branchHint: off`) restores
    // the pre-branch-query read — no terms, so relevance contributes nothing and
    // the order is recency + salience.
    terms: branchHint ? branchQueryTerms(scope) : [],
    now,
    scopeOrder: scope && scope.readOrder ? scope.readOrder : null,
  };
}

// De-duplicate store-search hits by `scope::key` and cap them, PRESERVING the
// store's order — which is NOT relevance ordering: the remote store filters by
// FTS but orders by `updated_at desc` (recency), and the local one yields scope
// precedence (most-specific first) only WITHIN a tier — `LocalStore.search`
// walks the scope hierarchy in `readOrder`, but `TwoTierStore.search` merges
// project-tier hits ahead of home-tier ones, so a `global` lesson in the project
// tier outranks a `repo::` one in home. Pure and total — any non-array input
// degrades to [] rather than throwing (this runs inside the best-effort failure
// hook).
export function dedupeRelevant(entries, cap = MAX_RELEVANT) {
  if (!Array.isArray(entries)) return [];
  const limit = Math.max(0, cap);
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (out.length >= limit) break; // checked BEFORE the push, so cap 0 yields []
    if (!e || !e.key) continue;
    const id = `${e.scope ?? ''}::${e.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

// Retrieve lessons relevant to a tool failure by QUERYING the store across the
// scope hierarchy — as opposed to post-filtering the SessionStart-injected set,
// which could only ever resurface a lesson that was going to be shown anyway (a
// lesson in a sibling scope, or one past the per-scope read cap, was
// unreachable). A SINGLE `store.search` carries ALL the distilled failure terms
// (OR semantics), so the offline store is walked once rather than once per term.
// MATCHING is DELEGATED to the store — substring over the full scope for local,
// server-side FTS (with stemming, so `connect` matches `connection`) for remote.
// ORDERING is not: the remote returns `updated_at desc`, so the top-`cap` slice
// is the most RECENT matches, not the most relevant ones. Hits are de-duped and
// capped by the pure `dedupeRelevant`, keeping the store's own ordering (see its
// docblock). Best-effort: an unusable/throwing store returns [] so the
// caller falls back to the write-nudge alone.
export async function relevantLessonsFromStore(store, scope, terms, { cap = MAX_RELEVANT, timeoutMs, walkLimit } = {}) {
  if (!store || typeof store.search !== 'function') return [];
  if (!scope || !Array.isArray(scope.readOrder) || scope.readOrder.length === 0) return [];
  if (!Array.isArray(terms) || terms.length === 0) return [];
  try {
    // `timeoutMs` bounds the REMOTE route (a network fetch); `walkLimit` bounds
    // the OFFLINE one (a synchronous file walk `timeoutMs` cannot interrupt).
    // They are deliberately separate names: `RemoteStore.search` reads `limit`
    // (→ `body.limit`), so a shared name would truncate the remote hit set
    // BEFORE `rankLessons` runs — exactly what a hot-path caller must avoid.
    // `walkLimit` is honoured only by the local stores; the remote ignores it
    // and stays bounded by `timeoutMs` alone, as it was before this budget.
    const res = await store.search({ q: terms, scopes: scope.readOrder, timeoutMs, walkLimit });
    if (!res || !res.ok || !Array.isArray(res.entries)) return [];
    return dedupeRelevant(res.entries, cap);
  } catch {
    return []; // best-effort: a failed search falls back to the nudge alone
  }
}

// Render the relevant-lessons block injected alongside the failure nudge, or
// null when nothing matched. Same compact-index shape as `formatLessons`, with a
// touch more hook per line (there are at most MAX_RELEVANT and they're directly
// actionable). Framed as prior art, not a directive.
export function formatRelevantLessons(lessons) {
  if (!lessons || lessons.length === 0) return null;
  const noun = lessons.length === 1 ? 'memory' : 'memories';
  const header =
    `LoreKit: ${lessons.length} related ${noun} — you've hit something like this before ` +
    `(considerations, not rules; read in full with memory.read):`;
  const body = lessons.map((l) => `- (${l.scope}) ${l.key} — ${lessonHook(l.value, 140)}`).join('\n');
  return `${header}\n${body}`;
}

// Build a tags hint string from config-resolved tags and scope defaults. Returns
// "" when there are no configured tags (no hint appended to the nudge).
function tagsHint(writeScope, control) {
  const { tagsDefault = [], scopeDefaults = null } = control || {};
  const tags = [...tagsDefault];
  if (scopeDefaults) {
    for (const [prefix, cfg] of Object.entries(scopeDefaults)) {
      // Tags UNION across every matching prefix — they accumulate, so a broad
      // and a narrow entry both contribute. The TTL hint below deliberately does
      // NOT: a memory has one expiry, so the most specific prefix wins outright.
      if (matchesScopePrefix(writeScope, prefix)) {
        for (const t of Array.isArray(cfg.tags) ? cfg.tags : []) {
          if (typeof t === 'string' && t.length > 0 && !tags.includes(t)) tags.push(t);
        }
      }
    }
  }
  if (tags.length === 0) return '';
  return ` Include tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}].`;
}

// Build the TTL hint appended to a nudge. Empty string when the scope has no
// configured default, so an unconfigured repo's nudge is unchanged.
//
// Phrased as an instruction to pass `ttl_days` rather than as a statement about
// what will happen, because nothing enforces it: the agent is about to call
// `memory.write` over MCP, where omitting `ttl_days` still means permanent. The
// hint is advice with a number attached — the same posture as the tags hint.
function ttlHint(writeScope, control) {
  const days = resolveDefaultTtlDays(writeScope, control || {});
  if (days == null) return '';
  return ` Set ttl_days: ${days} (this scope's configured default) unless the lesson is durable enough to keep forever.`;
}

// One-line phrases for the detected friction reason codes (see core/friction.mjs),
// so the nudge names what happened instead of a generic prompt.
const REASON_PHRASES = {
  [FRICTION_FAILURE]: 'a failed tool call',
  [FRICTION_STUCK_LOOP]: 'a repeated retry',
};

// Join detected reason codes into a readable clause ("a failed tool call and a
// repeated retry"). Empty/unknown reasons → "" (caller uses the generic prompt).
function describeReasons(reasons) {
  const phrases = (Array.isArray(reasons) ? reasons : [])
    .map((r) => REASON_PHRASES[r])
    .filter(Boolean);
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

// The retrospective nudge emitted at end-of-turn (one-shot per session).
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them. `opts.reasons` is the
// detected friction reason codes (from core/friction.mjs) when `hooks.stop` is
// `friction`; when present the nudge names them so the reflection is grounded.
// Kept to a single line — the lore deep-link lives on the write CONFIRMATION,
// which is where a link is actually actionable.
export function retrospectiveNudge(scope, control, { reasons = [] } = {}) {
  const writeScope = scope.repoScope || 'global';
  const hint = `${tagsHint(writeScope, control)}${ttlHint(writeScope, control)}`;
  const instruction = control && control.hooksInstructions && control.hooksInstructions.Stop
    ? `\n\nProject instruction: ${control.hooksInstructions.Stop}` : '';
  const detected = describeReasons(reasons);
  const lead = detected
    ? `LoreKit: this session hit ${detected} — a lesson worth saving?`
    : `LoreKit: any friction worth remembering (stuck loop, repeat failure, gotcha, wrong assumption)?`;
  return `${lead} memory.write to ${writeScope}; else skip.${hint}${instruction}`;
}

// Terse confirmation emitted via PostToolUse when a memory.write succeeded.
// `key` is the lesson key from the tool input (may be null when it isn't
// surfaced). `writtenScope` is the ACTUAL scope the write targeted (from the tool
// input) — the link must point there, not at `repoScope`: a `global` (or project)
// write deep-linked to `repoScope` would open a lesson ref that doesn't exist.
// Falls back to the cwd's repo scope, then `global`, when the write scope is
// unknown. When the key is known the link opens that exact lesson's detail sheet
// (`?scope=…&lesson=…`); otherwise it filters the Explorer to the write scope —
// both JSON-encoded via the shared builder so they actually open the intended view.
export function writeConfirmation(scope, key, writtenScope) {
  const target =
    typeof writtenScope === 'string' && writtenScope ? writtenScope : scope.repoScope || 'global';
  const keyPart = key ? ` · ${key}` : '';
  const url = key ? buildLessonUrl(target, key) : loreScopeUrl(target);
  return `LoreKit: memory saved to ${target}${keyPart}\nView: ${url}`;
}

// The nudge emitted when a tool failure is detected.
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them.
export function failureNudge(toolName, scope, control) {
  const writeScope = scope.repoScope || 'global';
  const hint = `${tagsHint(writeScope, control)}${ttlHint(writeScope, control)}`;
  const instruction = control && control.hooksInstructions && control.hooksInstructions.PostToolUseFailure
    ? `\n\nProject instruction: ${control.hooksInstructions.PostToolUseFailure}` : '';
  return (
    `LoreKit: the last ${toolName} call failed. If it's recurring or non-obvious, ` +
    `memory.write to ${writeScope} with the fix so the next run avoids it.${hint}${instruction}`
  );
}

// Pull the human-readable error text out of a tool_response of any shape. Total:
// null/primitive/string/object all yield a (possibly empty) string, never a
// throw — the relevance lookup is best-effort and must not break the host.
function errorText(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response !== 'object') return String(response);
  const parts = [];
  for (const f of TEXT_FIELDS) {
    const v = response[f];
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') parts.push(safeStringify(v));
  }
  return parts.length ? parts.join(' ') : safeStringify(response);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) || '';
  } catch {
    return '';
  }
}

// The tool_response fields that commonly carry error text, across frameworks.
const TEXT_FIELDS = [
  'stderr',
  'error',
  'message',
  'stdout',
  'output',
  'content',
  'reason',
  'detail',
  'details',
];

// Generic words dropped from a failure query: too common to make a lesson match
// meaningful (they'd match almost anything). Kept small and hand-picked.
const STOPWORDS = new Set([
  'error',
  'errors',
  'failed',
  'failure',
  'tool',
  'call',
  'code',
  'exit',
  'with',
  'this',
  'that',
  'from',
  'null',
  'true',
  'false',
  'undefined',
  'command',
  'response',
  'status',
]);

// ── the per-prompt relevance pull (UserPromptSubmit) ─────────────────────────
//
// SessionStart injects once, at the top of a session, before the user has said
// what they are doing. That set is necessarily a guess: it is ranked on recency
// and recurrence because there is nothing else to rank on yet. The moment the
// user types "the migration keeps deadlocking", there IS something to rank on —
// and until this hook, nothing used it. The only mid-session trigger was a tool
// FAILURE, which means the loop could only ever tell you about a mistake after
// you had already made it.
//
// The whole design problem is that this fires on EVERY turn, so the cost of
// being wrong is paid over and over. Three gates keep it quiet, and each one
// exists because the failure mode without it is worse than showing nothing:
//
//   LENGTH    — "yes", "continue", "go on" carry no terms worth querying, and a
//               store lookup per keystroke-sized prompt is pure overhead.
//   RELEVANCE — no match means silence. An "in case it helps" lesson attached
//               to an unrelated prompt trains the reader to skim past the
//               block, which costs the SessionStart injection its credibility
//               too.
//   DELTA     — a lesson already shown this session is not news. Re-injecting
//               it is the specific way a per-turn hook becomes wallpaper.

// Shortest prompt worth a store lookup. Tuned to skip the acknowledgements that
// dominate a real session ("yes", "ok", "continue", "do it", "next") while
// keeping anything that states an intent. Deliberately generous: the relevance
// gate is the real filter, and this one only exists to avoid paying for a query
// whose terms would be discarded anyway.
const MIN_PROMPT_CHARS = 24;

// Cap on lessons injected per prompt. Smaller than the SessionStart budget by an
// order of magnitude, because this competes with the user's own turn: three
// index lines is a glance, and anything more is an interruption.
const MAX_PROMPT_LESSONS = 3;

// Fetch budget for the per-prompt pull, deliberately far below `restFetch`'s
// 10s default. This is the ONE lookup that sits on the user's critical path —
// it runs before their turn is handed to the assistant — so a slow or wedged
// store must cost them a fraction of a second, not ten. Timing out is not a
// failure mode here: the abort surfaces as no hits, and no hits is already this
// hook's most common and entirely valid answer. Same reasoning as
// `telemetry.mjs`'s 1500 ms export budget; a touch more generous because a
// missed lesson is worth slightly more than a missed metric.
export const PROMPT_FETCH_TIMEOUT_MS = 2000;

// The offline-store counterpart to the fetch budget above. `timeoutMs` bounds
// the remote route, but the local store walks every scope's files synchronously
// on every prompt — an unbounded walk a wall-clock budget cannot interrupt. The
// per-prompt pull forwards this as `walkLimit` (NOT `limit`, which the remote
// store maps to `body.limit` and would truncate its hit set pre-ranking), so it
// bounds only the offline walk: the block ranks then keeps MAX_PROMPT_LESSONS,
// so a few hundred nearest-scope hits is far more than the ranker needs to
// surface the best three. Only the hot-path caller passes it; the failure hook
// stays unbounded, as it was.
export const PROMPT_LOCAL_SEARCH_LIMIT = 200;

/**
 * Is this prompt worth a relevance lookup?
 *
 * Length is measured AFTER trimming, on the raw prompt. A long prompt made
 * entirely of stopwords still passes here and is caught by the term gate below
 * — two cheap checks in series rather than one clever one.
 */
export function isSubstantivePrompt(prompt, min = MIN_PROMPT_CHARS) {
  return String(prompt ?? '').trim().length >= min;
}

/**
 * Distil search terms from a user prompt.
 *
 * The same tokenizer the failure lookup uses, for the same reason: whatever
 * reaches the store must be `[a-z0-9]+` runs, and the two callers must agree on
 * what counts as a term or "why did the failure hook find this and my prompt
 * not?" becomes unanswerable.
 *
 * Returns `[]` for a prompt that is too short or carries nothing but stopwords,
 * which the caller reads as "stay silent".
 */
export function promptQuery(prompt) {
  if (!isSubstantivePrompt(prompt)) return [];
  return distilTerms(prompt);
}

/**
 * Render the per-turn block, or null when there is nothing to say.
 *
 * INDEX ONLY, and shorter than the failure block's lines. This arrives while
 * the user is mid-thought, so it has to be scannable in a glance and cost as
 * little context as possible; the body is always one `memory.read` away. The
 * framing is "you have notes on this", never an instruction — the same
 * considerations-not-rules posture as every other injection.
 */
export function formatPromptLessons(lessons, { instruction = null } = {}) {
  if (!lessons || lessons.length === 0) return null;
  const noun = lessons.length === 1 ? 'memory' : 'memories';
  const header =
    `LoreKit: ${lessons.length} ${noun} related to this — `
    + `considerations, not rules; read in full with memory.read:`;
  const body = lessons.map((l) => `- (${l.scope}) ${l.key} — ${lessonHook(l.value)}`).join('\n');
  // `hooks.instructions.UserPromptSubmit`, appended the same way the other
  // events append theirs. It rides an EXISTING block and never creates one:
  // this hook fires on every turn, so an instruction that could emit on its own
  // would be a line on every prompt — the noise the relevance gate exists to
  // prevent.
  const extra = typeof instruction === 'string' && instruction.trim()
    ? `\n\nProject instruction: ${instruction}` : '';
  return `${header}\n${body}${extra}`;
}

/**
 * The per-prompt pull: query the store for this prompt's terms, rank, drop
 * anything already shown, cap.
 *
 * QUERYING rather than filtering the injected set is the same call the failure
 * hook makes, and for the same reason: a post-filter can only ever resurface a
 * lesson that was already on screen, so a paraphrased match or one that lost
 * the SessionStart ranking would be permanently unreachable — which is exactly
 * the lore this hook exists to surface.
 *
 * RANKING runs after the store returns, because the store's own ordering is not
 * relevance: the remote route answers `updated_at desc` and the local two-tier
 * store answers project-tier-first. `rankLessons` with the prompt's terms
 * applies the same scorer the SessionStart block uses, so a recurring lesson
 * beats a fresher one-off here too.
 *
 * `alreadyShown` is a Set of `scope::key`. Filtering AFTER ranking rather than
 * before is deliberate: it keeps the cap meaningful. Filtering first would let
 * three weak lessons take the slots a strong-but-already-shown one vacated,
 * which is worse than showing two.
 *
 * Best-effort and total — any failure yields `[]`, and the hook stays silent.
 * That includes the fetch budget: the lookup runs under
 * `PROMPT_FETCH_TIMEOUT_MS` rather than `restFetch`'s 10s default, and an abort
 * arrives here as no hits, the same as a store that simply had nothing.
 */
export async function promptLessonsFromStore(store, scope, terms, {
  alreadyShown = new Set(),
  cap = MAX_PROMPT_LESSONS,
  now = Date.now(),
  timeoutMs = PROMPT_FETCH_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(terms) || terms.length === 0) return [];
  const hits = await relevantLessonsFromStore(store, scope, terms, {
    cap: Number.MAX_SAFE_INTEGER,
    timeoutMs,
    walkLimit: PROMPT_LOCAL_SEARCH_LIMIT,
  });
  if (hits.length === 0) return [];
  const ranked = rankLessons(hits, {
    terms,
    now,
    scopeOrder: Array.isArray(scope?.readOrder) ? scope.readOrder : null,
  });
  const fresh = ranked.filter((e) => !alreadyShown.has(lessonId(e)));
  return dedupeRelevant(fresh, cap);
}

/** The identity a shown-set is keyed on. One spelling, used by both sides. */
export function lessonId(entry) {
  return `${entry?.scope ?? ''}::${entry?.key ?? ''}`;
}
