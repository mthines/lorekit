import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { ClientConfigTabs, type McpClientConfig } from '@/components/dashboard/ClientConfigTabs';

// ── Constants ─────────────────────────────────────────────────────────────────

// Exported so the async server wrapper (`GettingStartedContentServer`) can
// pre-highlight these exact snippets with Shiki and pass the HTML back in.
export const MCP_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

export const JSON_SNIPPET = `{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}", "--header", "Authorization:Bearer lk_rw_…"]
    }
  }
}`;

export const YAML_SNIPPET = `mcp:
  servers:
    lorekit:
      command: npx
      args:
        - -y
        - mcp-remote
        - "${MCP_URL}"
        - --header
        - "Authorization:Bearer lk_rw_…"`;

export const WRITE_SNIPPET = `memory.write {
  scope: "global",
  key:   "hello-lorekit",
  value: "Connection is working."
}`;

export const DOCTOR_CMD = 'npx @lorekit/cli doctor';

export const MCP_CLIENTS: McpClientConfig[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    scope: 'project',
    filename: '.mcp.json',
    hint: 'Project-local. Add .mcp.json to .gitignore — it contains your token.',
    snippet: JSON_SNIPPET,
  },
  {
    id: 'opencode',
    name: 'opencode',
    scope: 'project',
    filename: '.opencode/mcp.json',
    hint: 'Project-local. opencode picks this up automatically from the project root.',
    snippet: JSON_SNIPPET,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scope: 'project',
    filename: '.cursor/mcp.json',
    hint: 'Project-local. Cursor reads .cursor/mcp.json from the workspace root.',
    snippet: JSON_SNIPPET,
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scope: 'global',
    filename: 'mcp_config.json',
    hint: 'Global. Save to ~/.codeium/windsurf/mcp_config.json.',
    snippet: JSON_SNIPPET,
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    scope: 'global',
    filename: 'config.yaml',
    hint: 'Global. Add to ~/.codex/config.yaml.',
    snippet: YAML_SNIPPET,
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Pre-rendered Shiki HTML for the code in this tutorial, keyed by the snippet's
 * raw string (config snippets) plus the two standalone blocks. Supplied by
 * {@link GettingStartedContentServer} in the docs (server) context; absent in
 * client contexts (the dialog), where the code falls back to plain text.
 */
export interface HighlightedSnippets {
  /** snippet string → highlighted HTML (the config-tab snippets). */
  snippets?: Record<string, string>;
  write?: string;
  doctor?: string;
}

interface Props {
  /**
   * When true, renders without auth-gated internal links (e.g. on the login
   * page). Interactive labels are replaced with plain descriptive text.
   * Defaults to false (authenticated dashboard context).
   */
  isPublic?: boolean;
  /** Optional pre-highlighted code (docs/server context); plain text if absent. */
  highlighted?: HighlightedSnippets;
}

/** A code block that renders pre-highlighted Shiki HTML when available, else the
 *  raw code as plain text — so the same component works in server (highlighted)
 *  and client (plain) contexts. */
function CodeSnippet({ html, code }: { html?: string; code: string }) {
  if (html) return <div className="mt-2" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre className="mt-2">
      <code>{code}</code>
    </pre>
  );
}

/**
 * Shared "Getting started" tutorial content. Used on the login page
 * (isPublic=true) and inside the authenticated /learn/setup page
 * (isPublic=false). Single source of truth — no duplication between surfaces.
 */
export function GettingStartedContent({ isPublic = false, highlighted }: Props) {
  // Attach pre-highlighted HTML to each config tab when available (docs context).
  const clients = MCP_CLIENTS.map((client) => ({
    ...client,
    snippetHtml: highlighted?.snippets?.[client.snippet],
  }));
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col">

        {/* ── Step 1: API key ─────────────────────────────────────────────── */}
        <TutorialStep number={1} title="Generate an API token">
          {isPublic ? (
            <p>
              After signing in, go to <strong>Settings → API keys</strong> and click{' '}
              <strong>Generate new token</strong>. Give it a name you&apos;ll recognise
              (e.g. <code>claude-work</code>, <code>cursor-home</code>) and choose a permission tier:
            </p>
          ) : (
            <p>
              Go to{' '}
              <Link
                href="/settings/api-keys"
                className="text-[var(--color-accent)] underline underline-offset-2"
              >
                Settings → API keys
              </Link>{' '}
              and click <strong>Generate new token</strong>. Give it a name you&apos;ll recognise
              (e.g. <code>claude-work</code>, <code>cursor-home</code>) and choose a permission tier:
            </p>
          )}
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li><code>lk_rw_…</code> — read + write (recommended for coding agents)</li>
            <li><code>lk_ro_…</code> — read only (context injection, CI)</li>
            <li><code>lk_wo_…</code> — write only (one-way memory feeders)</li>
          </ul>
          <p className="mt-2">
            The token is shown <strong>once</strong> — copy it before closing the modal.
          </p>
        </TutorialStep>

        {/* ── Step 2: MCP config ──────────────────────────────────────────── */}
        <TutorialStep number={2} title="Add LoreKit to your agent's MCP config">
          <p>
            Replace <code>lk_rw_…</code> with your token and drop the snippet into your
            agent&apos;s config file.
          </p>

          <div className="mt-4">
            <ClientConfigTabs clients={clients} />
          </div>

          <TutorialCallout variant="tip">
            All five agents use the same URL format — only the config file path differs.
            Requires Node.js; <code>npx</code> downloads <code>mcp-remote</code> automatically
            on first run.
          </TutorialCallout>
        </TutorialStep>

        {/* ── Step 3: Verify ──────────────────────────────────────────────── */}
        <TutorialStep number={3} title="Verify the connection">
          <p>
            Start a new session in your agent and ask it to write a test memory:
          </p>
          <CodeSnippet html={highlighted?.write} code={WRITE_SNIPPET} />
          {isPublic ? (
            <p className="mt-2">
              If the write succeeds, the <strong>Lore Explorer</strong> (in the dashboard) will
              show the memory. You can also run the CLI health check:
            </p>
          ) : (
            <p className="mt-2">
              If the write succeeds, the{' '}
              <Link
                href="/lore"
                className="text-[var(--color-accent)] underline underline-offset-2"
              >
                Lore Explorer
              </Link>{' '}
              will show the memory. You can also run the CLI health check:
            </p>
          )}
          <CodeSnippet html={highlighted?.doctor} code={DOCTOR_CMD} />
        </TutorialStep>

      </div>

      {/* ── Optional: GitHub webhook ─────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">
          Optional: auto-memories from PR reviews
        </p>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect a GitHub webhook and every resolved PR review comment becomes a memory
          automatically, tagged{' '}
          <code className="rounded bg-[var(--color-bg-elevated)] px-1 font-mono text-xs">source::pr-webhook</code>.
          {isPublic ? (
            <> Set this up any time from <strong>Settings → Integrations</strong> after signing in.</>
          ) : (
            <> Set this up any time from{' '}
              <Link
                href="/settings/integrations"
                className="text-[var(--color-accent)] underline underline-offset-2"
              >
                Settings → Integrations
              </Link>.
            </>
          )}
        </p>
      </div>

      <TutorialCallout>
        <strong>Next steps:</strong> see the{' '}
        <Link
          href="/docs/remote"
          className="text-[var(--color-accent)] underline underline-offset-2"
        >
          Remote storage
        </Link>{' '}
        tutorial for token tiers and CI injection, or{' '}
        <Link
          href="/docs/organization"
          className="text-[var(--color-accent)] underline underline-offset-2"
        >
          Team sharing
        </Link>{' '}
        to share lore across your whole team.
      </TutorialCallout>
    </div>
  );
}
