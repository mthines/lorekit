import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { TutorialCard } from '@/components/learn/TutorialCard';

export const metadata: Metadata = { title: 'Offline storage — Getting started' };

export default function LearnOfflinePage() {
  return (
    <TutorialCard>
      <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Offline storage</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Store lore locally on your machine using the LoreKit CLI — no account, no network, full privacy.
          Memories live in a plain directory you own and control.
        </p>
      </div>

      <TutorialCallout variant="tip">
        Offline storage is the fastest way to start. You can migrate to remote storage later
        by adding a <code>LOREKIT_MCP_URL</code> and <code>LOREKIT_API_KEY</code> — the CLI
        reads both stores and merges them automatically.
      </TutorialCallout>

      <div className="flex flex-col">
        <TutorialStep number={1} title="Install the CLI">
          <pre><code>{`npx @lorekit/cli install`}</code></pre>
          <p className="mt-2">
            This scaffolds the <code>lorekit-memory</code> and <code>lorekit-setup</code> skills,
            the local MCP server, and the lifecycle hooks into your{' '}
            <code>.claude/</code> (project) or <code>~/.claude/</code> (global) directory.
          </p>
          <p className="mt-2">
            To skip hook injection (if you manage hooks separately):
          </p>
          <pre><code>{`npx @lorekit/cli install --no-hooks`}</code></pre>
        </TutorialStep>

        <TutorialStep number={2} title="Verify the local store">
          <pre><code>{`npx @lorekit/cli doctor`}</code></pre>
          <p className="mt-2">
            This checks connectivity, token permissions, and scope health. In offline-only mode
            it confirms that the local MCP server is reachable and the store directory is writable.
          </p>
        </TutorialStep>

        <TutorialStep number={3} title="Write your first memory">
          <pre><code>{`npx @lorekit/cli mcp`}</code></pre>
          <p className="mt-2">
            This starts the local stdio MCP server. Your agent can then call{' '}
            <code>memory.write</code> to store a memory:
          </p>
          <pre><code>{`memory.write {
  scope: "global",
  key:   "my-first-lesson",
  value: "Always run the unit tests before committing."
}`}</code></pre>
          <p className="mt-2">
            Memories are stored as plain files under <code>.lorekit/</code> in your home directory.
          </p>
        </TutorialStep>

        <TutorialStep number={4} title="List your memories">
          <pre><code>{`npx @lorekit/cli list`}</code></pre>
          <p className="mt-2">
            Shows all memories in the applicable scopes (project → branch → repo → global),
            split into an <strong>Offline</strong> section (local files) and a{' '}
            <strong>Remote</strong> section (hosted, if configured).
          </p>
          <p className="mt-2">Filter to a specific scope:</p>
          <pre><code>{`npx @lorekit/cli list --scope global`}</code></pre>
        </TutorialStep>

        <TutorialStep number={5} title="Search your memories">
          <pre><code>{`npx @lorekit/cli search "commit"`}</code></pre>
          <p className="mt-2">
            Matches a literal, case-insensitive substring against the memory key or value.
            Works across all applicable scopes. Add <code>--scope</code> to narrow the search.
          </p>
        </TutorialStep>

        <TutorialStep number={6} title="(Optional) Commit a project config file">
          <p>
            Drop a <code>.lorekit.json</code> at the repo root to set the default memory mode
            for everyone on the team — no per-machine env var needed:
          </p>
          <pre><code>{`// .lorekit.json  (safe to commit)
{
  "mode": "local"
}`}</code></pre>
          <p className="mt-2">
            The same file also controls the local store path and deny constraints:
          </p>
          <pre><code>{`{
  "mode": "local",
  "store": ".lorekit",      // path to the project-tier store (default: .lorekit)
  "deny": ["remote"]        // prevent remote mode in this repo (e.g. for air-gapped CI)
}`}</code></pre>
          <p className="mt-2">
            A user-level version of the same file lives at{' '}
            <code>~/.lorekit/config.json</code> and applies across all repos. User-level deny
            constraints are a ceiling the repo config can never lift — a user who sets{' '}
            <code>{`"deny": ["remote"]`}</code> is always offline, regardless of the repo default.
          </p>
          <TutorialCallout variant="tip">
            Run <code>npx @lorekit/cli doctor</code> to see the resolved mode and which config
            source decided it. The output names the exact file or env var that won.
          </TutorialCallout>
        </TutorialStep>
      </div>

      <TutorialCallout variant="info">
        <strong>Next steps:</strong> once you have offline lore working, you can add the remote
        hosted store for cross-machine access. See the{' '}
        <Link href="/learn/remote" className="text-[var(--color-accent)] underline underline-offset-2">
          Remote storage tutorial
        </Link>{' '}
        to continue.
      </TutorialCallout>
    </div>
    </TutorialCard>
  );
}
