import type { Metadata } from 'next';
import { Webhook, Github } from 'lucide-react';
import { listWebhookSecrets } from '@/lib/webhook-secrets';
import { listGithubInstallations } from '@/lib/github-installations';
import { resolveMcpUrls } from '@/lib/mcp-url';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { GithubAppManager } from '@/components/dashboard/GithubAppManager';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Webhooks — Settings' };

export default async function WebhooksSettingsPage() {
  // Per-repo secrets: list what exists; WebhookSecretManager handles add/regenerate.
  const [webhookSecrets, installations] = await Promise.all([
    listWebhookSecrets(),
    listGithubInstallations(),
  ]);
  const { mcpUrl, webhookUrl } = resolveMcpUrls();

  return (
    <div className="flex flex-col gap-4">
      {/* GitHub App installations section */}
      <SectionPanel
        icon={<Github className="size-4.5" />}
        title="GitHub App"
        subtitle="Zero-configuration webhook coverage — install the App and repos are covered automatically, no per-repo secret required."
      >
        <GithubAppManager installations={installations} />
      </SectionPanel>

      {/* Per-repo manual webhook secrets (existing path — untouched) */}
      <SectionPanel
        icon={<Webhook className="size-4.5" />}
        title="GitHub webhook"
        subtitle="Turn resolved PR review comments into memories automatically, tagged source::pr-webhook."
      >
        <OnboardingStepContent
          step="webhook"
          mcpUrl={mcpUrl}
          webhookUrl={webhookUrl}
          webhookSecrets={webhookSecrets}
        />
      </SectionPanel>
    </div>
  );
}
