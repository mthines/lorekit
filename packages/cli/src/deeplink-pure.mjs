// Dependency-free deep-link builder for LoreKit dashboard URLs.
//
// Zero imports on purpose (the `lessons-pure.mjs` precedent): both the hook hot
// path (`core/lessons.mjs`) and the `link` command / `--link` flag share this
// without pulling in `util`/render/store code.
//
// THE governing constraint — every `/lore` Explorer param is read by the web
// app's `useUrlState` (`packages/web/src/lib/hooks/useUrlState.ts`) via
// `JSON.parse(searchParams.get(key))`, falling back to the param's DEFAULT on a
// parse failure and OMITTING any param whose value equals its default. So a URL
// value must be `encodeURIComponent(JSON.stringify(value))` — a JSON string,
// double-quoted for a string scope — NOT a raw token. A raw `?scope=global`
// fails `JSON.parse` and silently means "all scopes". This is the exact inverse
// of the app's read, and mirrors the production builder in
// `packages/web/src/components/dashboard/ScopeHealthCard.tsx`:
//   `/lore?scope=${encodeURIComponent(JSON.stringify(health.scope))}`.

// The default dashboard base for the hosted deployment. Overridable per call
// (self-hosted setups) via `resolveAppBase` (`--base` flag / `LOREKIT_APP_URL`).
export const DEFAULT_APP_BASE = 'https://lorekit.io';

// The `/lore` Explorer param defaults, mirroring the `useUrlState` calls in
// `LoreExplorer.tsx` (+ the `lesson` param in `MemorySidebarProvider.tsx`)
// EXACTLY. A param whose value JSON-equals its default is omitted from the URL
// — the app would treat a present-but-default param as noise, and clean URLs
// match what the app itself produces.
export const LORE_PARAM_DEFAULTS = {
  scope: null, // string | null — null means "all scopes"
  q: '', // string search query
  range: null, // { from, to } | null (DateRange, "YYYY-MM-DD")
  owner: 'all', // 'all' | 'personal' | { orgId }
  tags: [], // string[] — label filter (AND across labels); [] means "no filter"
  view: 'scope', // 'scope' | 'time'
  archived: false, // boolean
  lesson: null, // { scope, key } | null — opens the detail sheet
};

// A stable, readable param order (also makes URLs deterministic for tests).
// Mirrors the `useUrlState` call order in `LoreExplorer.tsx` (+ the `lesson`
// param last), so `tags` sits between `owner` and `view`. `scope` precedes
// `lesson` so a lesson link reads `?scope=…&lesson=…`.
const PARAM_ORDER = ['scope', 'q', 'range', 'owner', 'tags', 'view', 'archived', 'lesson'];

// Strip trailing slashes from a base URL, falling back to the default when the
// input is empty/absent. Pure.
function normalizeBase(base) {
  const b = String(base == null ? '' : base)
    .trim()
    .replace(/\/+$/, '');
  return b || DEFAULT_APP_BASE;
}

// Resolve the dashboard base URL: an explicit `--base` flag wins, then the
// `LOREKIT_APP_URL` env var, then the baked-in default. Pure — `env` is passed
// in (never read from `process` here) so it stays trivially unit-testable.
export function resolveAppBase({ base, env = {} } = {}) {
  const flag = typeof base === 'string' && base.trim() ? base.trim() : '';
  const fromEnv =
    env && typeof env.LOREKIT_APP_URL === 'string' && env.LOREKIT_APP_URL.trim()
      ? env.LOREKIT_APP_URL.trim()
      : '';
  return normalizeBase(flag || fromEnv || DEFAULT_APP_BASE);
}

// Encode ONE param value the way `useUrlState` reads it back:
// `encodeURIComponent(JSON.stringify(value))`. The exact inverse of the app's
// `JSON.parse(searchParams.get(key))`. Pure.
export function encodeParam(value) {
  return encodeURIComponent(JSON.stringify(value));
}

// Build the `/lore` query string from a params object, JSON-encoding each value
// and OMITTING any param that is `undefined` or JSON-equal to its default (so
// the URL carries only the filters that actually change the view). Pure and
// total — an unknown key in `params` is ignored (only PARAM_ORDER is emitted).
export function buildLoreQuery(params = {}) {
  const parts = [];
  for (const key of PARAM_ORDER) {
    const value = params[key];
    if (value === undefined) continue;
    if (JSON.stringify(value) === JSON.stringify(LORE_PARAM_DEFAULTS[key])) continue;
    parts.push(`${key}=${encodeParam(value)}`);
  }
  return parts.join('&');
}

// Build a full `/lore` deep link from a params object. `base` defaults to the
// hosted dashboard; pass a resolved base for self-hosted setups. Pure.
export function buildLoreUrl(params = {}, { base = DEFAULT_APP_BASE } = {}) {
  const cleanBase = normalizeBase(base);
  const query = buildLoreQuery(params);
  return `${cleanBase}/lore${query ? `?${query}` : ''}`;
}

// A shareable link to the Explorer filtered to a scope. `null`/`''` → the bare
// `/lore` (all scopes, the default); any concrete scope — INCLUDING `global` —
// → `?scope="<scope>"`. (`global` is a real scope the app can filter to, not a
// synonym for "no filter" — only the actual default `null` is omitted.) Pure.
export function loreScopeUrl(scope, opts = {}) {
  const params = scope ? { scope } : {};
  return buildLoreUrl(params, opts);
}

// A shareable link that opens a specific lesson's detail sheet. Sets the
// `lesson` param (which opens the sheet) plus `scope` — NOT because scope is
// needed to RESOLVE the lesson (the sidebar's `useLoreData` reads one unfiltered
// recent set, `.limit(500)`, non-archived, so `scope` does not widen that
// lookup), but so the Explorer list BEHIND the sheet is filtered to the lesson's
// own scope, coherent with the detail view. A lesson older than that window or
// archived can still open blank — a dashboard-side limitation the link can't fix.
// `scope` is the lesson's own scope. Pure.
export function buildLessonUrl(scope, key, opts = {}) {
  const params = { lesson: { scope, key } };
  if (scope) params.scope = scope;
  return buildLoreUrl(params, opts);
}

// Resolve a SINGLE positional `link` argument into a { scope, key } pair,
// disambiguating a bare scope from the `<scope>::<key>` shorthand. `isScope` is
// an injected validity predicate (the caller passes a `scopeIssue`-based check),
// keeping this module zero-import.
//
// The rule: split at the LAST `::` and take it as `<scope>::<key>` ONLY when the
// left side is itself a COMPLETE valid scope — otherwise the whole arg is the
// scope. Splitting on the last `::` (not the first) keeps a multi-segment scope
// whole (`repo::owner/name::key` → scope `repo::owner/name`, key `key`); gating
// on a valid left side means a bare `repo::owner/name` is NOT mis-split, because
// its left part `repo` is not a valid scope. This is the fix for the prior
// first-`::` split, which turned `link repo::acme/widget` into scope="repo" plus
// a bogus `acme/widget` key — breaking the shorthand for EVERY non-`global`
// scope. A malformed arg falls through to the scope, never a fabricated key. Pure.
export function resolveScopeArg(arg, isScope = () => false) {
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

// ── Flag → param coercion (pure, shared by the `link` command) ────────────────

// Coerce the `--owner` flag to an `OwnerFilter`: 'all' (default) / 'personal' /
// any other non-empty string → `{ orgId }`. Pure.
export function parseOwnerArg(owner) {
  if (typeof owner !== 'string' || !owner || owner === 'all') return 'all';
  if (owner === 'personal') return 'personal';
  return { orgId: owner };
}

// Coerce the `--view` flag to a `ViewMode`: only 'time' is non-default; anything
// else (incl. absent/invalid) → 'scope'. Pure.
export function parseViewArg(view) {
  return view === 'time' ? 'time' : 'scope';
}

// Coerce the `--tags` flag to a normalized `string[]` label filter, mirroring the
// web app's `normalizeTags` (`packages/web/src/lib/tag-filter.ts`): trim each
// entry, drop empties, de-duplicate, preserve first-seen order. Accepts either a
// JSON array string (`'["perf","ci"]'`) or the friendlier comma-separated form
// (`'perf, ci'`); a malformed JSON array falls back to comma-splitting rather
// than throwing. Returns `[]` for absent/empty input (the default → omitted from
// the URL). Pure.
export function parseTagsArg(tags) {
  if (Array.isArray(tags)) return normalizeTagList(tags);
  if (typeof tags !== 'string' || !tags.trim()) return [];
  const s = tags.trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return normalizeTagList(parsed);
    } catch {
      /* malformed JSON array → fall through to comma-splitting */
    }
  }
  return normalizeTagList(s.split(','));
}

// Trim, drop non-string/empty entries, and de-duplicate preserving order. The
// CLI-side twin of the web's `normalizeTags`; kept inline to keep this module
// zero-import. Pure.
function normalizeTagList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Coerce the date-range flags to a `{ from, to }` DateRange or null. `--range`
// (a JSON object string) wins; else `--from`/`--to` shorthand builds one (both
// keys always present so the shape matches the app's DateRange). A malformed
// `--range` yields null rather than throwing. Pure.
export function parseRangeArg({ range, from, to } = {}) {
  if (typeof range === 'string' && range.trim()) {
    try {
      const v = JSON.parse(range);
      if (v && typeof v === 'object') return v;
    } catch {
      /* malformed --range → no range */
    }
    return null;
  }
  const hasFrom = typeof from === 'string' && from;
  const hasTo = typeof to === 'string' && to;
  if (hasFrom || hasTo) {
    return { from: hasFrom ? from : '', to: hasTo ? to : '' };
  }
  return null;
}

// The Explorer's most-specific applicable scope for the cwd — `readOrder`'s
// first non-global entry, or null when only `global` applies (→ a bare `/lore`).
// The single-scope representation a deep link can carry for a multi-scope view.
// Pure — takes an already-derived `deriveScope()` result.
export function mostSpecificScope({ readOrder = [] } = {}) {
  return readOrder.find((s) => s && s !== 'global') ?? null;
}

// Classify a params object into a bounded surface label (non-PII — safe as a
// telemetry attribute): 'lesson' | 'search' | 'scope' | 'explorer'. Pure.
export function surfaceFor(params = {}) {
  if (params.lesson) return 'lesson';
  if (params.q) return 'search';
  if (params.scope) return 'scope';
  return 'explorer';
}
