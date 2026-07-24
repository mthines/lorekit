'use client';

import { useState } from 'react';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2, Key, ShieldCheck, RefreshCw } from 'lucide-react';
import { TokenManager } from './TokenManager';
import type { ApiToken } from '@/lib/tokens';
import type { TokenPermission } from '@/lib/tokens';

// ── MCP client definitions ────────────────────────────────────────────────────

type InstallScope = 'project' | 'global';

interface McpClient {
  id: string;
  name: string;
  scope: InstallScope;
  configPath: string;
  filename: string;
  hint: string;
  buildConfig: (mcpUrlWithToken: string) => string;
}

const MCP_CLIENTS: McpClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    scope: 'project',
    configPath: '.mcp.json',
    filename: '.mcp.json',
    hint: 'Project-local. Add .mcp.json to .gitignore — the token is in the URL.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'opencode',
    name: 'opencode',
    scope: 'project',
    configPath: '.opencode/mcp.json',
    filename: '.opencode/mcp.json',
    hint: 'Project-local. opencode picks this up automatically from the project root.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scope: 'project',
    configPath: '.cursor/mcp.json',
    filename: '.cursor/mcp.json',
    hint: 'Project-local. Cursor reads .cursor/mcp.json from the workspace root.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scope: 'global',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    filename: 'mcp_config.json',
    hint: 'Global. Save to ~/.codeium/windsurf/mcp_config.json.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    scope: 'global',
    configPath: '~/.codex/config.yaml',
    filename: 'config.yaml',
    hint: 'Global. Add to ~/.codex/config.yaml.',
    buildConfig: (url) => `mcp:
  servers:
    lorekit:
      command: npx
      args:
        - -y
        - mcp-remote
        - "${url}"`,
  },
];

// ── Reusable copy-button code block ──────────────────────────────────────────

function CodeBlock({ code, filename }: { code: string; filename: string }) {
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
          {filename}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy to clipboard"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-accent)]"
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
      className="group inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
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

// ── Client selector ───────────────────────────────────────────────────────────

function ClientSelector({
  clients,
  active,
  onChange,
}: {
  clients: McpClient[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-[var(--color-content-tertiary)]">
        Using a different client?
      </p>
      <div role="radiogroup" aria-label="MCP client" className="flex flex-wrap gap-1.5">
        {clients.map((client) => {
          const isActive = client.id === active;
          return (
            <button
              key={client.id}
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(client.id)}
              className={[
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                isActive
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
                  : 'border-transparent text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              {client.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step: Connect your agent ──────────────────────────────────────────────────

function ConnectStep({
  mcpUrl,
  initialTokens,
  autoGeneratedToken,
}: {
  mcpUrl: string;
  initialTokens: ApiToken[];
  autoGeneratedToken?: string;
}) {
  const [activeToken, setActiveToken] = useState<string>(
    autoGeneratedToken ?? '<your-lorekit-token>',
  );
  const [activeClientId, setActiveClientId] = useState<string>(MCP_CLIENTS[0].id);

  const mcpUrlWithToken = `${mcpUrl}?token=${activeToken}`;
  const activeClient = MCP_CLIENTS.find((c) => c.id === activeClientId) ?? MCP_CLIENTS[0];
  const configSnippet = activeClient.buildConfig(mcpUrlWithToken);
  const tokenPlaceholder = activeToken === '<your-lorekit-token>';

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-content-secondary)]">
        {autoGeneratedToken
          ? 'We created a read+write token for you. Copy it from the banner below, then add the config to your agent.'
          : <>
              Generate a token below, then add the config to your agent&apos;s{' '}
              <code className="rounded bg-[var(--color-bg)] px-1 font-mono text-xs">
                {activeClient.filename}
              </code>{' '}
              file. Works with Claude Code, opencode, and any MCP-compatible client.
            </>}
      </p>

      <div>
        <SectionLabel icon={<Key className="size-3" />}>API tokens</SectionLabel>
        <TokenManager
          initialTokens={initialTokens}
          onNewToken={(token) => setActiveToken(token)}
          initialNewToken={autoGeneratedToken}
        />
      </div>

      <div>
        <SectionLabel icon={<Link2 className="size-3" />}>Your MCP endpoint</SectionLabel>
        <InlineCode>{mcpUrl}</InlineCode>
      </div>

      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>
          {activeClient.filename}
        </SectionLabel>
        <CodeBlock code={configSnippet} filename={activeClient.filename} />

        {tokenPlaceholder && (
          <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
            Generate a token above and it will fill in automatically.
          </p>
        )}

        <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          {activeClient.hint}{' '}
          Requires Node.js —{' '}
          <code className="font-mono">npx</code> will download{' '}
          <code className="font-mono">mcp-remote</code> on first run.
        </p>
      </div>

      <ClientSelector
        clients={MCP_CLIENTS}
        active={activeClientId}
        onChange={setActiveClientId}
      />
    </div>
  );
}

// ── Step: GitHub webhook ──────────────────────────────────────────────────────
//
// The GITHUB_WEBHOOK_SECRET is an operator-level deployment secret — it lives in
// the server environment (Supabase project secrets / Vercel env vars), not in the
// database. The server reads it, verifies whether it has been set, and passes that
// boolean to the client so the UI can show the right guidance without ever
// exposing the secret value in the HTML.
//
// Two states:
//   secretConfigured = true  → secret already in env; show GitHub instructions only.
//   secretConfigured = false → secret not yet set; let the user generate one in the
//                              browser (stable across re-renders via useState initializer),
//                              show it once, then walk them through setting it in both
//                              their Supabase project secrets AND GitHub webhook settings.

/** Generate a cryptographically random 32-byte hex string. */
function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function WebhookStep({
  webhookUrl,
  secretConfigured,
}: {
  webhookUrl: string;
  secretConfigured: boolean;
}) {
  // Stable across re-renders — only generated once on mount.
  const [secret] = useState<string>(() => generateSecret());
  const [secretCopied, setSecretCopied] = useState(false);

  // Step 1 — env var command (only shown when secret is not yet set)
  const supabaseSecretCmd = `supabase secrets set GITHUB_WEBHOOK_SECRET=${secret}`;

  // Step 2 — GitHub webhook instructions (secret pre-filled when not yet configured)
  const githubGuide = `# In your GitHub repo → Settings → Webhooks → Add webhook:
#
# Payload URL: ${webhookUrl}
# Content type: application/json
# Secret: ${secretConfigured ? '<paste your GITHUB_WEBHOOK_SECRET value>' : secret}
#
# Which events?
#   ✓ Pull request review comments
#   ✓ Pull request reviews`;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Every resolved PR review comment becomes a candidate lesson — tagged{' '}
        <code className="rounded bg-[var(--color-bg)] px-1 font-mono text-xs">
          source::pr-webhook
        </code>{' '}
        and visible in Lore Explorer.
      </p>

      {/* Webhook URL */}
      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>Webhook payload URL</SectionLabel>
        <InlineCode>{webhookUrl}</InlineCode>
      </div>

      {secretConfigured ? (
        // ── Secret already set in env ──────────────────────────────────────────
        <div className="flex items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
          <div>
            <p className="text-sm font-medium text-[var(--color-content-primary)]">
              Webhook secret is set
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">
              <code className="font-mono">GITHUB_WEBHOOK_SECRET</code> is configured in your
              server environment. Use the same value when adding the webhook on GitHub.
            </p>
          </div>
        </div>
      ) : (
        // ── Secret not yet set — generate + show setup steps ──────────────────
        <>
          {/* Generated secret */}
          <div>
            <SectionLabel icon={<Key className="size-3" />}>Your webhook secret</SectionLabel>
            <p className="mb-2 text-xs text-[var(--color-content-secondary)]">
              This secret ties your GitHub webhook to your LoreKit server. Copy it — you
              will set it in two places below.
            </p>
            <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-[var(--color-content-primary)] select-all">
                {secret}
              </code>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(secret).then(() => {
                      setSecretCopied(true);
                      setTimeout(() => setSecretCopied(false), 2000);
                    });
                  }}
                  aria-label="Copy secret"
                  className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition-all duration-150 hover:bg-[var(--color-accent)] hover:text-[#000]"
                >
                  {secretCopied
                    ? <><CheckCheck className="size-3" /> Copied</>
                    : <><Copy className="size-3" /> Copy</>}
                </button>
              </div>
            </div>
          </div>

          {/* Step 1 — Supabase secret */}
          <div>
            <SectionLabel icon={<Terminal className="size-3" />}>
              Step 1 — add to Supabase project secrets
            </SectionLabel>
            <p className="mb-2 text-xs text-[var(--color-content-secondary)]">
              Run this in your terminal. Supabase Edge Functions pick up secrets on
              next deploy — no code change needed.
            </p>
            <CodeBlock code={supabaseSecretCmd} filename="terminal" />
            <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
              Using Vercel or another host? Add{' '}
              <code className="font-mono">GITHUB_WEBHOOK_SECRET</code> as an environment
              variable there instead.
            </p>
          </div>
        </>
      )}

      {/* Step 2 (or only step if already configured) — GitHub */}
      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>
          {secretConfigured ? 'Add the webhook on GitHub' : 'Step 2 — add the webhook on GitHub'}
        </SectionLabel>
        <CodeBlock code={githubGuide} filename="github webhook settings" />
      </div>

      <a
        href="https://github.com/settings/hooks"
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

// ── Exported component ────────────────────────────────────────────────────────

interface OnboardingStepContentProps {
  step: 'connect' | 'webhook';
  mcpUrl: string;
  webhookUrl?: string;
  /**
   * Whether GITHUB_WEBHOOK_SECRET is already set in the server environment.
   * Passed from the RSC (dashboard/page.tsx) — the server reads the env var
   * and passes only this boolean so the secret value never reaches the client.
   */
  webhookSecretConfigured?: boolean;
  autoGeneratedToken?: string;
  initialTokens?: Array<{
    id: string;
    name: string;
    token_prefix: string;
    permissions: TokenPermission[];
    last_used_at: string | null;
    created_at: string;
  }>;
}

export function OnboardingStepContent({
  step,
  mcpUrl,
  webhookUrl,
  webhookSecretConfigured = false,
  autoGeneratedToken,
  initialTokens = [],
}: OnboardingStepContentProps) {
  if (step === 'connect') {
    return (
      <ConnectStep
        mcpUrl={mcpUrl}
        initialTokens={initialTokens as ApiToken[]}
        autoGeneratedToken={autoGeneratedToken}
      />
    );
  }
  if (step === 'webhook') {
    return (
      <WebhookStep
        webhookUrl={webhookUrl ?? mcpUrl}
        secretConfigured={webhookSecretConfigured}
      />
    );
  }
  return null;
}
