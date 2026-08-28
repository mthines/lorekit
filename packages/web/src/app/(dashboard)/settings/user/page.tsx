import type { Metadata } from 'next';
import { KeyRound, UserCircle } from 'lucide-react';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { UserSettingsPanel } from '@/components/settings/UserSettingsPanel';
import { PasswordPanel } from '@/components/settings/PasswordPanel';

export const metadata: Metadata = { title: 'User — Settings' };

export default async function UserSettingsPage() {
  const user = await getVerifiedUser();

  if (!user) return null;

  return (
    <div className="flex flex-col gap-6">
      <SectionPanel
        anchorId="account"
        icon={<UserCircle className="size-4.5" />}
        title="User"
        subtitle="Your account info and danger-zone actions."
      >
        <UserSettingsPanel user={user} />
      </SectionPanel>

      {/*
        Collapsed by default: setting a password is an occasional, deliberate
        task, not something the user needs to read on the way to their account
        details. The header stays visible so the option is still discoverable
        in one glance and one click — quiet, not buried.
      */}
      <SectionPanel
        collapsible
        anchorId="password"
        icon={<KeyRound className="size-4.5" />}
        title="Password"
        subtitle="Add or change a password so you can sign in with just your email address."
      >
        <PasswordPanel />
      </SectionPanel>
    </div>
  );
}