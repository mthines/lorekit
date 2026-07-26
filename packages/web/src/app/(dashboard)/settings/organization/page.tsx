import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { listMyOrgs } from '@/lib/orgs';
import { OrganizationManager } from '@/components/dashboard/OrganizationManager';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Organization — Settings' };

export default async function OrganizationSettingsPage() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const orgs = await listMyOrgs();

  return (
    <SectionPanel
      icon={<Users className="size-4.5" />}
      title="Organization"
      subtitle="Share lore with teammates. Everyone in an org reads the same memories."
    >
      <OrganizationManager initialOrgs={orgs} currentUserId={user?.id ?? ''} />
    </SectionPanel>
  );
}
