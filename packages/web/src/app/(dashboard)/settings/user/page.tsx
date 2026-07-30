import type { Metadata } from 'next';
import { KeyRound, UserCircle } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { UserSettingsPanel } from '@/components/settings/UserSettingsPanel';
import { PasswordPanel } from '@/components/settings/PasswordPanel';

export const metadata: Metadata = { title: 'User — Settings' };

export default async function UserSettingsPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <div className="flex flex-col gap-6">
      <SectionPanel
        icon={<UserCircle className="size-4.5" />}
        title="User"
        subtitle="Your account info and danger-zone actions."
      >
        <UserSettingsPanel user={user} />
      </SectionPanel>

      <SectionPanel
        icon={<KeyRound className="size-4.5" />}
        title="Password"
        subtitle="Sign in with your email address and a password."
      >
        <PasswordPanel />
      </SectionPanel>
    </div>
  );
}