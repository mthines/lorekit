import type { Metadata } from 'next';
import { createServerClient } from '@/lib/supabase/server';
import { ScopeHealthGrid, type ScopeHealth } from '@/components/dashboard/ScopeHealthCard';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { scopeType } from '@/lib/scope';

export const metadata: Metadata = { title: 'Overview' };

async function fetchDashboardData(supabase: Awaited<ReturnType<typeof createServerClient>>) {
  const { data, error } = await supabase
    .from('memories')
    .select('scope,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) return { scopes: [], totalLessons: 0 };

  // Aggregate per scope
  const scopeMap = new Map<string, { total: number; lastActivity: string }>();
  for (const row of data) {
    const scope = row.scope as string;
    const existing = scopeMap.get(scope);
    const ts = row.created_at as string;
    if (!existing || ts > existing.lastActivity) {
      scopeMap.set(scope, {
        total: (existing?.total ?? 0) + 1,
        lastActivity: ts,
      });
    } else {
      existing.total++;
    }
  }

  const scopes: ScopeHealth[] = Array.from(scopeMap.entries())
    .sort(([, a], [, b]) => b.lastActivity.localeCompare(a.lastActivity))
    .map(([scope, { total, lastActivity }]) => {
      const parts = scope.split('::');
      return {
        scope,
        type: scopeType(scope),
        label: parts[parts.length - 1] ?? scope,
        total,
        lastActivity,
      };
    });

  return { scopes, totalLessons: data.length };
}

async function buildOnboardingSteps(supabase: Awaited<ReturnType<typeof createServerClient>>, hasLessons: boolean) {
  // Check if GitHub webhook is configured by looking for pr-webhook tagged entries
  const { count: webhookCount } = await supabase
    .from('memories')
    .select('id', { count: 'exact', head: true })
    .contains('tags', ['source::pr-webhook']);

  const hasWebhook = (webhookCount ?? 0) > 0;

  return [
    {
      id: 'deploy',
      title: 'Deploy LoreKit',
      description: 'Host the MCP server on Supabase Edge Functions or Fly.io.',
      done: true, // If they can see this page, the server is running
      href: 'https://github.com/mthines/lorekit/blob/main/SETUP.md#step-9',
      linkLabel: 'Setup guide',
    },
    {
      id: 'first-lesson',
      title: 'Your first lesson was written',
      description: 'Configure persistent-memory in your agent-skills setup to point at this server.',
      done: hasLessons,
      href: 'https://github.com/mthines/lorekit/blob/main/SETUP.md#step-10',
      linkLabel: 'How to connect',
    },
    {
      id: 'webhook',
      title: 'Set up the GitHub webhook',
      description: 'LoreKit learns from your PR review comments automatically.',
      done: hasWebhook,
      href: 'https://github.com/mthines/lorekit/blob/main/SETUP.md#step-8',
      linkLabel: 'Webhook guide',
    },
  ];
}

export default async function DashboardPage() {
  const supabase = await createServerClient();
  const { scopes, totalLessons } = await fetchDashboardData(supabase);
  const onboardingSteps = await buildOnboardingSteps(supabase, totalLessons > 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Overview
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      {/* Onboarding — hidden once all steps are complete */}
      <OnboardingChecklist steps={onboardingSteps} />

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: 'Total lessons', value: totalLessons },
          { label: 'Scopes', value: scopes.length },
          {
            label: 'Active today',
            value: scopes.filter(
              (s) => s.lastActivity?.startsWith(new Date().toISOString().slice(0, 10)),
            ).length,
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
          >
            <p className="text-xs text-[var(--color-content-tertiary)]">{label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* Scope health grid */}
      <div>
        <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
          Scope health · sorted by recent activity
        </p>
        <ScopeHealthGrid scopes={scopes} />
      </div>
    </div>
  );
}
