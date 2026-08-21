/**
 * Per-viewer UI preferences — the pure half.
 *
 * A preference is a small, non-critical choice about how a viewer likes to *look*
 * at the product: is a panel folded, which of two charts is on top. It is not
 * product data, so it never goes near the REST API; it is not shareable, so it
 * never goes in the URL (a link should carry what you are looking at, not how
 * tall you left a panel). `localStorage` is exactly the right size of home for it.
 *
 * ## Why the codec is separate from the storage
 *
 * `localStorage` hands back `string | null` and can throw outright (private
 * browsing, "block all site data"), so every call site that rolled its own
 * read+parse — and there were three — re-derived the same two questions: what
 * does an ABSENT value mean, and what does a CORRUPT one mean. Both answers must
 * be "the default", and both are pure. So they live here, unit-tested, and the
 * effectful half (`lib/hooks/usePersistedPreference.ts`) does nothing but move
 * strings in and out of the store.
 *
 * The functions take `raw: string | null` rather than a key, which is what makes
 * them testable without a DOM and what lets the hook decide what "not yet known"
 * means (see {@link UNRESOLVED}).
 */

/**
 * Every preference key the dashboard persists, in one place.
 *
 * Namespaced `lorekit:` so the app's keys are distinguishable from anything else
 * on the origin, and listed centrally so a key is never spelled twice — a writer
 * and a reader disagreeing by one character is a bug that looks exactly like
 * "persistence doesn't work".
 */
export const PREFERENCE_KEYS = {
  /** Whether the Lore Explorer's Activity panel is expanded. */
  explorerInsightsOpen: 'lorekit:explorer-insights-open',
  /** Which body the Lore Explorer's Activity panel shows when expanded. */
  explorerInsightsView: 'lorekit:explorer-insights-view',
} as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[keyof typeof PREFERENCE_KEYS];

/**
 * The value a preference has before the client store has been consulted.
 *
 * `null` — deliberately NOT `''`. The store's snapshot for a browser that has
 * never stored this preference is `''`, and "absent" and "unknown" are different
 * facts: absent means *fall back to the default*, unknown means *we are still on
 * the server, or in the hydration render, and must not assert anything yet*.
 * Collapsing the two is how a panel ends up rendering expanded and then snapping
 * shut a frame later.
 */
export const UNRESOLVED = null;

/** Whether a raw snapshot has been resolved against the client store yet. */
export function isResolved(raw: string | null): raw is string {
  return raw !== UNRESOLVED;
}

const TRUE_VALUES = new Set(['1', 'true']);
const FALSE_VALUES = new Set(['0', 'false']);

/**
 * A stored boolean, or `fallback` when the value is absent, unresolved, or not
 * one of the four recognised spellings.
 *
 * Tolerant on read and canonical on write (`serializeBooleanPreference` only ever
 * emits `'1'`/`'0'`) so a value written by an older build, or by hand in a
 * devtools console, still resolves rather than silently reading as `false` —
 * which for a disclosure preference would mean "collapse everything".
 */
export function parseBooleanPreference(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return fallback;
}

/** The canonical on-disk spelling of a boolean preference. */
export function serializeBooleanPreference(value: boolean): string {
  return value ? '1' : '0';
}

/**
 * A stored member of a closed set, or `fallback` for anything else.
 *
 * The `allowed` list is the guard: a preference whose vocabulary changed between
 * releases (a view that no longer exists, a renamed member) must degrade to the
 * default rather than putting the UI into a state it can no longer render.
 */
export function parseEnumPreference<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === null) return fallback;
  const value = raw.trim();
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
