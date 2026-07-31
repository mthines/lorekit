import type { Metadata } from 'next';
import { Github } from 'lucide-react';
import { listGithubInstallations } from '@/lib/github-installations';
import { resolveGithubAppInstallUrl } from '@/lib/github-app-url';
import { GithubAppManager } from '@/components/dashboard/GithubAppManager';
import { SectionPanel } from '@/components/ui/SectionPanel';

export const metadata: Metadata = { title: 'Integrations — Settings' };

/**
 * Settings → Integrations. One card today (the GitHub App); the section is
 * named for the category so the next connector is an addition, not a rename.
 *
 * The manual per-repo webhook secret UI that used to live here (at
 * `/settings/webhooks`) is gone: the App covers repos with no per-repo setup,
 * so keeping both offered two ways to do one thing and made the simpler one
 * look like the fallback. Existing per-repo secrets keep delivering — only the
 * dashboard surface for creating and managing them was removed.
 */
export default async function IntegrationsSettingsPage() {
  const installations = await listGithubInstallations();
  const appInstallUrl = resolveGithubAppInstallUrl();

  return (
    <div className="flex flex-col gap-4">
      <SectionPanel
        anchorId="github-app"
        icon={<Github className="size-4.5" />}
        title="GitHub App"
        subtitle="Install the App and every repo you grant it is covered automatically — resolved PR review comments become memories tagged source::pr-webhook."
      >
        <GithubAppManager installations={installations} installUrl={appInstallUrl} />
      </SectionPanel>
    </div>
  );
}
