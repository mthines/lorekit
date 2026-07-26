import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { AuditLogFeed } from '@/components/settings/AuditLogFeed';
import AuditLogLoading from './loading';

export const metadata: Metadata = { title: 'Audit Logs — Settings' };

export default function AuditLogSettingsPage() {
  return (
    <SectionPanel
      icon={<ShieldCheck className="size-4.5" />}
      title="Audit Logs"
      subtitle="An append-only record of security-affecting actions on your account — API keys, webhooks, memory changes, and limit overrides."
    >
      {/* AuditLogFeed reads URL search params (useUrlState/useDebouncedUrlState),
          which requires a Suspense boundary per the useUrlState SSR contract —
          Next.js renders a server shell and fills in the client value after
          hydration, avoiding a mismatch. */}
      <Suspense fallback={<AuditLogLoading />}>
        <AuditLogFeed />
      </Suspense>
    </SectionPanel>
  );
}
