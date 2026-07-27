import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { TutorialCard } from '@/components/learn/TutorialCard';

export const metadata: Metadata = { title: 'Remote storage — Getting started' };

export default function LearnRemotePage() {
  return (
    <TutorialCard>
      <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Remote storage</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Sync lore to the hosted LoreKit MCP server so your memories are available on every
          machine, from every agent, without any extra setup on each device.
        </p>
      </div>

      <TutorialCallout variant="tip">
        You can use the hosted instance at <code>lorekit.io</code> or
        self-host your own. This tutorial uses the hosted instance. For self-hosting see the{' '}
        <a
          href="https://github.com/mthines/lorekit/blob/main/docs/install.md"
          className="text-[var(--color-accent)] underline underline-offset-2"
          target="_blank"
          rel="noopener noreferrer"
        >
          Installation Guide
        </a>.
      </TutorialCallout>

      <div className="flex flex-col">
        <TutorialStep number={1} title="Generate an API token">
          <p>
            Go to{' '}
            <Link href="/settings/api-keys" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings → API keys
            </Link>{' '}
            and click <strong>Generate new token</strong>. Enter a name (e.g.{' '}
            <code>claude-local</code>, <code>ci-prod</code>) and choose a permission tier:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li><code>lk_rw_…</code> — read + write (agents that learn)</li>
            <li><code>lk_ro_…</code> — read only (CI context injection)</li>
            <li><code>lk_wo_…</code> — write only (one-way memory feeders)</li>
          </ul>
          <p className="mt-2">
            The token is shown <strong>once only</strong> — copy it before closing the modal.
          </p>
        </TutorialStep>

        <TutorialStep number={2} title="Point your agent at the MCP server">
          <p>
            Add the MCP endpoint to your agent config. For Claude Code, in{' '}
            <code>.claude/skills/persistent-memory/config.json</code>:
          </p>
          <pre><code>{`{
  "backend": "mcp",
  "mcp": {
    "server": "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp",
    "auth": {
      "type": "bearer",
      "token": "lk_rw_<your-token>"
    }
  }
}`}</code></pre>
          <p className="mt-2">
            For any other MCP-compatible agent, point the client at the same endpoint with
            the same <code>Authorization: Bearer lk_rw_…</code> header.
          </p>
        </TutorialStep>

        <TutorialStep number={3} title="Verify the connection">
          <pre><code>{`npx @lorekit/cli doctor`}</code></pre>
          <p className="mt-2">
            The doctor command checks connectivity, token permissions, and scope health.
            Look for the <strong>Remote</strong> section in the output — it should show a
            green <code>ok</code> status.
          </p>
        </TutorialStep>

        <TutorialStep number={4} title="Write and read a memory">
          <p>Write a test memory via the MCP endpoint:</p>
          <pre><code>{`memory.write {
  scope: "global",
  key:   "hello-remote",
  value: "Remote lore is working."
}`}</code></pre>
          <p className="mt-2">Read it back from any machine:</p>
          <pre><code>{`memory.read {
  scope: "global",
  key:   "hello-remote"
}
// → { "value": "Remote lore is working.", "updated_at": "…" }`}</code></pre>
        </TutorialStep>

        <TutorialStep number={5} title="Use in CI / GitHub Actions">
          <p>
            Store a read-only token as <code>LOREKIT_TOKEN</code> in your repo secrets,
            then inject global memories before any AI step:
          </p>
          <pre><code>{`- name: Inject LoreKit context
  run: |
    curl -s -X POST "$LOREKIT_MCP_URL" \\
      -H "Authorization: Bearer $LOREKIT_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
          "name": "memory.list",
          "arguments": { "scope": "global", "limit": 20 }
        }
      }'
  env:
    LOREKIT_MCP_URL: https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp
    LOREKIT_TOKEN: \${{ secrets.LOREKIT_TOKEN }}`}</code></pre>
        </TutorialStep>

        <TutorialStep number={6} title="(Optional) Set up the GitHub webhook">
          <p>
            To have LoreKit automatically learn from PR review comments, go to{' '}
            <Link href="/settings/webhooks" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings → Webhooks
            </Link>, add your repo (<code>owner/repo</code>), copy the generated secret,
            then configure a webhook on GitHub pointing at your MCP endpoint:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li><strong>Payload URL:</strong> <code>…/functions/v1/mcp/webhooks/github</code></li>
            <li><strong>Content type:</strong> <code>application/json</code></li>
            <li><strong>Events:</strong> Pull request review comments + Pull request reviews</li>
          </ul>
        </TutorialStep>
      </div>

      <TutorialCallout>
        <strong>Next steps:</strong> share memories with your whole team by setting up an
        organization. See the{' '}
        <Link href="/learn/organization" className="text-[var(--color-accent)] underline underline-offset-2">
          Team sharing tutorial
        </Link>.
      </TutorialCallout>
    </div>
    </TutorialCard>
  );
}
