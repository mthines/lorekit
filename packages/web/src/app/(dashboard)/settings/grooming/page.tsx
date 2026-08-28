import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Archive } from 'lucide-react';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { GroomingRuleBuilder } from '@/components/settings/GroomingRuleBuilder';
import { getServerFlag } from '@/lib/feature-flags/server';

export const metadata: Metadata = { title: 'Grooming — Settings' };

/**
 * Behind the `retention-policies` feature flag (default `off`). This
 * `notFound()` check is the real access-control boundary — the nav entry
 * being hidden (`SettingsNav.tsx`, reading the same flag) is only a
 * visibility nicety, and a direct `/settings/grooming` visit must not bypass
 * it. Same posture as `/insights`'s gate — see `docs/feature-flags.md` §
 * "Access in production".
 */
export default async function GroomingSettingsPage() {
  const enabled = await getServerFlag('retention-policies');
  if (!enabled) notFound();

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
