/**
 * Which view of the Explorer's results a reader is looking at.
 *
 * A URL param rather than component state, following the rule the rest of
 * `/lore` already keeps: a shared link carries WHAT you are looking at, not how
 * tall you left a panel. "Here is the map of our CI lessons" has to be
 * pasteable, and it is only pasteable if the view travels in the link with the
 * scope and the filters.
 *
 * Absent means `list`, and the list default is never written to the URL: an
 * un-parameterised `/lore` is the canonical link every existing bookmark and
 * every `lorekit link` URL already points at, and minting `?view=list` onto it
 * would churn history for a reader who changed nothing.
 */

export const LORE_VIEWS = ['list', 'map'] as const;
export type LoreView = (typeof LORE_VIEWS)[number];

export const DEFAULT_LORE_VIEW: LoreView = 'list';

/**
 * Read a `?view=` param.
 *
 * An unrecognised value falls back to the list rather than erroring. The param
 * arrives from a hand-editable URL and a stale bookmark; a typo should land the
 * reader on the view that can show everything, not on an error page.
 */
export function resolveView(param: string | null | undefined): LoreView {
  return LORE_VIEWS.includes(param as LoreView) ? (param as LoreView) : DEFAULT_LORE_VIEW;
}

/** What to write to the URL — `null` for the default, so it stays out of the link. */
export function viewParamValue(view: LoreView): string | null {
  return view === DEFAULT_LORE_VIEW ? null : view;
}
