'use client';

import { useState } from 'react';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2 } from 'lucide-react';

// ── Reusable copy-button code block ──────────────────────────────────────────

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]">
          {language}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy to clipboard"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-[var(--color-content-tertiary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-accent)]"
        >
          {copied
            ? <><CheckCheck className="size-3" /> Copied!</>
            : <><Copy className="size-3" /> Copy</>}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre">
        {code.trim()}
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(children).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Click to copy"
      className="group inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-xs text-[var(--color-content-secondary)] transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
    >
      {children}
      {copied
        ? <CheckCheck className="size-3 shrink-0" />
        : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
      {icon}
      {children}
    </p>
  );
}

// ── Step: Connect your agent ──────────────────────────────────────────────────

function ConnectStep({ mcpUrl }: { mcpUrl: string }) {
  const persistentMemoryConfig = `{
  "backend": "mcp",
  "mcp": {
    "server": "${mcpUrl}",
    "auth": {
      "type": "bearer",
      "token": "<your-supabase-jwt>"
    }
  }
}`;

  const awCliCommand = `# In any project using mthines/agent-skills:
# Update .claude/skills/persistent-memory/config.json

# Or set via environment variable:
export LOREKIT_MCP_URL="${mcpUrl}"`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Your MCP server is ready. Point the{' '}
        <code className="rounded bg-[var(--color-bg)] px-1 py-0.5 font-mono text-xs">
          persistent-memory
        </code>{' '}
        skill at it to start writing lessons.
      </p>

      {/* MCP URL */}
      <div>
        <SectionLabel icon={<Link2 className="size-3" />}>Your MCP endpoint</SectionLabel>
        <InlineCode>{mcpUrl}</InlineCode>
      </div>

      {/* Config snippet */}
      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>
          persistent-memory config (.claude/skills/persistent-memory/config.json)
        </SectionLabel>
        <CodeBlock code={persistentMemoryConfig} language="json" />
      </div>

      {/* Get a JWT */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-3">
        <p className="text-xs font-medium text-[var(--color-content-secondary)]">
          Getting your Supabase JWT
        </p>
        <p className="mt-1 text-xs text-[var(--color-content-tertiary)]">
          After logging in, open DevTools → Application → Local Storage →{' '}
          <code className="font-mono">sb-*-auth-token</code> → copy the{' '}
          <code className="font-mono">access_token</code> value. For CI, use your service-role key instead.
        </p>
      </div>

      {/* CLI shortcut */}
      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>
          Or use via CLI
        </SectionLabel>
        <CodeBlock code={awCliCommand} language="bash" />
      </div>
    </div>
  );
}

// ── Step: GitHub webhook ──────────────────────────────────────────────────────

function WebhookStep({ webhookUrl }: { webhookUrl: string }) {
  const webhookGuide = `# 1. Go to your repo → Settings → Webhooks → Add webhook
# 2. Set Payload URL to:
${webhookUrl}

# 3. Content type: application/json
# 4. Secret: your GITHUB_WEBHOOK_SECRET value
# 5. Events: select "Pull request review comments"
#            and "Pull request reviews"`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Once connected, every resolved PR review comment becomes a candidate lesson —
        tagged <code className="rounded bg-[var(--color-bg)] px-1 py-0.5 font-mono text-xs">source::pr-webhook</code> and
        visible in Lore Explorer.
      </p>

      {/* Webhook URL */}
      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>Webhook payload URL</SectionLabel>
        <InlineCode>{webhookUrl}</InlineCode>
      </div>

      {/* Setup steps */}
      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>Setup steps</SectionLabel>
        <CodeBlock code={webhookGuide} language="bash" />
      </div>

      {/* Link to GitHub */}
      <a
        href="https://github.com/settings/apps"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-accent)]"
      >
        <ExternalLink className="size-3" />
        Open GitHub webhook settings
      </a>
    </div>
  );
}

// ── Exported component (wraps the right content per step) ─────────────────────

interface OnboardingStepContentProps {
  step: 'connect' | 'webhook';
  mcpUrl: string;
  webhookUrl?: string;
}

export function OnboardingStepContent({ step, mcpUrl, webhookUrl }: OnboardingStepContentProps) {
  if (step === 'connect') return <ConnectStep mcpUrl={mcpUrl} />;
  if (step === 'webhook') return <WebhookStep webhookUrl={webhookUrl ?? mcpUrl} />;
  return null;
}
