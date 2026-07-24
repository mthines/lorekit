'use client';

import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { SignOutButton } from '@/components/auth/SignOutButton';

interface TopBarProps {
  user: User;
}

/** Map route segments to human-readable page titles. */
const ROUTE_LABELS: Record<string, string> = {
  dashboard: 'Overview',
  lore: 'Lore Explorer',
  activity: 'Activity',
};

function useBreadcrumb(): string {
  const pathname = usePathname();
  // pathname is like /dashboard, /lore, /activity
  const segment = pathname.split('/').filter(Boolean)[0] ?? '';
  return ROUTE_LABELS[segment] ?? segment;
}

export function TopBar({ user }: TopBarProps) {
  const label = useBreadcrumb();
  const avatarUrl = user.user_metadata?.['avatar_url'] as string | undefined;
  const name = (user.user_metadata?.['full_name'] as string | undefined) ?? user.email ?? '';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 md:px-6">
      {/* Left — current page label */}
      <div className="flex items-center gap-2" aria-label="Current page">
        <span className="text-sm font-medium text-[var(--color-content-primary)]">{label}</span>
      </div>

      {/* Right — user identity + actions */}
      <div className="flex items-center gap-2">
        {/* User chip */}
        <div className="hidden items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 sm:flex">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={name}
              className="size-5 rounded-full object-cover"
            />
          ) : (
            <div className="size-5 rounded-full bg-[var(--color-border)]" aria-hidden />
          )}
          <span className="max-w-[140px] truncate text-xs text-[var(--color-content-secondary)]">
            {name}
          </span>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
