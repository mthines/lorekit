'use client';

import Image from 'next/image';
import type { User } from '@supabase/supabase-js';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { MemoryExpandButton } from '@/components/lore/MemoryExpandButton';

interface TopBarProps {
  user: User;
}

export function TopBar({ user: _ }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-raised)] px-6">
      {/* Left — logo on mobile only (desktop shows brand in sidebar) */}
      <div className="flex items-center gap-2 md:hidden">
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
        {/* Memory expand button: always visible, opens the global lesson sidebar */}
        <MemoryExpandButton />
        <SignOutButton />
      </div>
    </header>
  );
}
