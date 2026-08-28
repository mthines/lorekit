import type { Metadata } from 'next';
import { CreditCard, ExternalLink } from 'lucide-react';
import { getPlanUsage } from '@/lib/plan';
import { PlanUsageBar } from '@/components/settings/PlanUsageBar';
import { PlanPeakUsage } from '@/components/settings/PlanPeakUsage';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Plan — Settings' };

const DISCORD_INVITE = 'https://discord.gg/SPa24vGa7R';

export default async function PlanSettingsPage() {
  const usage = await getPlanUsage();

  return (
    <SectionPanel
      icon={<CreditCard className="size-4.5" />}
      title="Plan"
      subtitle="Your current plan and memory usage."
    >
      <div className="space-y-6">
        {/* Plan badge */}
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-3 py-1 text-xs font-semibold text-[var(--color-accent)]">
            <span
              className="size-1.5 rounded-full bg-[var(--color-accent)]"
              aria-hidden
            />
            {usage ? capitalize(usage.plan) : 'Free'} · Beta
          </span>
          <p className="text-xs text-[var(--color-content-secondary)]">
            During beta, LoreKit is completely free.
          </p>
        </div>

        {/* Memory usage */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-[var(--color-content-primary)]">
            Memory usage
          </h3>
          {usage ? (
            <>
              <PlanUsageBar usage={usage} />
              {/* A live count answers "how full am I now"; this answers "how
                  full WAS I over the last month" — usage_events.memory_count's
                  write-time snapshots (migration 00081). Renders nothing when
                  the window has no write events, so a quiet account shows no
                  caption rather than a fabricated zero. */}
              <PlanPeakUsage />
            </>
          ) : (
            /* Skeleton when usage fetch fails — degrade gracefully */
            <div className="h-2 animate-pulse rounded-full bg-[var(--color-bg-elevated)]" />
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-[var(--color-border)]" />

        {/* Discord CTA */}
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            Need more capacity?
          </p>
          <p className="text-xs text-[var(--color-content-secondary)]">
            Join the Discord and let me know — I&apos;ll raise your limit directly.
          </p>
          <a
            href={DISCORD_INVITE}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-9 w-fit items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 text-xs font-medium text-[var(--color-content-primary)] transition-colors hover:bg-[var(--color-bg-raised)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Join the Discord
            <ExternalLink className="size-3 text-[var(--color-content-tertiary)]" aria-hidden />
          </a>
        </div>
      </div>
    </SectionPanel>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
