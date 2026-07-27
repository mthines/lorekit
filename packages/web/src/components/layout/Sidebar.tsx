'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { BookOpen, LayoutDashboard, Settings, GraduationCap } from 'lucide-react';
import { useOnboarding } from '@/components/providers/OnboardingProvider';

// Primary content nav — 3 destinations keeps the sidebar scannable and the
// mobile tab bar comfortably within the 3–5 item guideline.
const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/lore', label: 'Explorer', icon: BookOpen },
  { href: '/learn', label: 'Getting started', mobileLabel: 'Getting started', icon: GraduationCap },
] as const;

// Settings is a persistent utility destination kept in the sidebar footer —
// separate from the primary content nav so it does not compete for attention.
const SETTINGS = { href: '/settings', label: 'Settings', icon: Settings } as const;

interface SidebarProps {
  user: User;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const { allDone, hydrated } = useOnboarding();
  const isSettingsActive =
    pathname === SETTINGS.href || pathname.startsWith(SETTINGS.href + '/');
  const showProgress = hydrated && !allDone;
  const isUserActive = pathname === '/settings/user';

  const displayName = (user.user_metadata?.['full_name'] as string) ?? user.email ?? 'User';
  const avatarUrl = user.user_metadata?.['avatar_url'] as string | undefined;

  return (
    <>
      {/* ── Desktop sidebar (md+) ────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-raised)]">
        {/* Brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <Image
            src="/icons/icon-192.png"
            alt="LoreKit"
            width={28}
            height={28}
            className="shrink-0 rounded-lg"
            priority
          />
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
                  'flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm transition-all duration-150',
                  active
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] font-medium'
                    : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
                ].join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Settings */}
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

        {/* User — links to /settings/user on both desktop and mobile */}
        <div className="border-t border-[var(--color-border)] p-2">
          <Link
            href="/settings/user"
            prefetch={true}
            className={[
              'flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm transition-all duration-150',
              isUserActive
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] font-medium'
                : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
            ].join(' ')}
            aria-current={isUserActive ? 'page' : undefined}
            aria-label={`User settings for ${displayName}`}
          >
            <div className="size-5 shrink-0 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-border)]">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" aria-hidden className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-[8px] font-bold">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
          </Link>
        </div>
      </aside>

      {/* ── Mobile bottom tab bar (<md) ──────────────────────────────────── */}
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
                <span className="sr-only">, setup not yet complete</span>
              )}
            </Link>
          );
        })}
      </nav>
    </>
  );
}