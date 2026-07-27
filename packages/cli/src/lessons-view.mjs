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
import { resolvePrecedence, matchesQuery } from './lessons-pure.mjs';
export { resolvePrecedence, matchesQuery };

// The scopes that apply to the current directory, most-specific → broadest:
// project, branch, repo, global. De-duplicated (a repo with no branch scope,
// or a project whose name collides, never lists a scope twice). Pure — takes an
// already-derived `deriveScope()` result so it is trivially unit-testable.
export function scopeList({ projectScope, branchScope, repoScope } = {}) {
  return [...new Set([projectScope, branchScope, repoScope, 'global'].filter(Boolean))];
}

// Normalize an entry from either store (local markdown row or hosted DB row)
// into one stable shape the view + `--json` output can rely on. Remote rows may
// spell the timestamp `updated_at`; local rows use `updated`.
export function normalizeEntry(e = {}) {
  return {
    scope: e.scope ?? null,
    key: e.key ?? null,
    value: e.value == null ? '' : String(e.value),
    updated: e.updated ?? e.updated_at ?? null,
    tags: Array.isArray(e.tags) ? e.tags : [],
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

// Validate a scope string against the canonical `::`-separated format
// (`global`, `project::name`, `repo::owner/name`, `branch::owner/name::branch`).
// Returns null when valid, else a short human reason. The classic failure is a
// single `:` where `::` is expected (a 400 on the server). Pure — the lint
// `malformed-scope` rule and any future scope check share this one validator.
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
    return /^[^/]+\/[^/]+$/.test(rest) ? null : 'repo scope must be `owner/name`';
  }
  // branch
  const parts = rest.split('::');
  if (parts.length !== 2 || !/^[^/]+\/[^/]+$/.test(parts[0]) || !parts[1]) {
    return 'branch scope must be `owner/name::branch`';
  }
  return null;
}

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

// Collect a store's non-archived entries for each scope, via the common
// `store.list({scope})` contract. Returns ordered per-scope groups plus a total
// — a per-scope read failure is captured on the group, never thrown, so one bad
// scope can't abort the listing. `store` may be a local or remote store.
export async function gather(store, scopes) {
  const groups = [];
  let total = 0;
  for (const scope of scopes) {
    let res;
    try {
      res = await store.list({ scope });
    } catch (e) {
      res = { ok: false, networkError: (e && e.message) || 'error' };
    }
    if (!res || res.ok === false) {
      groups.push({ scope, entries: [], error: describeError(res) });
      continue;
    }
    const entries = (res.entries || []).map(normalizeEntry);
    total += entries.length;
    groups.push({ scope, entries, error: null });
  }
  return { groups, total };
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
    // `header.empty` lets `search` say "no lessons match" where `list` says
    // "no lessons found"; both are the same empty-section case.
    log(`  ${c.dim(header.empty || 'no lessons found in the applicable scopes')}`);
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
      log(`    ${c.cyan('•')} ${e.key}${when}`);
      if (e.value) log(`      ${c.dim(preview(e.value))}`);
    }
  }
}
