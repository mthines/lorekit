'use client';

/**
 * Button + IconButton — the one shared button primitive for the dashboard.
 *
 * Semantics by `href` (not a React ref — refs stay orthogonal to element type):
 *   - no `href`            → a real `<button>` (type defaults to "button").
 *   - `href="/…"` / `#…`   → Next.js `<Link>` (client navigation).
 *   - `href="https://…"`   → `<a target="_blank" rel="noreferrer">` (leaves the app).
 * The prop types are a discriminated union, so a link gets anchor attributes and
 * a button gets button attributes — passing `type` to a link is a type error.
 *
 * `IconButton` is icon-only. Its `label` is REQUIRED — it becomes the
 * `aria-label` (an icon has no text) AND the default tooltip content, so an
 * icon-only control can never ship without an accessible name. That is the whole
 * reason it is a separate component: the requirement is compile-enforced.
 *
 * Visuals live in the pure `lib/button-styles.ts`; this file is behaviour only.
 */

import Link from 'next/link';
import { forwardRef } from 'react';
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  MouseEventHandler,
  ReactNode,
  Ref,
} from 'react';
import { Loader2 } from 'lucide-react';

import { buttonClasses, type ButtonSize, type ButtonVariant } from '@/lib/button-styles';
import { cn } from '@/lib/cn';

import { Tooltip } from './Tooltip';

/** A link is internal when it stays inside the app (path or in-page anchor). */
function isInternalHref(href: string): boolean {
  return href.startsWith('/') || href.startsWith('#');
}

/** Shared visual props for both Button and IconButton. */
interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner, mark `aria-busy`, and disable interaction. */
  isLoading?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  className?: string;
}

/** Spinner size tracks the button size so it never dwarfs small buttons. */
function spinnerClass(size: ButtonSize | undefined): string {
  return cn(size === 'sm' ? 'size-3.5' : 'size-4', 'shrink-0 animate-spin');
}

// ── BaseButton — the polymorphic element, shared by both public components ────

/**
 * BaseButton is INTERNAL, so its props are deliberately loose — a flat merge of
 * button + anchor attributes rather than a discriminated union. The public
 * `Button` / `IconButton` unions already forbid mixing link and button
 * attributes at the call site; a union here would only fight the spread (a
 * spread of a union widens the `href` discriminant and loses the narrowing).
 */
type BaseButtonProps = {
  href?: string;
  isLoading?: boolean;
  className: string;
  children: ReactNode;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement> & AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'className' | 'children'
>;

/** The native attributes the public components forward, minus the ones they set. */
type ForwardedNativeProps = Omit<BaseButtonProps, 'className' | 'children' | 'isLoading'>;

const BaseButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, BaseButtonProps>(
  function BaseButton({ href, isLoading, className, children, ...rest }, ref) {
    // Action button — has a native `disabled`, so loading folds into it.
    if (href === undefined) {
      const { disabled, type, ...buttonRest } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
      return (
        <button
          ref={ref as Ref<HTMLButtonElement>}
          type={type ?? 'button'}
          disabled={disabled || isLoading}
          aria-busy={isLoading || undefined}
          className={className}
          {...buttonRest}
        >
          {children}
        </button>
      );
    }

    // Link — no native `disabled`, so a loading/disabled link is marked
    // `aria-disabled`, dropped from the tab order, and its click is suppressed.
    const {
      onClick,
      tabIndex,
      'aria-disabled': ariaDisabled,
      ...anchorRest
    } = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
    const disabled = Boolean(isLoading) || ariaDisabled === true || ariaDisabled === 'true';
    const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    };
    const shared = {
      className,
      'aria-busy': isLoading || undefined,
      'aria-disabled': disabled || undefined,
      tabIndex: disabled ? -1 : tabIndex,
      onClick: handleClick,
    };

    if (isInternalHref(href)) {
      return (
        <Link ref={ref as Ref<HTMLAnchorElement>} href={href} {...shared} {...anchorRest}>
          {children}
        </Link>
      );
    }
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        target="_blank"
        rel="noreferrer"
        {...shared}
        {...anchorRest}
      >
        {children}
      </a>
    );
  },
);

// ── Button — text (optionally with a leading/trailing icon) ───────────────────

interface ButtonOwnProps extends StyleProps {
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  children: ReactNode;
}

type ButtonAsButton = ButtonOwnProps & {
  href?: undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps>;

type ButtonAsLink = ButtonOwnProps & {
  href: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonOwnProps | 'href'>;

export type ButtonProps = ButtonAsButton | ButtonAsLink;

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(
  function Button(
    { variant, size, isLoading, fullWidth, className, leftIcon, rightIcon, children, ...rest },
    ref,
  ) {
    const classes = cn(buttonClasses({ variant, size, fullWidth }), className);
    return (
      <BaseButton
        ref={ref}
        isLoading={isLoading}
        className={classes}
        {...(rest as ForwardedNativeProps)}
      >
        {/* The spinner replaces the leading icon while loading. */}
        {isLoading ? <Loader2 aria-hidden className={spinnerClass(size)} /> : leftIcon}
        {children}
        {!isLoading && rightIcon}
      </BaseButton>
    );
  },
);

// ── IconButton — icon-only, always labelled and tooltipped ────────────────────

interface IconButtonOwnProps extends StyleProps {
  icon: ReactNode;
  /** Accessible name — becomes `aria-label` and the default tooltip text. */
  label: string;
  /** Override the tooltip text (defaults to `label`). */
  tooltip?: string;
  tooltipSide?: 'top' | 'bottom';
  tooltipAlign?: 'left' | 'center' | 'right';
}

type IconButtonAsButton = IconButtonOwnProps & {
  href?: undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof IconButtonOwnProps>;

type IconButtonAsLink = IconButtonOwnProps & {
  href: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof IconButtonOwnProps | 'href'>;

export type IconButtonProps = IconButtonAsButton | IconButtonAsLink;

export const IconButton = forwardRef<HTMLButtonElement | HTMLAnchorElement, IconButtonProps>(
  function IconButton(
    {
      variant,
      size,
      isLoading,
      fullWidth,
      className,
      icon,
      label,
      tooltip,
      tooltipSide,
      tooltipAlign,
      ...rest
    },
    ref,
  ) {
    const classes = cn(buttonClasses({ variant, size, iconOnly: true, fullWidth }), className);
    return (
      <Tooltip content={tooltip ?? label} side={tooltipSide} align={tooltipAlign}>
        <BaseButton
          ref={ref}
          isLoading={isLoading}
          aria-label={label}
          className={classes}
          {...(rest as ForwardedNativeProps)}
        >
          {isLoading ? (
            <Loader2 aria-hidden className={spinnerClass(size)} />
          ) : (
            <span aria-hidden className="inline-flex">
              {icon}
            </span>
          )}
        </BaseButton>
      </Tooltip>
    );
  },
);
