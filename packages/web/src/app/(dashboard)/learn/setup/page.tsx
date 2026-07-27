import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';

export const metadata: Metadata = { title: 'Getting started — Learn' };

/**
 * Getting started — the first page new users land on.
 *
 * Intentionally mirrors the structure of every other Learn page (TutorialStep +
 * TutorialCallout) rather than reusing the OnboardingChecklist component.
 * The checklist widget is designed as a first-run nudge (dismissible, progress
 * ring, accordion) — not as a persistent tutorial reference. This page must
 * work for a new user who just signed up AND for an experienced user adding a
 * second framework or troubleshooting a connection.
 *
 * API keys and webhook secrets live in Settings — we link there rather than
 * embedding the token manager inline, keeping the tutorial scannable and
 * avoiding a token-generation side-effect on every page view.
 */
export default function LearnSetupPage() {
  const jsonSnippet = `{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-mcp-url>?token=lk_rw_…"]
    }
  }
}`;

  const yamlSnippet = `mcp:
  servers:
    lorekit:
      command: npx
      args:
        - -y
        - mcp-remote
        - "https://<your-mcp-url>?token=lk_rw_…"`;

  const writeSnippet = `memory.write {
  scope: "global",
  key:   "hello-lorekit",
  value: "Connection is working."
}`;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Getting started</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect LoreKit to your AI coding agent in three steps. Once connected, your agent
          can read and write lessons so knowledge accumulates across sessions.
        </p>
      </div>

      <div className="flex flex-col">

        {/* ── Step 1: API key ─────────────────────────────────────────────── */}
        <TutorialStep number={1} title="Generate an API token">
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
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li><code>lk_rw_…</code> — read + write (recommended for coding agents)</li>
            <li><code>lk_ro_…</code> — read only (context injection, CI)</li>
            <li><code>lk_wo_…</code> — write only (one-way lesson feeders)</li>
          </ul>
          <p className="mt-2">
            The token is shown <strong>once</strong> — copy it before closing the modal.
          </p>
        </TutorialStep>

        {/* ── Step 2: MCP config ──────────────────────────────────────────── */}
        <TutorialStep number={2} title="Add LoreKit to your agent's MCP config">
          <p>
            Paste your token into the MCP URL and drop the snippet into your agent&apos;s
            config file. Replace <code>{'<your-mcp-url>'}</code> with the endpoint shown in{' '}
            <Link
              href="/settings/api-keys"
              className="text-[var(--color-accent)] underline underline-offset-2"
            >
              Settings → API keys
            </Link>.
          </p>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Claude Code — <code>.mcp.json</code> (project root)
          </p>
          <pre className="mt-1"><code>{jsonSnippet}</code></pre>
          <p className="mt-1 text-xs text-[var(--color-content-tertiary)]">
            Add <code>.mcp.json</code> to <code>.gitignore</code> — the token is in the URL.
          </p>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-content-tertiary)]">
            opencode — <code>.opencode/mcp.json</code> (project root)
          </p>
          <pre className="mt-1"><code>{jsonSnippet}</code></pre>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Cursor — <code>.cursor/mcp.json</code> (project root)
          </p>
          <pre className="mt-1"><code>{jsonSnippet}</code></pre>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Windsurf — <code>~/.codeium/windsurf/mcp_config.json</code> (global)
          </p>
          <pre className="mt-1"><code>{jsonSnippet}</code></pre>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-content-tertiary)]">
            Codex CLI — <code>~/.codex/config.yaml</code> (global)
          </p>
          <pre className="mt-1"><code>{yamlSnippet}</code></pre>

          <TutorialCallout variant="tip">
            All five agents use the same URL format — only the config file path differs.
            Requires Node.js; <code>npx</code> downloads <code>mcp-remote</code> automatically
            on first run.
          </TutorialCallout>
        </TutorialStep>

        {/* ── Step 3: Verify ──────────────────────────────────────────────── */}
        <TutorialStep number={3} title="Verify the connection">
          <p>
            Start a new session in your agent and ask it to write a test lesson:
          </p>
          <pre className="mt-2"><code>{writeSnippet}</code></pre>
          <p className="mt-2">
            If the write succeeds, the{' '}
            <Link
              href="/lore"
              className="text-[var(--color-accent)] underline underline-offset-2"
            >
              Lore Explorer
            </Link>{' '}
            will show the lesson. You can also run the CLI health check:
          </p>
          <pre className="mt-2"><code>npx @lorekit/cli doctor</code></pre>
        </TutorialStep>

      </div>

      {/* ── Optional: GitHub webhook ─────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">
          Optional: auto-lessons from PR reviews
        </p>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect a GitHub webhook and every resolved PR review comment becomes a lesson
          automatically, tagged{' '}
          <code className="rounded bg-[var(--color-bg-elevated)] px-1 font-mono text-xs">source::pr-webhook</code>.
          Set this up any time from{' '}
          <Link
            href="/settings/webhooks"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            Settings → Webhooks
          </Link>.
        </p>
      </div>

      <TutorialCallout>
        <strong>Next steps:</strong> see the{' '}
        <Link
          href="/learn/remote"
          className="text-[var(--color-accent)] underline underline-offset-2"
        >
          Remote storage
        </Link>{' '}
        tutorial for token tiers and CI injection, or{' '}
        <Link
          href="/learn/organization"
          className="text-[var(--color-accent)] underline underline-offset-2"
        >
          Team sharing
        </Link>{' '}
        to share lore across your whole team.
      </TutorialCallout>
    </div>
  );
}
