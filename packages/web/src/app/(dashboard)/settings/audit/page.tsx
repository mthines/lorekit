import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { listAuditLog } from '@/lib/audit-log';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { AuditLogFeed } from '@/components/settings/AuditLogFeed';

export const metadata: Metadata = { title: 'Audit Logs — Settings' };

const AUDIT_LOG_FETCH_LIMIT = 200;

export default async function AuditLogSettingsPage() {
  // Read-only, RLS-scoped: every row already belongs to the signed-in user.
  const events = await listAuditLog({ limit: AUDIT_LOG_FETCH_LIMIT });

  return (
    <SectionPanel
      icon={<ShieldCheck className="size-4.5" />}
      title="Audit Logs"
      subtitle="An append-only record of security-affecting actions on your account — API keys, webhooks, memory changes, and limit overrides."
    >
      <AuditLogFeed events={events} />
    </SectionPanel>
  );
}
