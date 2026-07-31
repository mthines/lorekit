import type { Metadata } from 'next';
import { Key, TerminalSquare, ArrowUpRight } from 'lucide-react';
import { listTokens } from '@/lib/tokens';
import { resolveMcpUrls } from '@/lib/mcp-url';
import { OnboardingStepContent } from '@/components/dashboard/OnboardingStepContent';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { SessionTokenPanel } from '@/components/settings/SessionTokenPanel';

export const metadata: Metadata = { title: 'API keys — Settings' };

export default async function ApiKeysSettingsPage() {
  // Read-only: the settings page surfaces existing keys, it never auto-generates.
  const tokens = await listTokens();
  const { mcpUrl } = resolveMcpUrls();

  return (
    <div className="flex flex-col gap-6">
      <SectionPanel
        icon={<Key className="size-4.5" />}
        title="API keys"
        subtitle="Tokens your agents use to reach LoreKit. The secret is shown once at creation — we store only the prefix, so it can never be revealed again."
      >
        <OnboardingStepContent step="connect" mcpUrl={mcpUrl} initialTokens={tokens} />
        <a
          href="/api-docs"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          Explore these endpoints in the API reference
          <ArrowUpRight className="size-4 shrink-0" aria-hidden />
        </a>
      </SectionPanel>

      <SectionPanel
        icon={<TerminalSquare className="size-4.5" />}
        title="Session token for API docs"
        subtitle="Grab your session token to test the JWT-only endpoints (Orgs, Members, Invites) in the API reference."
        collapsible
      >
        <SessionTokenPanel />
      </SectionPanel>
    </div>
  );
}
