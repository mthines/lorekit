/**
 * OwnershipBadge — the ONE component for rendering a memory's ownership
 * (personal vs org-owned). Ownership is orthogonal to scope type, so this is
 * a deliberately separate component rendered BESIDE `ScopeBadge`, never
 * folded into it (plan.md Decision D3 / ux-design §4).
 *
 * Personal (no org) renders nothing — avoids list noise for the common case.
 * Org-owned renders a subtle pill: a `Users` icon + the org name.
 *
 * Pure/presentational, like `ScopeBadge` — no hooks, works in server or
 * client components.
 */

import { Users } from 'lucide-react';

export interface OwnershipBadgeProps {
  org?: { id: string; name: string } | null;
  className?: string;
}

export function OwnershipBadge({ org, className = '' }: OwnershipBadgeProps) {
  if (!org) return null;

  return (
    <span
      className={[
        'inline-flex min-w-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-xs text-[var(--color-content-secondary)]',
        className,
      ].join(' ')}
    >
      <Users className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{org.name}</span>
    </span>
  );
}
