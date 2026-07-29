import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { listMyOrgs } from '@/lib/orgs';
import { OrganizationManager } from '@/components/dashboard/OrganizationManager';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Organization — Settings' };

// Fallback for the Suspense boundary the manager needs (it reads the `?org=`
// search param via useUrlState). Mirrors the shape of the org list so the
// layout doesn't jump once the client value hydrates.
function OrganizationLoading() {
  return (
    <div role="status" aria-label="Loading organizations" className="flex flex-col gap-2">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-[62px] animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
        />
      ))}
    </div>
  );
}

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
      {/* OrganizationManager reads the `?org=` search param (useUrlState) to drive
          its deep-linkable master/detail view, which requires a Suspense boundary
          per the useUrlState SSR contract. */}
      <Suspense fallback={<OrganizationLoading />}>
        <OrganizationManager initialOrgs={orgs} currentUserId={user?.id ?? ''} />
      </Suspense>
    </SectionPanel>
  );
}
