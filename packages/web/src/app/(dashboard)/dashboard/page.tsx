import type { Metadata } from 'next';
import { Bot, Webhook, Zap } from 'lucide-react';
import { createServerClient } from '@/lib/supabase/server';
import { ScopeHealthGrid, type ScopeHealth } from '@/components/dashboard/ScopeHealthCard';
import { OnboardingChecklist, type OnboardingStep } from '@/components/dashboard/OnboardingChecklist';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { listTokens } from '@/lib/tokens';
import { scopeType } from '@/lib/scope';

export const metadata: Metadata = { title: 'Overview' };

async function fetchDashboardData(supabase: Awaited<ReturnType<typeof createServerClient>>) {
  const { data, error } = await supabase
    .from('memories')
    .select('scope,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error || !data) return { scopes: [], totalLessons: 0 };

  const scopeMap = new Map<string, { total: number; lastActivity: string }>();
  for (const row of data) {
    const scope = row.scope as string;
    const existing = scopeMap.get(scope);
    const ts = row.created_at as string;
    if (!existing || ts > existing.lastActivity) {
      scopeMap.set(scope, { total: (existing?.total ?? 0) + 1, lastActivity: ts });
    } else {
      existing.total++;
    }
  }

  const scopes: ScopeHealth[] = Array.from(scopeMap.entries())
    .sort(([, a], [, b]) => b.lastActivity.localeCompare(a.lastActivity))
    .map(([scope, { total, lastActivity }]) => ({
      scope,
      type: scopeType(scope),
      label: scope.split('::').pop() ?? scope,
      total,
      lastActivity,
    }));

  return { scopes, totalLessons: data.length };
}

async function fetchOnboardingState(supabase: Awaited<ReturnType<typeof createServerClient>>) {
  const [lessonsRes, webhookRes] = await Promise.all([
    supabase.from('memories').select('id', { count: 'exact', head: true }),
    supabase
      .from('memories')
      .select('id', { count: 'exact', head: true })
      .contains('tags', ['source::pr-webhook']),
  ]);
  return {
    hasLessons: (lessonsRes.count ?? 0) > 0,
    hasWebhook: (webhookRes.count ?? 0) > 0,
  };
}

export default async function DashboardPage() {
  const supabase = await createServerClient();
  const [{ scopes, totalLessons }, { hasLessons, hasWebhook }, tokens] = await Promise.all([
    fetchDashboardData(supabase),
    fetchOnboardingState(supabase),
    listTokens(),
  ]);

  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
  const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
  const mcpUrl = projectRef
    ? `https://${projectRef}.supabase.co/functions/v1/mcp`
    : 'https://<project-ref>.supabase.co/functions/v1/mcp';
  const webhookUrl = `${mcpUrl}/webhooks/github`;

  const steps: OnboardingStep[] = [
    {
      id: 'server',
      title: 'MCP server is live',
      subtitle: 'Your LoreKit Edge Function is deployed and accepting connections.',
      done: true,
      icon: <Zap className="size-4" />,
      content: null,
    },
    {
      id: 'connect',
      title: 'Connect your agent',
      subtitle: 'Generate a token and add it to your persistent-memory config.',
      done: hasLessons,
      icon: <Bot className="size-4" />,
      content: (
        <OnboardingStepContent
          step="connect"
          mcpUrl={mcpUrl}
          initialTokens={tokens}
        />
      ),
    },
    {
      id: 'webhook',
      title: 'Set up the GitHub webhook',
      subtitle: 'LoreKit will automatically create lessons from your PR review comments.',
      done: hasWebhook,
      icon: <Webhook className="size-4" />,
      content: (
        <OnboardingStepContent
          step="webhook"
          mcpUrl={mcpUrl}
          webhookUrl={webhookUrl}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Overview</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      <OnboardingChecklist steps={steps} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: 'Total lessons', value: totalLessons },
          { label: 'Scopes', value: scopes.length },
          {
            label: 'Active today',
            value: scopes.filter((s) =>
              s.lastActivity?.startsWith(new Date().toISOString().slice(0, 10)),
            ).length,
          },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
            <p className="text-xs text-[var(--color-content-tertiary)]">{label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">{value}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
          Scope health · sorted by recent activity
        </p>
        <ScopeHealthGrid scopes={scopes} />
      </div>
    </div>
  );
}
