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
  view: 'scope', // 'scope' | 'time'
  archived: false, // boolean
  lesson: null, // { scope, key } | null — opens the detail sheet
};

// A stable, readable param order (also makes URLs deterministic for tests).
// `scope` precedes `lesson` so a lesson link reads `?scope=…&lesson=…`.
const PARAM_ORDER = ['scope', 'q', 'range', 'owner', 'view', 'archived', 'lesson'];

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

// A shareable link that opens a specific lesson's detail sheet. Sets BOTH the
// `lesson` param (which opens the sheet) AND `scope` (so the lesson is in the
// fetched set — the sheet can render blank if the lesson isn't in the default
// fetch). `scope` is the lesson's own scope. Pure.
export function buildLessonUrl(scope, key, opts = {}) {
  const params = { lesson: { scope, key } };
  if (scope) params.scope = scope;
  return buildLoreUrl(params, opts);
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
