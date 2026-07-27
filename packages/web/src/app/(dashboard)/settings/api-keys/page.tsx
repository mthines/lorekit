import type { Metadata } from 'next';
import { Key } from 'lucide-react';
import { listTokens } from '@/lib/tokens';
import { resolveMcpUrls } from '@/lib/mcp-url';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'API keys — Settings' };

export default async function ApiKeysSettingsPage() {
  // Read-only: the settings page surfaces existing keys, it never auto-generates.
  const tokens = await listTokens();
  const { mcpUrl, vanityMcpUrl } = resolveMcpUrls();

  return (
    <SectionPanel
      icon={<Key className="size-4.5" />}
      title="API keys"
      subtitle="Tokens your agents use to reach LoreKit. The secret is shown once at creation — we store only the prefix, so it can never be revealed again."
    >
      <OnboardingStepContent step="connect" mcpUrl={mcpUrl} vanityMcpUrl={vanityMcpUrl} initialTokens={tokens} />
    </SectionPanel>
  );
}
