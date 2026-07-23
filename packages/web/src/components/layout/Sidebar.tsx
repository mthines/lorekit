'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { BookOpen, Activity, LayoutDashboard } from 'lucide-react';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/lore', label: 'Lore Explorer', icon: BookOpen },
  { href: '/activity', label: 'Activity', icon: Activity },
] as const;

interface SidebarProps {
  user: User;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();

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

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Main navigation">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
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
                {label}
              </Link>
            );
          })}
        </nav>

        {/* User */}
        <div className="border-t border-[var(--color-border)] p-2">
          <div className="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm text-[var(--color-content-secondary)]">
            {/* Avatar */}
            <div className="size-5 shrink-0 overflow-hidden rounded-full bg-[var(--color-border)]">
              {user.user_metadata?.['avatar_url'] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.user_metadata['avatar_url'] as string}
                  alt={user.user_metadata?.['full_name'] as string ?? 'User'}
                  className="size-full object-cover"
                />
              )}
            </div>
            <span className="min-w-0 flex-1 truncate">
              {(user.user_metadata?.['full_name'] as string) ?? user.email}
            </span>
          </div>
        </div>
      </aside>

      {/* ── Mobile bottom tab bar (<md) ──────────────────────────────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-border)] bg-[var(--color-bg-raised)] md:hidden"
        aria-label="Main navigation"
      >
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              /* 44px minimum touch target — explicit min-h */
              className={[
                'flex flex-1 min-h-[3.5rem] flex-col items-center justify-center gap-1 text-xs transition-all duration-150',
                active
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
              ].join(' ')}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
