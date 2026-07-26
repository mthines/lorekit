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

import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { scopeRepoUrl } from '@/lib/scope';
import { scopeIcon, scopeLabel, scopeType, type ScopePrefix } from './scope-meta';

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
  /**
   * Show the friendly scope label (last segment, e.g. `lorekit`) inside the pill
   * instead of the type. Identifies the specific scope; takes precedence over
   * `showType`. @default false
   */
  label?: boolean;
  /** Append the full canonical scope string after the pill. @default false */
  showPath?: boolean;
  /**
   * For `repo` / `branch` scopes, render a trailing GitHub link icon that opens
   * the repository (or branch tree) in a new tab. No-op for `global` / `project`
   * scopes, which have no repository to point at. @default false
   */
  linkRepo?: boolean;
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
  label = false,
  showPath = false,
  linkRepo = false,
  className = '',
  pathClassName = '',
}: ScopeBadgeProps) {
  const resolvedType = type ?? scopeType(scope);
  const Icon = scopeIcon(resolvedType);
  const pillText = label ? scopeLabel(scope) : showType ? resolvedType : null;
  const repoUrl = linkRepo ? scopeRepoUrl(scope) : null;

  return (
    <span className={['inline-flex min-w-0 items-center gap-1.5', className].join(' ')}>
      {showBadge && (
        <Badge variant={resolvedType}>
          {showIcon && (
            <Icon className={['size-2.5', pillText ? 'mr-1' : '', 'inline shrink-0'].filter(Boolean).join(' ')} aria-hidden />
          )}
          {pillText}
        </Badge>
      )}
      {showPath && repoUrl ? (
        /* When there is a repo link, the full path text is the link — the
           GitHub icon is decorative; the whole element is the affordance. */
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${scopeLabel(scope)} on GitHub`}
          className={[
            'inline-flex min-w-0 items-center gap-1 font-mono text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]',
            pathClassName,
          ].join(' ')}
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          <code className="min-w-0 truncate">{scope}</code>
        </a>
      ) : showPath ? (
        <code
          className={[
            'min-w-0 truncate font-mono text-xs text-[var(--color-content-tertiary)]',
            pathClassName,
          ].join(' ')}
        >
          {scope}
        </code>
      ) : repoUrl ? (
        /* showPath is off but linkRepo is on — icon-only link as before */
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${scopeLabel(scope)} on GitHub`}
          title="Open on GitHub"
          className="inline-flex shrink-0 items-center text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]"
        >
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : null}
    </span>
  );
}
