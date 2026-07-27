import type { Metadata } from 'next';
import { UserCircle } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { UserSettingsPanel } from '@/components/settings/UserSettingsPanel';

export const metadata: Metadata = { title: 'User — Settings' };

export default async function UserSettingsPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  return (
    <SectionPanel
      icon={<UserCircle className="size-4.5" />}
      title="User"
      subtitle="Your account info and danger-zone actions."
    >
      <UserSettingsPanel user={user} />
    </SectionPanel>
  );
}