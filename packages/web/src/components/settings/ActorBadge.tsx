/**
 * Presentational avatar + name badge for the audit-log actor cell.
 *
 * Mirrors the Sidebar avatar idiom (components/layout/Sidebar.tsx, the "User"
 * block) — `size-N shrink-0 overflow-hidden rounded-full` wrapper, `object-cover`
 * image, and the `full_name ?? email` name text — but colocated here since
 * `AuditLogFeed` is its only consumer today (a future second consumer, e.g.
 * Sidebar itself, is a candidate to promote this into `components/ui/`).
 *
 * Dispatches on `actor.kind`: a `system` actor renders a generic non-person
 * icon (never a fabricated avatar), matching the illegal-state-unrepresentable
 * shape of `AuditActor`.
 */

import { User as UserIcon } from 'lucide-react';
import type { AuditActor } from '@/lib/audit-actor';

export function ActorBadge({ actor }: { actor: AuditActor }) {
  return (
    // The name text visually collapses below `sm` (avatar-only on mobile),
    // but `aria-label` here is a permanent DOM attribute independent of that
    // CSS breakpoint — screen-reader users get the actor's name at every
    // viewport width, not just where the text happens to render. This
    // mirrors the timestamp span's `aria-label` a few lines below, which
    // decouples the same visual/accessible-name concern. The visible name
    // span is `aria-hidden` so it isn't announced twice.
    <div className="flex min-w-0 shrink-0 items-center gap-1.5" aria-label={actor.name} title={actor.name}>
      <div className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]">
        {actor.kind === 'system' ? (
          // Neutral, non-person icon — never a fabricated avatar for an
          // unattributable row.
          <UserIcon className="size-3" aria-hidden />
        ) : actor.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={actor.avatarUrl} alt="" className="size-full object-cover" aria-hidden />
        ) : (
          <UserIcon className="size-3" aria-hidden />
        )}
      </div>
      {/* Name collapses below the sm breakpoint — the avatar alone stays
          legible in the row's narrow mobile layout. Decorative only past
          this point: the accessible name lives on the parent aria-label. */}
      <span
        aria-hidden
        className="hidden max-w-24 truncate text-xs text-[var(--color-content-tertiary)] sm:inline"
      >
        {actor.name}
      </span>
    </div>
  );
}
