import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { AuditLogFeed } from '@/components/settings/AuditLogFeed';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { resolveAuditActor } from '@/lib/audit-actor';
import AuditLogLoading from './loading';

export const metadata: Metadata = { title: 'Audit Logs — Settings' };

export default async function AuditLogSettingsPage() {
  // The dashboard layout already redirects unauthenticated visitors, so
  // `user` is non-null here in practice; `resolveAuditActor` still handles
  // `null` defensively. RLS (`user_id = auth.uid()`) guarantees every audit
  // row a viewer can see belongs to them, so this ONE session-derived actor
  // applies to every row — no per-row identity, no user_id sent to the
  // client, no new query.
  const user = await getVerifiedUser();
  const actor = resolveAuditActor(user);

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
        <AuditLogFeed actor={actor} />
      </Suspense>
    </SectionPanel>
  );
}
