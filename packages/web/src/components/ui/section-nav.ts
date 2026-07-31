/**
 * Pure logic for {@link SectionNav}'s two-level navigation.
 *
 * Extracted from the component because the rules are policy, not rendering:
 * *when* a section reveals its sub-items, and *which* sub-item counts as the
 * current one. Both are easy to get subtly wrong (an off-by-one on the
 * "more than one card" rule silently turns every section into a tree; a
 * missing empty-hash fallback leaves the first sub-item unhighlighted on
 * arrival) and neither needs a DOM to verify.
 */

/**
 * A sub-item is an in-page anchor, never a route. Two levels of *routes* would
 * mean a parent page that exists only to hold children — a click that lands
 * nowhere useful. An anchor keeps every card on one scrollable page and makes
 * the sub-item a shortcut, not a destination.
 */
export interface SectionNavSubItem {
  /** Stable key + the element id it targets (rendered as `href="#{id}"`). */
  id: string;
  label: string;
}

/**
 * Whether a section should reveal its sub-items.
 *
 * Two conditions, both required:
 *  1. **The section is the active one.** Progressive disclosure — the rail
 *     stays a flat list of destinations until you are inside one.
 *  2. **It has more than one sub-item.** A lone sub-item is a link to the page
 *     you are already on: pure noise. Sections earn depth by having enough
 *     content to need it, so a section that grows from one card to two picks
 *     up its sub-nav automatically and one that shrinks back loses it.
 */
export function shouldRevealSubItems(
  active: boolean,
  subItems: readonly SectionNavSubItem[] | undefined,
): boolean {
  return active && (subItems?.length ?? 0) > 1;
}

/**
 * Whether a section is the one currently being viewed. Exact match or any
 * nested route beneath it; `external` items link out of the section tree and
 * are never active.
 */
export function isSectionActive(pathname: string, href: string, external?: boolean): boolean {
  if (external) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Which sub-item is current, given the URL fragment (without the leading `#`).
 *
 * With no fragment the user is at the top of the page, which is the first
 * card — so the first sub-item is current. Without that fallback, arriving at
 * `/settings/user` shows a sub-list where nothing is highlighted, which reads
 * as "none of these" rather than "you are at the top".
 *
 * An unknown fragment (a stale link, or an anchor belonging to something else
 * on the page) highlights nothing rather than guessing.
 */
export function activeSubItemId(
  subItems: readonly SectionNavSubItem[],
  hash: string,
): string | null {
  if (subItems.length === 0) return null;
  if (hash === '') return subItems[0]?.id ?? null;
  return subItems.some((item) => item.id === hash) ? hash : null;
}

/**
 * Whether a panel is the anchor target of the current URL fragment. A
 * collapsible panel uses this to open itself: a sub-item that scrolls you to a
 * collapsed header looks broken, so the jump and the disclosure move together.
 */
export function isPanelTargeted(hash: string, anchorId: string | undefined): boolean {
  return Boolean(anchorId) && hash === anchorId;
}
