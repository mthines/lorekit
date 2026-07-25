/**
 * ScopeBadge — the one component for rendering a scope.
 *
 * Every surface that shows a scope (activity rows, lesson cards, the detail
 * sheet header, scope-health cards) renders it through here so the pill colour,
 * icon, and canonical-path treatment stay identical. Props toggle the parts on
 * or off for the surrounding context — a compact pill in a list, a pill + full
 * path in a header, or just the dimmed path in a footer.
 *
 * This is a pure presentational component (no hooks / no client state) so it
 * works in both server and client components.
 */

import { Badge } from '@/components/ui/Badge';
import { scopeIcon, scopeType, type ScopePrefix } from './scope-meta';

export interface ScopeBadgeProps {
  /** Canonical scope string, e.g. `project::lorekit` or `global`. */
  scope: string;
  /** Override the derived scope type (when the caller already computed it). */
  type?: ScopePrefix;
  /** Render the coloured type pill. @default true */
  showBadge?: boolean;
  /** Show the scope-type icon inside the pill. @default true */
  showIcon?: boolean;
  /** Show the type label ("project") inside the pill. @default true */
  showType?: boolean;
  /** Append the full canonical scope string after the pill. @default false */
  showPath?: boolean;
  /** Class applied to the wrapper. */
  className?: string;
  /** Class applied to the canonical-path `<code>` (e.g. margins, colour). */
  pathClassName?: string;
}

export function ScopeBadge({
  scope,
  type,
  showBadge = true,
  showIcon = true,
  showType = true,
  showPath = false,
  className = '',
  pathClassName = '',
}: ScopeBadgeProps) {
  const resolvedType = type ?? scopeType(scope);
  const Icon = scopeIcon(resolvedType);

  return (
    <span className={['inline-flex min-w-0 items-center gap-1.5', className].join(' ')}>
      {showBadge && (
        <Badge variant={resolvedType}>
          {showIcon && (
            <Icon className={['size-2.5', showType ? 'mr-1' : '', 'inline shrink-0'].join(' ')} aria-hidden />
          )}
          {showType && resolvedType}
        </Badge>
      )}
      {showPath && (
        <code
          className={[
            'min-w-0 truncate font-mono text-xs text-[var(--color-content-tertiary)]',
            pathClassName,
          ].join(' ')}
        >
          {scope}
        </code>
      )}
    </span>
  );
}
