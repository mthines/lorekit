'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { User } from '@supabase/supabase-js';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { MemoryExpandButton } from '@/components/lore/MemoryExpandButton';
import { CommandPaletteButton } from '@/components/command/CommandPaletteButton';
import { ActivityIndicator } from '@/components/layout/ActivityIndicator';

interface TopBarProps {
  user: User;
}

export function TopBar({ user: _ }: TopBarProps) {
  return (
    // `relative` so the ActivityIndicator can sit on the bottom border without
    // taking a row of its own — nothing below the header moves when it appears.
    <header className="relative flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-raised)] px-6">
      {/* Left — logo on mobile (desktop shows brand in sidebar) */}
      <div
        className="flex items-center gap-2 md:opacity-0"
        aria-label="LoreKit"
      >
        <Image
          src="/icons/icon-192.png"
          alt="LoreKit"
          width={28}
          height={28}
          className="shrink-0 rounded-lg"
          priority
        />
      </div>

      {/* Right — actions */}
      <div className="flex items-center gap-3">
        {/* Docs — desktop only, where there's room (mirrors the login header) */}
        <Link
          href="/docs"
          className="hidden items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] md:inline-flex"
        >
          Docs
        </Link>
        {/*
          Command palette trigger — opens with ⌘K or clicking this button.
          Desktop only: the label IS a keyboard shortcut, which is dead copy on
          a touch device, and on mobile the palette is reached from the tab
          bar's docked FAB instead (Sidebar → CommandPaletteFab), where it is
          both bigger and thumb-reachable. Mirrors the docs/blog headers, which
          hide the same chip below `sm`.
        */}
        <span className="hidden md:inline-flex">
          <CommandPaletteButton />
        </span>
        {/* Memory expand button: always visible, opens the global lesson sidebar */}
        <MemoryExpandButton />
        <SignOutButton />
      </div>

      {/* Background fetches and mutations — a sweep along the bottom border. */}
      <ActivityIndicator />
    </header>
  );
}
