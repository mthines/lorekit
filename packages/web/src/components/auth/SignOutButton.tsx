'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { LogOut } from 'lucide-react';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      disabled={loading}
      aria-label="Sign out"
      title="Sign out"
      className="flex size-11 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)] disabled:opacity-50"
    >
      <LogOut className="size-4" aria-hidden />
    </button>
  );
}
