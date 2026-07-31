/**
 * Pure ARIA wiring for a disclosure (a trigger that shows/hides one panel).
 *
 * Extracted rather than inlined because the two halves have to agree: the
 * trigger's `aria-controls` must name a panel that is actually in the DOM, and
 * the panel's `hidden` must track the same boolean as `aria-expanded`. Getting
 * those out of sync is invisible on screen and only shows up in a screen
 * reader, so they are derived from one source and unit-tested.
 *
 * The panel is kept mounted and hidden with the `hidden` attribute rather than
 * conditionally rendered, which:
 *  - keeps `aria-controls` pointing at a real element even when collapsed,
 *  - preserves any in-progress form state across a collapse/expand, and
 *  - keeps the content out of the accessibility tree, tab order, and
 *    find-in-page while hidden.
 *
 * WCAG 2.2: 4.1.2 (Name, Role, Value) for the expanded state.
 */

export interface DisclosureTriggerProps {
  'aria-expanded': boolean;
  'aria-controls': string;
}

export interface DisclosurePanelProps {
  id: string;
  hidden: boolean;
}

export function disclosureTriggerProps(open: boolean, panelId: string): DisclosureTriggerProps {
  return { 'aria-expanded': open, 'aria-controls': panelId };
}

export function disclosurePanelProps(open: boolean, panelId: string): DisclosurePanelProps {
  return { id: panelId, hidden: !open };
}
