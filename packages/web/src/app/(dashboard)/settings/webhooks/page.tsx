import type { Metadata } from 'next';
import { Webhook } from 'lucide-react';
import { listWebhookSecrets } from '@/lib/webhook-secrets';
import { resolveMcpUrls } from '@/lib/mcp-url';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Webhooks — Settings' };

export default async function WebhooksSettingsPage() {
  // Per-repo secrets: list what exists; WebhookSecretManager handles add/regenerate.
  const webhookSecrets = await listWebhookSecrets();
  const { mcpUrl, webhookUrl } = resolveMcpUrls();

  return (
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
  );
}
