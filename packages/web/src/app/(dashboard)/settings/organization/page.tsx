import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { listMyOrgs } from '@/lib/orgs';
import { listPendingInvitesForMe } from '@/lib/org-invites';
import { MyPendingInvites } from '@/components/dashboard/MyPendingInvites';
import { OrganizationManager } from '@/components/dashboard/OrganizationManager';
import { OrgListSkeleton } from '@/components/dashboard/OrganizationSkeleton';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Organization — Settings' };

export default async function OrganizationSettingsPage() {
  const [user, orgs, pendingInvites] = await Promise.all([
    getVerifiedUser(),
    listMyOrgs(),
    listPendingInvitesForMe(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      {/* Invites addressed to YOU — self-hides when there are none, so an
          established account sees only the Organization panel below. */}
      <MyPendingInvites initialInvites={pendingInvites} />

      <SectionPanel
        icon={<Users className="size-4.5" />}
        title="Organization"
        subtitle="Share lore with teammates. Everyone in an org reads the same memories."
      >
        {/* OrganizationManager reads the `?org=` search param (useUrlState) to drive
            its deep-linkable master/detail view, which requires a Suspense boundary
            per the useUrlState SSR contract. The fallback mirrors the org list's row
            shape so the layout doesn't jump once the client value hydrates. */}
        <Suspense fallback={<OrgListSkeleton />}>
          <OrganizationManager initialOrgs={orgs} currentUserId={user?.id ?? ''} />
        </Suspense>
      </SectionPanel>
    </div>
  );
}
