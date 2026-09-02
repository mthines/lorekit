/**
 * button-analytics — the pure click-tracking seam for the Button primitive.
 *
 * Lifted out of `components/ui/Button.tsx` (which stays behaviour-only, the same
 * way the visual core lives in the pure `lib/button-styles.ts`) so the wrapping
 * DECISION — "does this click emit, and with what payload" — is a single pure
 * function with a co-located node-env spec. This mirrors the repo's
 * functional-core convention (`button-styles.ts`, `auth-redirect.ts`,
 * `useEditableForm.spec.ts`'s extracted helpers) and sidesteps needing a DOM
 * test harness the project does not install.
 */

import type { MouseEvent as ReactMouseEvent, MouseEventHandler } from 'react';

import { track } from '@/lib/analytics/track';
import type { ButtonSize, ButtonVariant } from '@/lib/button-styles';

/** The element either public button component can resolve to. */
type ButtonElement = HTMLButtonElement | HTMLAnchorElement;

export interface ButtonClickMeta {
  /** The static `<surface>.<action>` slug; when absent the button opts out. */
  analyticsId?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * Wrap a click handler so it fires a best-effort `ui.button_click` event before
 * delegating to the original handler.
 *
 * - When no `analyticsId` is set the ORIGINAL handler is returned unchanged (a
 *   button opts IN by naming itself), so an untagged button emits nothing.
 * - Tracking runs FIRST and is best-effort (`track` swallows its own errors), so
 *   it can neither suppress nor delay the real click.
 * - The disabled/loading "does not emit" guarantee is NOT re-checked here: a
 *   disabled native `<button>` fires no click event, and `BaseButton`'s link
 *   path suppresses `onClick` (and therefore this wrapper) when disabled/loading.
 *   A disabled control never reaches this handler.
 */
export function withButtonClickTracking(
  onClick: MouseEventHandler<ButtonElement> | undefined,
  { analyticsId, variant, size }: ButtonClickMeta,
): MouseEventHandler<ButtonElement> | undefined {
  if (analyticsId === undefined) return onClick;
  return (event: ReactMouseEvent<ButtonElement>) => {
    track({ name: 'ui.button_click', buttonId: analyticsId, variant, size });
    onClick?.(event);
  };
}
