// Shared, store-agnostic view layer for the read commands (`list`, and the
// stacked `search` / `show` / `stats` / `diff` to come). Two responsibilities:
//   1. pure helpers — the applicable-scope set, entry normalization, previews;
//   2. `gather()` — collect a store's entries per scope behind the common
//      store contract; and `renderSection()` — print one offline/remote section.
//
// Kept separate from `list.mjs` on purpose: the offline/remote sectioned
// rendering is a reusable seam, not a `list`-only detail. Zero-dependency.
import { log, heading, status, c } from './util.mjs';

// The scopes that apply to the current directory, most-specific → broadest:
// project, branch, repo, global. De-duplicated (a repo with no branch scope,
// or a project whose name collides, never lists a scope twice). Pure — takes an
// already-derived `deriveScope()` result so it is trivially unit-testable.
export function scopeList({ projectScope, branchScope, repoScope } = {}) {
  return [projectScope, branchScope, repoScope, 'global']
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
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
function describeError(res) {
  if (!res) return 'no response';
  if (res.networkError) return String(res.networkError);
  if (res.error) return res.error.message || `error ${res.error.code}`;
  return 'unreadable';
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
    log(`  ${c.dim('no lessons found in the applicable scopes')}`);
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
