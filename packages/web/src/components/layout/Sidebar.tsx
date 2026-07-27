'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { BookOpen, LayoutDashboard, Settings, GraduationCap } from 'lucide-react';
import { useOnboarding } from '@/components/providers/OnboardingProvider';
import { UserMenu } from '@/components/auth/UserMenu';

// Primary content nav — 3 destinations keeps the sidebar scannable and the
// mobile tab bar comfortably within the 3–5 item guideline.
// "Learn" unifies Getting started (setup checklist) and Tutorials (topic guides)
// under a single grouped secondary nav with a divider, matching the pattern in
// agent-skills where categories group related items in one view.
const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/lore', label: 'Explorer', icon: BookOpen },
  { href: '/learn', label: 'Learn', mobileLabel: 'Learn', icon: GraduationCap },
] as const;

// Settings is a persistent utility destination kept in the sidebar footer —
// separate from the primary content nav so it does not compete for attention.
const SETTINGS = { href: '/settings', label: 'Settings', icon: Settings } as const;

interface SidebarProps {
  user: User;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const { completedCount, total, allDone, hydrated } = useOnboarding();
  const isSettingsActive =
    pathname === SETTINGS.href || pathname.startsWith(SETTINGS.href + '/');
  // Only surface the count once localStorage is read, so the badge doesn't flash
  // a stale (server-only) number before manual completions hydrate.
  const showProgress = hydrated && !allDone;

  return (
    <>
      {/* ── Desktop sidebar (md+) ────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        {/* Brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <div className="flex size-7 items-center justify-center rounded-lg bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
            <span className="text-sm" aria-hidden>⚡</span>
          </div>
          <span className="text-sm font-semibold text-[var(--color-content-primary)]">
            LoreKit
          </span>
        </div>

        {/* Primary nav */}
        <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Main navigation">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            const isLearn = href === '/learn';
            return (
              <Link
                key={href}
                href={href}
                prefetch={true}
                className={[
                  /* Minimum 44px touch target height (WCAG 2.2 SC 2.5.8) */
                  'flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm transition-all duration-150',
                  active
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] font-medium'
                    : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
                ].join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1">{label}</span>
                {isLearn && showProgress && (
                  <span
                    className="rounded-md bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-content-tertiary)]"
                    aria-label={`${completedCount} of ${total} setup steps complete`}
                  >
                    {completedCount}/{total}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Settings — utility destination, pinned above the user row */}
        <div className="flex flex-col gap-0.5 p-2">
          <Link
            href={SETTINGS.href}
            prefetch={true}
            className={[
              'flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm transition-all duration-150',
              isSettingsActive
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] font-medium'
                : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
            ].join(' ')}
            aria-current={isSettingsActive ? 'page' : undefined}
          >
            <SETTINGS.icon className="size-4 shrink-0" aria-hidden />
            {SETTINGS.label}
          </Link>
        </div>

        {/* User — clickable avatar that opens the user menu (sign-out / delete account) */}
        <div className="border-t border-[var(--color-border)] p-2">
          <UserMenu user={user} />
        </div>
      </aside>

      {/* ── Mobile bottom tab bar (<md) ──────────────────────────────────── */}
      {/* NAV (3 items) + Settings = 4 tabs — comfortably within 3–5 guideline. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] md:hidden"
        aria-label="Main navigation"
      >
        {[...NAV, SETTINGS].map((item) => {
          const { href, icon: Icon } = item;
          const label = 'mobileLabel' in item ? item.mobileLabel : item.label;
          const active = pathname === href || pathname.startsWith(href + '/');
          const isLearn = href === '/learn';
          const withProgressDot = isLearn && showProgress;
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              /* 44px minimum touch target — explicit min-h */
              className={[
                'relative flex flex-1 min-h-[3.5rem] flex-col items-center justify-center gap-1 text-xs transition-all duration-150',
                active
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
              ].join(' ')}
              aria-current={active ? 'page' : undefined}
            >
              <span className="relative">
                <Icon className="size-5 shrink-0" aria-hidden />
                {withProgressDot && (
                  <span
                    className="absolute -right-1 -top-0.5 size-2 rounded-full bg-[var(--color-accent)]"
                    aria-hidden
                  />
                )}
              </span>
              <span>{label}</span>
              {withProgressDot && (
                <span className="sr-only">{`, ${completedCount} of ${total} setup steps complete`}</span>
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}