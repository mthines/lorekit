// Shared, store-agnostic view layer for the read commands (`list`, `search`,
// `show`, `stats`, `diff`). Two responsibilities:
//   1. pure helpers — the applicable-scope set, entry normalization, previews,
//      the search matcher/filter, and the `stats` tally / `diff` set-diff cores;
//   2. `gather()` — collect a store's entries per scope behind the common
//      store contract; and `renderSection()` — print one offline/remote section.
//
// Kept separate from `list.mjs` on purpose: the offline/remote sectioned
// rendering is a reusable seam, not a `list`-only detail. Zero-dependency.
import { log, heading, status, c } from './util.mjs';
// `resolvePrecedence` (the cross-scope merge) and `matchesQuery` (the literal
// substring matcher) live in the dependency-free `lessons-pure.mjs` so the hook
// hot path can share them without pulling in this file's `util`/render stack.
// Re-exported here so `search`/`tree` (and their tests) keep one import site;
// `matchesQuery` is also used internally by `filterGroups` below.
// `scopeIssue` (the canonical scope validator) and the scope/key argument
// parsers live there too — the `lint` rule below and the `write`/`show`/`link`
// argument handling must agree on ONE scope grammar, and the parser is only
// decidable because it can ask the validator.
import {
  resolvePrecedence,
  matchesQuery,
  scopeIssue,
  isScopeString,
  resolveScopeArg,
  resolveScopeKeyArgs,
} from './lessons-pure.mjs';
export { resolvePrecedence, matchesQuery, scopeIssue, isScopeString, resolveScopeArg, resolveScopeKeyArgs };

// The scopes that apply to the current directory, most-specific → broadest:
// project, branch, repo, global. De-duplicated (a repo with no branch scope,
// or a project whose name collides, never lists a scope twice). Pure — takes an
// already-derived `deriveScope()` result so it is trivially unit-testable.
export function scopeList({ projectScope, branchScope, repoScope } = {}) {
  return [...new Set([projectScope, branchScope, repoScope, 'global'].filter(Boolean))];
}

// Infer { kind, host } from a memory's loop tags — the CLI-local mirror of
// `@lorekit/schemas` `inferKindHost` (the CLI has no schemas dependency). Kept
// deliberately small and in lockstep with that source, including the 64-char
// host clamp. Lets the offline store, whose rows carry no kind/host column,
// still be filtered and badged by taxonomy from the tags it does store.
function inferKindHostFromTags(tags) {
  if (!Array.isArray(tags)) return {};
  for (const tag of tags) {
    if (tag === 'loop::review-outcomes') return { kind: 'bus', host: 'review' };
    if (tag === 'loop::reviewer-comment-relevance') return { kind: 'signal', host: 'reviewer' };
    const m = typeof tag === 'string' ? /^loop::(.+)-lessons$/.exec(tag) : null;
    if (m && m[1] && m[1].length <= 64) return { kind: 'lesson', host: m[1] };
  }
  return {};
}

// Normalize an entry from either store (local markdown row or hosted DB row)
// into one stable shape the view + `--json` output can rely on. Remote rows may
// spell the timestamp `updated_at`; local rows use `updated`. When a row carries
// no explicit kind/host (every offline row, and any remote row written before
// migration 00056), fall back to the taxonomy inferred from its tags so the
// badge and the `--kind`/`--host` filter behave the same in both sections.
export function normalizeEntry(e = {}) {
  const tags = Array.isArray(e.tags) ? e.tags : [];
  const inferred = inferKindHostFromTags(tags);
  return {
    scope: e.scope ?? null,
    key: e.key ?? null,
    value: e.value == null ? '' : String(e.value),
    updated: e.updated ?? e.updated_at ?? null,
    created: e.created ?? e.created_at ?? null,
    tags,
    kind: e.kind ?? inferred.kind ?? null,
    host: e.host ?? inferred.host ?? null,
  };
}

// A single-line, whitespace-collapsed, length-bounded preview of a lesson body.
export function preview(value, max = 72) {
  const s = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Just the calendar date from an ISO timestamp, for compact `(updated …)` tags.
export function shortDate(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

// A bounded, non-PII description of a per-scope read failure (network / server).
// Exported so the single-record read commands (`show`) can describe a failed
// `store.read()` in the same words a failed `store.list()` gets here.
export function describeError(res) {
  if (!res) return 'no response';
  if (res.networkError) return String(res.networkError);
  if (res.error) return res.error.message || `error ${res.error.code}`;
  return 'unreadable';
}

// The literal, case-insensitive `matchesQuery` matcher this filter uses lives in
// `lessons-pure.mjs` (re-exported above) — shared with the hook engine.

// Filter the per-scope groups from `gather()` down to the entries that match
// `query`, recomputing the total. Per-scope read errors are preserved verbatim
// (a failed scope stays surfaced, never silently dropped). Returns the same
// `{ groups, total }` shape `gather()` does, so `renderSection` and the `--json`
// builder consume it identically. Pure — the future `stats`/`diff` read commands
// stack on this same filter-the-gather seam.
export function filterGroups({ groups = [] } = {}, query) {
  const out = [];
  let total = 0;
  for (const g of groups) {
    if (g.error) {
      out.push({ scope: g.scope, entries: [], error: g.error });
      continue;
    }
    const entries = (g.entries || []).filter((e) => matchesQuery(e, query));
    total += entries.length;
    out.push({ scope: g.scope, entries, error: null });
  }
  return { groups: out, total };
}

// Whether two normalized records differ in a way worth flagging when the same
// scope::key lives in both the offline and remote stores — a value or tag-set
// mismatch. `null`/absent on either side is not a divergence (that's a
// "present in only one store" case the caller handles separately). Pure.
export function recordsDiverge(a, b) {
  if (!a || !b) return false;
  if (String(a.value) !== String(b.value)) return true;
  const ta = (a.tags || []).join('\x00');
  const tb = (b.tags || []).join('\x00');
  return ta !== tb;
}

// Tally the per-scope entry counts from a `gather()` result — the pure core of
// the `stats` command. A per-scope read error counts as 0 (it is surfaced, not
// silently summed) and is carried through so the view can flag it. Returns
// `{ perScope: [{ scope, count, error }], total }`; `total` reuses `gather()`'s
// pre-computed total when present, else re-derives it from the counts. Pure.
export function tallyGroups({ groups = [], total } = {}) {
  const perScope = groups.map((g) => ({
    scope: g.scope,
    count: g.error ? 0 : (g.entries || []).length,
    error: g.error || null,
  }));
  const summed = perScope.reduce((n, s) => n + s.count, 0);
  return { perScope, total: typeof total === 'number' ? total : summed };
}

// ── `scopes` — store-wide scope inventory ─────────────────────────────────────

// The canonical scope TYPE of a scope string — its `::`-leading segment when it
// is one of the four recognized types, else `other` (a malformed / legacy row).
// Pure. Shared by the `scopes` inventory ordering below.
export function scopeTypeOf(scope) {
  const type = String(scope == null ? '' : scope).split('::')[0];
  return ['global', 'project', 'repo', 'branch'].includes(type) ? type : 'other';
}

// A stable type ordering for the inventory: broadest → most-specific, with any
// unrecognized scope last. Chosen (over count-desc) so the listing groups
// related scopes together and is deterministic run-to-run.
const SCOPE_TYPE_RANK = { global: 0, project: 1, repo: 2, branch: 3, other: 4 };

// Sort a scope inventory (`[{ scope, count }]`) into a navigable order: primary
// by scope type (global → project → repo → branch → other), secondary
// alphabetical by the full scope string. Pure — returns a new array, never
// mutating its input.
export function sortScopeInventory(list = []) {
  return [...list].sort((a, b) => {
    const ra = SCOPE_TYPE_RANK[scopeTypeOf(a.scope)] ?? 4;
    const rb = SCOPE_TYPE_RANK[scopeTypeOf(b.scope)] ?? 4;
    if (ra !== rb) return ra - rb;
    return String(a.scope).localeCompare(String(b.scope));
  });
}

// Narrow a scope inventory to the scopes whose string CONTAINS `needle`
// (case-insensitive substring) — the `scopes --scope <s>` filter. An empty /
// absent needle passes everything through unchanged. Pure.
export function filterScopeInventory(list = [], needle) {
  if (!needle) return list;
  const q = String(needle).toLowerCase();
  return list.filter((s) => String(s.scope).toLowerCase().includes(q));
}

// The pure core of the `scopes` command: sort an inventory and total its counts.
// Returns `{ scopes: [{ scope, count }] (sorted), total }`. Pure.
export function summarizeScopeInventory(list = []) {
  const scopes = sortScopeInventory(list);
  const total = scopes.reduce((n, s) => n + (Number(s.count) || 0), 0);
  return { scopes, total };
}

// Compare two `gather()` results (offline vs remote) and classify every scope's
// keys into three sets — the pure core of the `diff` command:
//   • localOnly     — key present offline, absent remote;
//   • remoteOnly    — absent offline, present remote;
//   • conflicting   — same scope::key in both but the value/tags diverge
//                     (via `recordsDiverge`).
// Scopes are the ordered union of both inputs. When either store reported a
// per-scope read error for a scope, that scope is emitted with `error` set and
// empty sets (a partial read must never masquerade as "only in the other
// store"). Returns `{ groups: [{ scope, localOnly, remoteOnly, conflicting,
// error }], totals: { localOnly, remoteOnly, conflicting } }`. Pure.
export function diffGroups(offline = {}, remote = {}) {
  const index = (gathered) => {
    const byScope = new Map();
    for (const g of gathered.groups || []) {
      const keys = new Map();
      for (const e of g.entries || []) keys.set(e.key, e);
      byScope.set(g.scope, { keys, error: g.error || null });
    }
    return byScope;
  };
  const local = index(offline);
  const remote_ = index(remote);
  const scopes = [...new Set([...local.keys(), ...remote_.keys()])];

  const groups = [];
  const totals = { localOnly: 0, remoteOnly: 0, conflicting: 0 };
  for (const scope of scopes) {
    const l = local.get(scope) || { keys: new Map(), error: null };
    const r = remote_.get(scope) || { keys: new Map(), error: null };
    const error = l.error || r.error || null;
    const localOnly = [];
    const remoteOnly = [];
    const conflicting = [];
    if (!error) {
      for (const [key, entry] of l.keys) {
        if (!r.keys.has(key)) localOnly.push(entry);
        else if (recordsDiverge(entry, r.keys.get(key)))
          conflicting.push({ key, local: entry, remote: r.keys.get(key) });
      }
      for (const [key, entry] of r.keys) {
        if (!l.keys.has(key)) remoteOnly.push(entry);
      }
    }
    totals.localOnly += localOnly.length;
    totals.remoteOnly += remoteOnly.length;
    totals.conflicting += conflicting.length;
    groups.push({ scope, localOnly, remoteOnly, conflicting, error });
  }
  return { groups, totals };
}

// The `tree` + hook cross-scope precedence core, `resolvePrecedence`, lives in
// `lessons-pure.mjs` (re-exported above) so the hook hot path shares it verbatim.

// ── `lint` — cheap lesson quality/health rules ────────────────────────────────

// Below this trimmed length a non-empty value is "suspiciously short" — a lesson
// too terse to carry a durable observation (e.g. "yes", "fixed", "todo").
export const MIN_VALUE_LEN = 12;

// The lint rule set: each a pure predicate over a normalized entry returning a
// short reason string when it FIRES, or null when the entry is clean. Kept as
// discrete named functions so each rule is independently unit-testable and the
// finding names the exact rule it violated. `short-value` and `empty-value` are
// mutually exclusive (short only fires on a non-empty body), so an empty lesson
// is reported once, not twice.
export const LINT_RULES = {
  'empty-value': (e) => (String(e.value ?? '').trim() ? null : 'value is empty or whitespace-only'),
  'short-value': (e, { minValueLen = MIN_VALUE_LEN } = {}) => {
    const t = String(e.value ?? '').trim();
    return t && t.length < minValueLen ? `value is very short (${t.length} < ${minValueLen} chars)` : null;
  },
  'untrimmed-value': (e) => {
    const v = String(e.value ?? '');
    // Only a value with REAL content that is padded — a whitespace-only body is
    // `empty-value`'s to report, so the two rules never double-fire on one entry.
    return v.trim() && v !== v.trim() ? 'value has leading/trailing whitespace' : null;
  },
  'empty-key': (e) => (String(e.key ?? '').trim() ? null : 'key is empty or whitespace-only'),
  // A key carrying a per-sighting identifier (a comment id, a PR/issue number) is
  // unique forever, so it never collides, so the upsert never dedups it, so
  // `seen_count` stays frozen at 1 and the memory can never reach a recurrence
  // threshold — a write-only record. Detection is deliberately conservative:
  //   • a run of 6+ digits (a GitHub comment id is ~10; `sha256`, `oauth2`,
  //     `wcag22`, and semantic versions are all shorter runs);
  //   • a `pr<n>` / `issue<n>` reference — the number joined by nothing, `-`, or
  //     `_` — delimited by `:`, `-`, `_`, `/`, or a string boundary, so mid-word
  //     digits (`oauth2`) never match.
  // `volatileKeyAllow` is an embedder/test knob mirroring `short-value`'s
  // `minValueLen` precedent — a list of substrings that exempt a key. There is
  // no config key and no per-entry marker.
  'volatile-key': (e, { volatileKeyAllow = [] } = {}) => {
    const key = String(e.key ?? '');
    if (!key.trim()) return null; // an empty key is `empty-key`'s to report.
    // Tolerate a bare string as well as a list, so a caller passing
    // `{ volatileKeyAllow: 'lorekit-231' }` does not silently iterate characters.
    const allowList = Array.isArray(volatileKeyAllow) ? volatileKeyAllow : [volatileKeyAllow];
    for (const allow of allowList) {
      if (allow && key.includes(String(allow))) return null;
    }
    const digitRun = key.match(/\d{6,}/);
    if (digitRun) {
      return `key contains a volatile per-sighting identifier: '${digitRun[0]}' (a run of ${digitRun[0].length} digits)`;
    }
    // Boundary-anchored rather than split-then-match: splitting on `-` would
    // separate `pr` from `231` and `pr-231` would slip through. The reference
    // must start at a boundary (`:`, `-`, `_`, `/`, or the string start) and end
    // at one, so `oauth2`/`sha256`/`wcag22` still never match.
    const reference = key.match(/(?:^|[:\-_/])((?:pr|issue)[-_]?\d+)(?=$|[:\-_/])/i);
    if (reference) {
      return `key contains a volatile per-sighting identifier: '${reference[1]}' (a pr/issue number segment)`;
    }
    return null;
  },
  'malformed-scope': (e) => {
    const reason = scopeIssue(e.scope);
    return reason ? `malformed scope: ${reason}` : null;
  },
};

// Run every lint rule against one normalized entry, returning the findings it
// triggered as `[{ rule, message }]` (empty when the lesson is clean). Pure.
export function lintEntry(entry = {}, opts = {}) {
  const findings = [];
  for (const [rule, check] of Object.entries(LINT_RULES)) {
    const message = check(entry, opts);
    if (message) findings.push({ rule, message });
  }
  return findings;
}

// Lint every entry across a `gather()` result, grouping findings by scope. A
// per-scope read error is carried through (its entries can't be linted). Returns
// `{ groups: [{ scope, error, findings: [{ key, rule, message }] }], total }`
// where `total` is the count of individual findings. Pure.
export function lintGroups({ groups = [] } = {}, opts = {}) {
  const out = [];
  let total = 0;
  for (const g of groups) {
    if (g.error) {
      out.push({ scope: g.scope, error: g.error, findings: [] });
      continue;
    }
    const findings = [];
    for (const e of g.entries || []) {
      for (const f of lintEntry(e, opts)) {
        findings.push({ key: e.key, rule: f.rule, message: f.message });
        total += 1;
      }
    }
    out.push({ scope: g.scope, error: null, findings });
  }
  return { groups: out, total };
}

// ── `dedupe` — heuristic near-duplicate detection ─────────────────────────────

// Split a value into a set of lowercased alphanumeric word tokens — the unit of
// comparison for the (deliberately dependency-free, non-semantic) similarity
// heuristic. Pure.
export function tokenize(value) {
  return new Set(
    String(value == null ? '' : value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

// Jaccard similarity (|A∩B| / |A∪B|) over the two values' word-token sets — a
// zero-dependency HEURISTIC, never a semantic/embedding measure. Two empty
// bodies are treated as identical (1); one empty vs non-empty is disjoint (0).
// Accepts either raw strings or pre-computed token Sets. Pure.
export function similarity(a, b) {
  const sa = a instanceof Set ? a : tokenize(a);
  const sb = b instanceof Set ? b : tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Cluster likely-duplicate entries: any pair whose `similarity` is >= `threshold`
// links its members into one cluster (transitively, via union-find). Returns
// only clusters of 2+ members, each `{ members: [{ scope, key }], size,
// minSimilarity, maxSimilarity }` — `minSimilarity` is the weakest link that
// still met the threshold, a bounded signal of how tight the cluster is. Largest
// clusters first. Pure — the `dedupe` command's core, thoroughly unit-tested.
export function clusterDuplicates(entries = [], threshold = 0.8) {
  const items = entries.map((e, i) => ({
    i,
    scope: e.scope ?? null,
    key: e.key ?? null,
    tokens: tokenize(e.value),
  }));
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const pairs = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const sim = similarity(items[a].tokens, items[b].tokens);
      if (sim >= threshold) {
        pairs.push({ a, b, sim });
        parent[find(a)] = find(b);
      }
    }
  }
  const byRoot = new Map();
  for (const it of items) {
    const r = find(it.i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(it);
  }
  const clusters = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const idx = new Set(members.map((m) => m.i));
    const sims = pairs.filter((p) => idx.has(p.a) && idx.has(p.b)).map((p) => p.sim);
    clusters.push({
      members: members.map((m) => ({ scope: m.scope, key: m.key })),
      size: members.length,
      minSimilarity: sims.length ? Math.min(...sims) : threshold,
      maxSimilarity: sims.length ? Math.max(...sims) : threshold,
    });
  }
  clusters.sort((x, y) => y.size - x.size);
  return clusters;
}

// Compile a `--cluster-by-key` pattern into a stateless RegExp, or null on bad
// input (empty / non-string / unparseable) — never throws, mirroring
// `parseThreshold`'s "never crash on bad input" contract. Strips the global /
// sticky flags so `.exec` stays stateless across calls. Pure.
export function compileKeyPattern(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const re = new RegExp(raw);
    return re.flags ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;
  } catch {
    return null;
  }
}

// Cluster entries by a shared KEY capture rather than value overlap. Two entries
// cluster iff their keys yield the SAME first capture group of `pattern` (or the
// same full match when the pattern has no capture group). This catches
// coordinate-key duplicate FAMILIES — many `bucket::pr{N}-{commentId}::slug` rows
// recorded for one review comment, whose slugs (and thus values) differ enough
// that `clusterDuplicates`'s Jaccard sweep never links them. Returns only 2+
// clusters, each `{ members: [{ scope, key }], size, keyGroup }`, largest first
// (ties broken by keyGroup for stable output). A key that doesn't match the
// pattern is left unclustered. Pure — O(n), no threshold.
export function clusterByKeyPattern(entries = [], pattern) {
  const re =
    pattern instanceof RegExp
      ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      : compileKeyPattern(pattern);
  if (!re) return [];
  const byGroup = new Map();
  for (const e of entries) {
    const key = e.key == null ? '' : String(e.key);
    re.lastIndex = 0;
    const m = re.exec(key);
    if (!m) continue;
    const group = m[1] ?? m[0];
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ scope: e.scope ?? null, key });
  }
  const clusters = [];
  for (const [keyGroup, members] of byGroup) {
    if (members.length < 2) continue;
    clusters.push({ members, size: members.length, keyGroup });
  }
  clusters.sort(
    (x, y) => y.size - x.size || String(x.keyGroup).localeCompare(String(y.keyGroup)),
  );
  return clusters;
}

// Collect a store's non-archived entries for each scope, via the common
// `store.list({scope})` contract. Returns ordered per-scope groups plus a total
// — a per-scope read failure is captured on the group, never thrown, so one bad
// scope can't abort the listing. `store` may be a local or remote store.
// Single-page only (the existing default behaviour). For full-scope traversal
// use `gatherStream` below.
export async function gather(store, scopes, filters = {}) {
  // Parse the taxonomy filters into value sets. `filters` is passed to the store
  // too (the remote narrows server-side); we ALSO post-filter the normalized
  // entries here so the offline store — which ignores kind/host in its own
  // `list()` — stays consistent with remote. Post-filtering the remote rows is
  // idempotent (they were already narrowed) and matches on the same inferred
  // taxonomy a row without explicit columns gets in normalizeEntry.
  const wanted = (v) =>
    v == null ? null : new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean));
  const kindSet = wanted(filters.kind);
  const hostSet = wanted(filters.host);
  const keep = (e) =>
    (!kindSet || (e.kind != null && kindSet.has(e.kind))) &&
    (!hostSet || (e.host != null && hostSet.has(e.host)));

  const groups = [];
  let total = 0;
  for (const scope of scopes) {
    let res;
    try {
      res = await store.list({ scope, ...filters });
    } catch (e) {
      res = { ok: false, networkError: (e && e.message) || 'error' };
    }
    if (!res || res.ok === false) {
      groups.push({ scope, entries: [], error: describeError(res) });
      continue;
    }
    const entries = (res.entries || []).map(normalizeEntry).filter(keep);
    total += entries.length;
    groups.push({ scope, entries, error: null });
  }
  return { groups, total };
}

// Default maximum entries to survey in a full-scope traversal. High enough to
// cover almost every real scope; callers can raise or lower via `--max`.
export const DEFAULT_MAX = 5000;

// Page size used by `gatherStream` for remote stores.
const STREAM_PAGE_LIMIT = 100;

// Stream every page of entries across `scopes` from `store`, invoking
// `onPage({ scope, entries })` once per page as entries arrive. Designed for
// linear consumers (lint, stats, dedupe) that process page-by-page without
// accumulating all rows in memory.
//
// Options:
//   max        — hard cap on total surveyed entries (default: DEFAULT_MAX). When
//                reached the walk stops and `capped` is set in the result.
//   since      — ISO date/timestamp lower bound, forwarded as `created_since`.
//   until      — ISO date/timestamp upper bound, forwarded as `created_until`.
//   keyPrefix  — key prefix filter, forwarded as `key_prefix`.
//   onPage     — callback invoked with `{ scope, entries }` per page.
//
// Returns `{ surveyed, total, capped, byScope }` where:
//   surveyed  — total entries delivered to `onPage`.
//   total     — exact aggregate from `listScopes()` when available (remote),
//               else equal to `surveyed`.
//   capped    — true when `max` stopped the walk before all pages were read.
//   byScope   — `[{ scope, count, error }]` per scope (error=null on success).
//
// A per-scope read failure is captured on `byScope`, never thrown — mirrors
// `gather()`'s resilience contract. `LocalStore.list` returns everything in one
// page (no `nextCursor`), so the loop naturally terminates after one iteration
// offline and adds no overhead.
export async function gatherStream(store, scopes, {
  max = DEFAULT_MAX,
  since,
  until,
  keyPrefix,
  onPage,
} = {}) {
  const byScope = [];
  let surveyed = 0;
  let capped = false;

  // Attempt to get exact aggregate counts for the remote store via listScopes().
  // Only available on stores that implement listScopes(); degrades gracefully.
  let scopeCountMap = null;
  if (typeof store.listScopes === 'function') {
    try {
      const ls = await store.listScopes();
      if (ls && ls.ok && Array.isArray(ls.scopes)) {
        scopeCountMap = new Map(ls.scopes.map((s) => [s.scope, s.count]));
      }
    } catch { /* best-effort */ }
  }

  for (const scope of scopes) {
    if (capped) {
      byScope.push({ scope, count: 0, error: null });
      continue;
    }
    let cursor = undefined;
    let scopeCount = 0;
    let scopeError = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = max - surveyed;
      if (remaining <= 0) {
        capped = true;
        break;
      }
      const pageLimit = Math.min(STREAM_PAGE_LIMIT, remaining);
      let res;
      try {
        res = await store.list({
          scope,
          limit: pageLimit,
          cursor,
          ...(since ? { created_since: since } : {}),
          ...(until ? { created_until: until } : {}),
          ...(keyPrefix ? { key_prefix: keyPrefix } : {}),
        });
      } catch (e) {
        res = { ok: false, networkError: (e && e.message) || 'error' };
      }
      if (!res || res.ok === false) {
        scopeError = describeError(res);
        break;
      }
      const entries = (res.entries || []).map(normalizeEntry);
      if (entries.length > 0) {
        if (onPage) onPage({ scope, entries });
        scopeCount += entries.length;
        surveyed += entries.length;
      }
      // hasMore absent (local store) or false → done with this scope.
      if (!res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
      // Safety: stop if we hit the cap after this page.
      if (surveyed >= max) {
        capped = true;
        break;
      }
    }
    byScope.push({ scope, count: scopeCount, error: scopeError });
  }

  // Derive total: use the aggregate when available (remote), else surveyed.
  let total = surveyed;
  if (scopeCountMap) {
    total = 0;
    for (const scope of scopes) {
      total += scopeCountMap.get(scope) ?? 0;
    }
  }

  return { surveyed, total, capped, byScope };
}

// Token-blocking near-duplicate clustering — a performance-bounded alternative
// to `clusterDuplicates`'s O(n²) all-pairs sweep. Uses an inverted index
// (token → indices) to generate only the candidate pairs that share at least
// one token, then applies the SAME Jaccard `>= threshold` + union-find logic as
// `clusterDuplicates`. The resulting clusters are provably identical:
//
//   IF similarity(a, b) >= threshold > 0 THEN a and b share at least one token,
//   so they WILL appear as a candidate pair in the inverted-index sweep.
//
// Keeping `clusterDuplicates` intact means equivalence is a testable property
// (AC-7) rather than a rewrite claim. Pure.
export function clusterDuplicatesBlocked(entries = [], threshold = 0.8) {
  const items = entries.map((e, i) => ({
    i,
    scope: e.scope ?? null,
    key: e.key ?? null,
    tokens: tokenize(e.value),
  }));

  // Build inverted index: token → [item indices]
  /** @type {Map<string, number[]>} */
  const invertedIndex = new Map();
  for (const item of items) {
    for (const token of item.tokens) {
      if (!invertedIndex.has(token)) invertedIndex.set(token, []);
      invertedIndex.get(token).push(item.i);
    }
  }

  // Generate candidate pairs: any two items sharing at least one token.
  // Use a Set of encoded pair keys to avoid duplicates.
  const candidatePairs = new Set();
  for (const indices of invertedIndex.values()) {
    for (let x = 0; x < indices.length; x += 1) {
      for (let y = x + 1; y < indices.length; y += 1) {
        const a = Math.min(indices[x], indices[y]);
        const b = Math.max(indices[x], indices[y]);
        candidatePairs.add(`${a}:${b}`);
      }
    }
  }

  // Apply the SAME union-find as clusterDuplicates over candidate pairs only.
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const pairs = [];
  for (const pairKey of candidatePairs) {
    const [a, b] = pairKey.split(':').map(Number);
    const sim = similarity(items[a].tokens, items[b].tokens);
    if (sim >= threshold) {
      pairs.push({ a, b, sim });
      parent[find(a)] = find(b);
    }
  }

  // Assemble clusters — identical logic to clusterDuplicates.
  const byRoot = new Map();
  for (const it of items) {
    const r = find(it.i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(it);
  }
  const clusters = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const idx = new Set(members.map((m) => m.i));
    const sims = pairs.filter((p) => idx.has(p.a) && idx.has(p.b)).map((p) => p.sim);
    clusters.push({
      members: members.map((m) => ({ scope: m.scope, key: m.key })),
      size: members.length,
      minSimilarity: sims.length ? Math.min(...sims) : threshold,
      maxSimilarity: sims.length ? Math.max(...sims) : threshold,
    });
  }
  clusters.sort((x, y) => y.size - x.size);
  return clusters;
}

// Render one section (Offline or Remote). `section` is either
//   { available:false, reason }                         → a graceful note, or
//   { available:true, groups, total }                   → grouped lessons.
export function renderSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  const printable = (section.groups || []).filter((g) => g.entries.length || g.error);
  if (!printable.length) {
    // `header.empty` lets `search` say "no memories match" where `list` says
    // "no memories found"; both are the same empty-section case.
    log(`  ${c.dim(header.empty || 'no memories found in the applicable scopes')}`);
    return;
  }

  for (const g of printable) {
    log(`  ${c.bold(g.scope)}`);
    if (g.error) {
      log(`    ${c.yellow('!')} ${c.dim(g.error)}`);
      continue;
    }
    for (const e of g.entries) {
      const when = e.updated ? `  ${c.dim(`(updated ${shortDate(e.updated)})`)}` : '';
      // Taxonomy badge — the kind (and host, when known) so the three families
      // are visible at a glance in the list. Omitted for rows written before the
      // taxonomy existed (NULL kind).
      const badge = e.kind ? ` ${c.dim(`[${e.kind}${e.host ? `·${e.host}` : ''}]`)}` : '';
      log(`    ${c.cyan('•')} ${g.scope}::${e.key}${badge}${when}`);
      if (e.value) log(`      ${c.dim(preview(e.value))}`);
    }
  }
}
