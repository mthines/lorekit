import type { Metadata } from 'next';
import { PlayCircle } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { RunsList } from '@/components/settings/RunsList';

export const metadata: Metadata = { title: 'Runs — Settings' };

export default function RunsSettingsPage() {
  return (
    <SectionPanel
      icon={<PlayCircle className="size-4.5" />}
      title="Runs"
      subtitle="Local sessions, CI jobs, and PR automations that have touched your lore — the payoff view for GET /memories/usage?correlation_id=."
    >
      <RunsList />
    </SectionPanel>
  );
}
