'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { LogOut } from 'lucide-react';

import { IconButton } from '@/components/ui/Button';

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
    <IconButton
      variant="ghost"
      size="lg"
      icon={<LogOut className="size-4" />}
      label="Sign out"
      disabled={loading}
      onClick={handleSignOut}
    />
  );
}
