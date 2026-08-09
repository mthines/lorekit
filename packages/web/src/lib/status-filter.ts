/**
 * The Lore Explorer's Status filter — active / archived / expiring soon.
 *
 * This replaces the `archived` on/off toggle. The toggle could express two of
 * the three states a memory can be in and had no room for the third: migration
 * 00030 gave memories a TTL and `GET /memories?expiring_within_days=` now
 * answers "what am I about to lose", but a boolean has nowhere to put it.
 *
 * The three states are MUTUALLY EXCLUSIVE by design rather than by accident.
 * They are not three independent checkboxes because "archived AND expiring" is
 * a question nobody browsing their lore is asking, and offering it would cost a
 * third of the control's width to a combination that returns almost nothing.
 * (The API composes them anyway — `?archived=true&expiring_within_days=7` is a
 * legal request; the UI simply does not mint one.)
 *
 * Pure, so the mapping from what the user picked to what the wire carries is
 * testable without a browser — the same functional-core split `lib/filters.ts`
 * and `lib/time-range.ts` follow.
 */

import type { ListMemoriesQuery } from '@lorekit/schemas/memory';

/** The three states a Status selection can be in. */
export type MemoryStatus = 'active' | 'archived' | 'expiring';

export const MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'archived', 'expiring'] as const;

/** What an Explorer with no `?status=` shows. */
export const DEFAULT_STATUS: MemoryStatus = 'active';

/**
 * The horizon "expiring soon" means, in days.
 *
 * Seven, because the view exists to be ACTED on: a week is long enough that
 * something can be done about what it lists and short enough that the list is
 * short. It is a UI default, not an API one — `expiring_within_days` accepts
 * 1–365 and the route has no opinion — so widening it later changes one
 * constant here and nothing on the server.
 */
export const EXPIRING_WITHIN_DAYS = 7;

/** Label for each state, in control order. */
export const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: 'Active',
  archived: 'Archived',
  expiring: 'Expiring',
};

/**
 * The accessible description each state carries, since "Expiring" alone does
 * not say over what horizon.
 */
export const STATUS_HINTS: Record<MemoryStatus, string> = {
  active: 'Live memories',
  archived: 'Archived memories',
  expiring: `Live memories expiring within ${EXPIRING_WITHIN_DAYS} days`,
};

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value);
}

/**
 * Resolve the effective status from the URL.
 *
 * Exactly the relationship `filters` has with the legacy `tags` param, for the
 * same reason: `?archived=true` is a DOCUMENTED public parameter
 * (`docs/deep-links.mdx`), `lorekit link --archived` emits it, and links live in
 * PRs and Slack messages. So it is still READ and never written.
 *
 * `status` wins when present, including `status=active` over a stale
 * `archived=true` — an explicit selection must be able to override an inherited
 * one, or a link could never turn the archived view back off. An absent
 * `status` falls back to the legacy flag, which is what keeps old links
 * resolving to the view they always did.
 */
export function resolveStatus(rawStatus: unknown, legacyArchived: unknown): MemoryStatus {
  if (isMemoryStatus(rawStatus)) return rawStatus;
  if (legacyArchived === true) return 'archived';
  return DEFAULT_STATUS;
}

/**
 * Whether this status views the ARCHIVED population.
 *
 * The distinction the boolean toggle used to be, kept as its own function
 * because three call sites need it and each would otherwise re-derive it:
 * the list request, the facet catalog (a catalog must describe the population
 * it filters — `GET /memories/facets?archived=`), and the archive mutations'
 * cache predicate.
 *
 * `expiring` is FALSE here, and that is the whole point of it being a separate
 * state rather than a modifier: an expiring memory is a live one with a
 * deadline, so it belongs to the active population and is counted, catalogued
 * and cached as one.
 */
export function isArchivedView(status: MemoryStatus): boolean {
  return status === 'archived';
}

/** The expiry horizon this status implies, or `undefined` when it implies none. */
export function expiringWithinDays(status: MemoryStatus): number | undefined {
  return status === 'expiring' ? EXPIRING_WITHIN_DAYS : undefined;
}

/**
 * The `GET /memories` params a status selects.
 *
 * One place that knows the mapping, so the list request and any future consumer
 * cannot disagree about what "expiring" means on the wire.
 *
 * Note `expiring` sends `archived=false` EXPLICITLY rather than relying on the
 * route's default. The route does default to active, but the pairing is
 * load-bearing here — `expiring_within_days` is a filter over live rows, and
 * spelling the population out means a reader of the emitted params can see the
 * view is live without knowing the route's defaults.
 */
export function statusToQueryParams(status: MemoryStatus): Partial<ListMemoriesQuery> {
  switch (status) {
    case 'archived':
      return { archived: 'true' };
    case 'expiring':
      return { archived: 'false', expiring_within_days: EXPIRING_WITHIN_DAYS };
    case 'active':
      return { archived: 'false' };
  }
}

/**
 * What to persist to `?status=` — `null` meaning "drop the param".
 *
 * The default is dropped so a shared link stays clean, matching how every other
 * Explorer param behaves. There is deliberately no `filtersParamValue`-style
 * exception for a legacy link: selecting Active while `?archived=true` is in the
 * URL DOES need to survive a reload, but `resolveStatus` already gives `status`
 * precedence, so writing `status=active` alongside the stale flag is the correct
 * and self-explanatory encoding — and it is not the default-drop case, because
 * the param is only dropped when nothing else contradicts it.
 */
export function statusParamValue(status: MemoryStatus, legacyArchived: boolean): MemoryStatus | null {
  if (status !== DEFAULT_STATUS) return status;
  return legacyArchived ? 'active' : null;
}
