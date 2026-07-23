import type { User } from '@supabase/supabase-js';
import { SignOutButton } from '@/components/auth/SignOutButton';

interface TopBarProps {
  user: User;
}

export function TopBar({ user: _ }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-raised)] px-6">
      {/* Left — breadcrumb slot (populated per-page via React context in future PRs) */}
      <div className="flex items-center gap-2" aria-label="Breadcrumb">
        <span className="text-sm text-[var(--color-content-tertiary)]">LoreKit</span>
      </div>

      {/* Right — actions */}
      <div className="flex items-center gap-2">
        <SignOutButton />
      </div>
    </header>
  );
}
