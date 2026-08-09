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
import { resolvePrecedence, rankLessons } from '../lessons-pure.mjs';
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
import { DEFAULT_SESSION_START_MAX_CHARS, SESSION_START_MODES } from '../control.mjs';
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
// `HARD_LESSON_CEILING` is the second bound, from the other direction. A budget
// alone cannot stop a store of 500 one-word keys from rendering 400 lines inside
// it, and a 400-line index is unreadable however few characters it costs. It is
// well above the DEFAULT budget, so at 1500 chars it never binds and the shape
// is the budget's to decide. It does bind at the top of the configured range:
// `MAX_SESSION_START_MAX_CHARS = 20000` funds roughly two hundred index lines,
// so a deliberately large budget stops at forty memories. That is the intended
// trade — forty lines is already at the edge of scannable, and a reader who
// wants the rest has `memory.search` — but it is a real ceiling, not a
// theoretical one, so raising `maxChars` past a few thousand buys characters
// per line rather than more lines.
const HARD_LESSON_CEILING = 40;

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
// Per-scope read cap. Unchanged from the count-capped era: it bounds the FETCH,
// which is a different question from how much gets injected, and raising it
// would make every session start pay for rows the budget was never going to
// show. Its one visible consequence is that a scope holding more than this
// many lessons reports a lower-bound count in the scope map — rendered `25+`
// rather than a number that looks exact. `memory.scopes` answers it exactly and
// is the follow-up that replaces this.
export const SCOPE_READ_LIMIT = 25;

export async function fetchLessons(store, cwd, { now = Date.now() } = {}) {
  const scope = deriveScope(cwd);
  const groups = [];
  // Per scope: did the read come back full? Then the count below is a floor,
  // not a total, and the map must say so rather than quietly under-report.
  const truncatedScopes = new Set();
  for (const s of scope.readOrder) {
    const res = await store.list({ scope: s, limit: SCOPE_READ_LIMIT });
    if (!res || !res.ok) continue; // best-effort: a failed scope contributes nothing
    const raw = Array.isArray(res.entries) ? res.entries : [];
    if (raw.length >= SCOPE_READ_LIMIT) truncatedScopes.add(s);
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
  // `terms: []` is the SessionStart case: nothing has been asked yet, so the
  // relevance factor contributes nothing and the order is recency + salience.
  // `scopeOrder` is passed explicitly rather than left to the scorer's
  // first-appearance default — they agree today, but the hierarchy is
  // `readOrder`'s to state, not an artefact of how this function happens to
  // build its array.
  const ranked = rankLessons(winners, { terms: [], now, scopeOrder: scope.readOrder });

  // The scope map is built from the SAME pass, over the winners — the set a
  // reader could actually act on, so a shadowed duplicate is not counted twice.
  // Order follows `readOrder` (most-specific first) rather than count, because
  // the map is a map: it should read like the hierarchy it describes.
  const scopeCounts = scopeInventory(ranked, scope.readOrder, truncatedScopes);

  // `applicable` is the honest denominator for the header — how many the reader
  // has, as opposed to how many fitted. It is counted BEFORE the ceiling, so
  // "8 of 50" stays true no matter how the render is bounded.
  return {
    scope,
    lessons: ranked.slice(0, HARD_LESSON_CEILING),
    scopeCounts,
    applicable: ranked.length,
  };
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
export function formatLessons(lessons, scope, {
  instruction = null,
  mode = 'hybrid',
  maxChars = DEFAULT_SESSION_START_MAX_CHARS,
  scopeCounts = null,
  applicable = null,
} = {}) {
  const all = Array.isArray(lessons) ? lessons : [];
  if (all.length === 0) {
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

  const ceiling = shape === 'map' ? Math.min(MAP_TOP_K, HARD_LESSON_CEILING) : HARD_LESSON_CEILING;
  const { shown } = fitLines(all, budget - reserve, ceiling);

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
// reaches them. A trailing `+` marks a scope whose read hit `SCOPE_READ_LIMIT`,
// so a lower bound never reads as an exact total. The SUFFIX and the DIGITS come
// from different places — `atReadLimit` from the pre-precedence read, `count`
// from the winners that survived shadowing — so a capped scope renders `24+` as
// readily as `25+`. Null when there is nothing to describe. Pure.
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
  const text = `${toolName ? String(toolName) : ''} ${errorText(toolResponse)}`.slice(0, MAX_SCAN_CHARS);
  const seen = new Set();
  const terms = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LEN || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
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
export async function relevantLessonsFromStore(store, scope, terms, { cap = MAX_RELEVANT } = {}) {
  if (!store || typeof store.search !== 'function') return [];
  if (!scope || !Array.isArray(scope.readOrder) || scope.readOrder.length === 0) return [];
  if (!Array.isArray(terms) || terms.length === 0) return [];
  try {
    const res = await store.search({ q: terms, scopes: scope.readOrder });
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
