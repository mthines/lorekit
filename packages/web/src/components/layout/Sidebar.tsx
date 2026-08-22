'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { BookOpen, LayoutDashboard, Settings, GraduationCap } from 'lucide-react';
import { CommandPaletteFab } from '@/components/command/CommandPaletteFab';
import { useOnboarding } from '@/components/providers/OnboardingProvider';
import { SETTINGS_LANDING_HREF, isSettingsPath } from '@/lib/settings-routes';

// Primary content nav — 3 destinations keeps the sidebar scannable and the
// mobile tab bar comfortably within the 3–5 item guideline.
// `mobileLabel` is shorter than `label` where the sidebar's 224px rail affords
// copy the tab bar's column does not: the bar now carries FOUR tabs plus the
// docked command FAB, so a column is ~1/5 of the viewport (66px on a 330px
// phone) and "Getting started" would wrap or clip there.
const NAV = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/lore', label: 'Explorer', icon: BookOpen },
  { href: '/docs', label: 'Getting started', mobileLabel: 'Setup', icon: GraduationCap },
] as const;

// Settings is a persistent utility destination kept in the sidebar footer —
// separate from the primary content nav so it does not compete for attention.
// `href` points straight at the first section rather than at `/settings`: the
// root only exists as a redirect, and taking that hop client-side crashed React
// inside Next's app-router (see `@/lib/settings-routes`). `isActive` therefore
// can't be derived from `href` — it matches the whole Settings area instead.
const SETTINGS = {
  href: SETTINGS_LANDING_HREF,
  label: 'Settings',
  icon: Settings,
  isActive: isSettingsPath,
} as const;

interface SidebarProps {
  user: User;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();
  const { allDone, hydrated } = useOnboarding();
  const isSettingsActive = SETTINGS.isActive(pathname);
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
      {/*
        Five columns: two destinations, the docked command FAB, two more
        destinations. The FAB gets a column of its own rather than floating over
        the row so the four tabs keep even, predictable hit areas — nothing
        shifts under the disc, and there is no tab hiding behind it.

        `pb-[env(safe-area-inset-bottom)]` keeps the labels clear of the home
        indicator on a notched phone; the dashboard layout's `main` reserves the
        matching amount of scroll padding.
      */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main navigation"
      >
        {MOBILE_TABS_BEFORE_FAB.map((item) => (
          <MobileTab
            key={item.href}
            item={item}
            pathname={pathname}
            showProgress={showProgress}
          />
        ))}

        {/*
          The FAB's column. `relative` makes it the FAB's containing block, so
          the disc is centred on the bar's own midline and lifted from its top
          border — see CommandPaletteFab for the offset.
        */}
        <div className="relative min-h-[3.5rem] flex-1">
          <CommandPaletteFab />
        </div>

        {MOBILE_TABS_AFTER_FAB.map((item) => (
          <MobileTab
            key={item.href}
            item={item}
            pathname={pathname}
            showProgress={showProgress}
          />
        ))}
      </nav>
    </>
  );
}

// ── Mobile tab ────────────────────────────────────────────────────────────────

// The FAB sits between the second and third destination, so the row is split
// here rather than at render time — the split point is layout, not state.
const MOBILE_TABS = [...NAV, SETTINGS] as const;
const MOBILE_TABS_BEFORE_FAB = MOBILE_TABS.slice(0, 2);
const MOBILE_TABS_AFTER_FAB = MOBILE_TABS.slice(2);

type MobileTabItem = (typeof MOBILE_TABS)[number];

interface MobileTabProps {
  item: MobileTabItem;
  pathname: string;
  showProgress: boolean;
}

function MobileTab({ item, pathname, showProgress }: MobileTabProps) {
  const { href, icon: Icon } = item;
  const label = 'mobileLabel' in item ? item.mobileLabel : item.label;
  const active =
    'isActive' in item
      ? item.isActive(pathname)
      : pathname === href || pathname.startsWith(href + '/');
  const withProgressDot = href === '/docs' && showProgress;

  return (
    <Link
      href={href}
      prefetch={true}
      className={[
        // `text-[11px]` + `truncate`: a fifth column leaves ~66px on a 330px
        // phone, and a wrapped label would push the row taller than the tabs
        // beside it.
        'relative flex min-h-[3.5rem] flex-1 flex-col items-center justify-center gap-1 px-0.5 text-[11px] transition-colors duration-150',
        // Inactive tabs are `content-secondary`, matching the desktop rail
        // above — NOT `content-tertiary`, which lands at 2.5:1 on the raised
        // surface (below both the 4.5:1 AA floor for the label and the 3:1 floor
        // for the icon) and is what made these labels read as disabled. At
        // `content-secondary` they measure 5.9:1.
        active
          ? 'text-[var(--color-accent)]'
          : 'text-[var(--color-content-secondary)] hover:text-[var(--color-content-primary)]',
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
      <span className="max-w-full truncate">{label}</span>
      {withProgressDot && <span className="sr-only">, setup not yet complete</span>}
    </Link>
  );
}