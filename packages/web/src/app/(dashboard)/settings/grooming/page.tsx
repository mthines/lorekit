import type { Metadata } from 'next';
import { Archive } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { GroomingRuleBuilder } from '@/components/settings/GroomingRuleBuilder';

export const metadata: Metadata = { title: 'Grooming — Settings' };

export default function GroomingSettingsPage() {
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
