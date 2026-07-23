import type { Metadata } from 'next';
import { Bot, Webhook, Zap } from 'lucide-react';
import { OnboardingChecklist, type OnboardingStep } from '@/components/dashboard/OnboardingChecklist';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { listTokens } from '@/lib/tokens';
import { DashboardStats } from '@/components/dashboard/DashboardStats';

export const metadata: Metadata = { title: 'Overview' };

async function fetchOnboardingState() {
  // Server-side: import createServerClient lazily so this stays an RSC.
  const { createServerClient } = await import('@/lib/supabase/server');
  const supabase = await createServerClient();

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
  const [{ hasLessons, hasWebhook }, tokens] = await Promise.all([
    fetchOnboardingState(),
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

      {/* Scope health stats — fetched client-side with TanStack Query so
          navigation back to this page is instant after the first load. */}
      <DashboardStats />
    </div>
  );
}
