import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Archive } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { GroomingRuleBuilder } from '@/components/settings/GroomingRuleBuilder';
import { retentionPoliciesEnabled } from '@/lib/retention-policies-flag';

export const metadata: Metadata = { title: 'Grooming — Settings' };

export default function GroomingSettingsPage() {
  // Behind the retention-policies feature flag — see `lib/feature-flags.ts`.
  // The nav entry is already hidden (`settings/sections.ts`); this also
  // closes off direct navigation to the URL while the flag is off.
  if (!retentionPoliciesEnabled()) notFound();

  return (
    <SectionPanel
      icon={<Archive className="size-4.5" />}
      title="Grooming"
      subtitle="Retention policies that automatically archive stale lore — reviewed by hand or swept nightly. Never a hard delete."
    >
      <GroomingRuleBuilder />
    </SectionPanel>
  );
}
