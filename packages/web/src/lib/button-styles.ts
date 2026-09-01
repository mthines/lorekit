/**
 * button-styles — the pure styling core shared by `Button` and `IconButton`.
 *
 * Everything visual about a button lives here as token-only class strings, so
 * the component shell (Button.tsx) stays about behaviour (polymorphism, loading,
 * refs) and the two components can never drift apart. This is the same
 * variant-map house pattern as `Badge` (components/ui/Badge.tsx), lifted into
 * `lib/` because it is pure and unit-tested.
 *
 * Token discipline: every colour is a `var(--color-*)` token — never a raw hex.
 * The inventory that motivated this primitive found `text-[#000]`,
 * `text-[#1a0000]` and `text-red-400` scattered across hand-rolled buttons;
 * `button-styles.spec.ts` asserts no hex can reappear here.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'danger-outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

import { cn } from './cn';

/**
 * Shared by every button, whatever the variant. One radius, one focus ring, one
 * transition, and one disabled treatment — resolving the drift where these were
 * written three different ways across the codebase.
 *
 * The disabled treatment is stated twice on purpose: `disabled:*` covers a
 * `<button disabled>`, and `aria-disabled:*` covers a link (an `<a>` has no
 * native `disabled`, so a loading/disabled link is marked `aria-disabled` and
 * relies on these to grey out and stop pointer events).
 */
const BASE = cn(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap',
  'transition-[background-color,border-color,color,filter] duration-150',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]',
  'disabled:opacity-50 disabled:pointer-events-none',
  'aria-disabled:opacity-50 aria-disabled:pointer-events-none',
);

/** One canonical class string per variant — the single source of the look. */
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  // Amber CTA. Foreground is the page background token (was written as
  // `text-[#000]` / `text-[var(--color-bg)]` inconsistently before).
  primary: 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:brightness-110',
  // Filled elevated — the default, most-common action.
  secondary:
    'border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg)] hover:border-[var(--color-content-tertiary)] hover:text-[var(--color-content-primary)]',
  // Bordered, no fill at rest.
  outline:
    'border border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
  // Transparent, hover-fill only.
  ghost:
    'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
  // Destructive, high emphasis — the prominent confirm CTA (mirrors `primary`).
  danger: 'bg-[var(--color-error)] text-[var(--color-bg)] hover:brightness-110',
  // Destructive, low emphasis — inline "revoke" / "leave" actions. Bordered at
  // rest, fills to solid error on hover. Together these two replace the three
  // ad-hoc danger treatments the codebase had.
  'danger-outline':
    'border border-[var(--color-error)] text-[var(--color-error)] hover:bg-[var(--color-error)] hover:text-[var(--color-bg)]',
};

/**
 * Sizing per size, both the text and icon-only forms in one record so adding a
 * size is a single type-checked edit. `text` is a min-height + horizontal
 * padding + text size; `icon` is a square. The scale is tuned to this
 * dashboard's compact input density: `md` (36px) is the default inline action;
 * `lg` (40px) is for full-width / hero CTAs (login, a full-width primary),
 * NOT inline form footers; `sm` (32px) is for dense list-row actions. Every
 * size clears the WCAG 2.2 minimum target of 24px comfortably — a full-width
 * `lg` clears the 44px enhanced target on width regardless of its height.
 */
const SIZE_STYLES: Record<ButtonSize, { text: string; icon: string }> = {
  sm: { text: 'min-h-8 px-3 text-xs', icon: 'size-8' },
  md: { text: 'min-h-9 px-3.5 text-sm', icon: 'size-9' },
  lg: { text: 'min-h-10 px-4 text-sm', icon: 'size-10' },
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon-only → square sizing instead of horizontal padding. */
  iconOnly?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
}

/**
 * Resolve the full class string for a button from its options. Pure: the same
 * options always yield the same string, so it is exhaustively unit-tested and
 * the component never has to reason about class order.
 */
export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  fullWidth = false,
}: ButtonClassOptions = {}): string {
  return cn(
    BASE,
    VARIANT_STYLES[variant],
    iconOnly ? cn(SIZE_STYLES[size].icon, 'shrink-0') : SIZE_STYLES[size].text,
    fullWidth && 'w-full',
  );
}
