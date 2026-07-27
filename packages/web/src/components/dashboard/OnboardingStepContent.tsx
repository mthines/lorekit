'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2, Key, ArrowRight } from 'lucide-react';
import { TokenManager } from './TokenManager';
import { WebhookSecretManager } from './WebhookSecretManager';
import type { WebhookSecret } from '@/lib/webhook-secrets';
import type { ApiToken } from '@/lib/tokens';
import type { TokenPermission } from '@/lib/tokens';

// ── MCP client definitions ────────────────────────────────────────────────────

type InstallScope = 'project' | 'global';

interface McpClient {
  id: string;
  name: string;
  scope: InstallScope;
  /** File path shown in footnote and CodeBlock header. */
  configPath: string;
  filename: string;
  /** One-line hint shown below the config snippet. */
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

// ── Client logos (greyscale inline SVG) ──────────────────────────────────────
//
// Each logo is a simplified monochrome mark sized for a 20×20 viewport.
// They render at 'currentColor' so the active/inactive colour cascade
// from the parent button's text colour.

function LogoClaudeCode({ className }: { className?: string }) {
  // Anthropic "A" lettermark — triangular apex with two horizontal bars
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M10 2L2 17h3.5l1.4-3h6.2l1.4 3H18L10 2zm-1.8 9L10 6.5l1.8 4.5H8.2z"
        fill="currentColor"
      />
    </svg>
  );
}

function LogoOpencode({ className }: { className?: string }) {
  // Stylised "{ }" — opencode is a terminal-native tool, curly braces suit it
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M7 3H5C4 3 3 4 3 5v3l-1.5 2L3 12v3c0 1 1 2 2 2h2M13 3h2c1 0 2 1 2 2v3l1.5 2L17 12v3c0 1-1 2-2 2h-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="1.2" fill="currentColor" />
    </svg>
  );
}

function LogoCursor({ className }: { className?: string }) {
  // Cursor's distinctive diagonal double-arrow mark
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M3 3l6 14 2.5-5.5L17 9 3 3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M11.5 11.5l4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LogoWindsurf({ className }: { className?: string }) {
  // Wave / surfboard silhouette — Windsurf's aquatic identity
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <path
        d="M2 13c2-4 4-7 8-9l2 12c-2-1-4-2-10-3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M12 4c1 2 2 5 2 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M3 16c4-0.5 8-0.5 14 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LogoCodexCli({ className }: { className?: string }) {
  // Terminal ">" prompt — Codex CLI is command-line first
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6 8l3 2.5L6 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 13h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const CLIENT_LOGO: Record<string, React.ComponentType<{ className?: string }>> = {
  'claude-code': LogoClaudeCode,
  'opencode': LogoOpencode,
  'cursor': LogoCursor,
  'windsurf': LogoWindsurf,
  'codex-cli': LogoCodexCli,
};

// ── Shared helpers ────────────────────────────────────────────────────────────

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
//
// A logo-tab strip that lets the user switch between MCP clients at a glance.
// Each tab shows a greyscale logo mark + the client name. The active tab gets
// a border + slightly elevated background; inactive tabs are muted and gain
// colour on hover. Logos render at `currentColor` so the cascade handles all
// state transitions — no per-state colour overrides needed.

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
      <div
        role="radiogroup"
        aria-label="MCP client"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${clients.length}, minmax(0, 1fr))` }}
      >
        {clients.map((client) => {
          const isActive = client.id === active;
          const Logo = CLIENT_LOGO[client.id];
          return (
            <button
              key={client.id}
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(client.id)}
              title={client.name}
              className={[
                'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-center transition-all duration-150',
                isActive
                  ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
                  : 'border-transparent text-[var(--color-content-tertiary)] hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-content-secondary)]',
              ].join(' ')}
            >
              {Logo && <Logo className="size-5 shrink-0" />}
              <span className="text-[10px] font-medium leading-none">{client.name}</span>
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
  manageHref,
}: {
  mcpUrl: string;
  initialTokens: ApiToken[];
  autoGeneratedToken?: string;
  /** When set, shows a link to the persistent settings home for keys. */
  manageHref?: string;
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

      {/* Token manager */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>API tokens</SectionLabel>
        <TokenManager
          initialTokens={initialTokens}
          onNewToken={(token) => setActiveToken(token)}
          initialNewToken={autoGeneratedToken}
        />
        {manageHref && (
          <Link
            href={manageHref}
            className="group mt-2 inline-flex items-center gap-1 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-accent)]"
          >
            Manage all API keys in Settings
            <ArrowRight className="size-3 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
          </Link>
        )}
      </div>

      {/* MCP endpoint */}
      <div>
        <SectionLabel icon={<Link2 className="size-3" />}>Your MCP endpoint</SectionLabel>
        <InlineCode>{mcpUrl}</InlineCode>
      </div>

      {/* Config snippet */}
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

      {/* Client selector — logo tabs, below the config snippet */}
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
// Secrets are per-repo (see WebhookSecretManager) — a user adds a secret for
// each owner/repo they want to webhook. The RSC passes the current list of
// active secrets; the manager handles adding, listing, and regenerating them
// client-side. There is no maintainer-owned Supabase infra for the end user
// to configure — the edge function reads webhook_secrets directly.

function WebhookStep({
  webhookUrl,
  webhookSecrets,
}: {
  webhookUrl: string;
  webhookSecrets: WebhookSecret[];
}) {
  const githubGuide = `# In your repo → Settings → Webhooks → Add webhook:
#
# Payload URL:    ${webhookUrl}
# Content type:  application/json
# Secret:        <the secret shown above for this repo>
# Events:        ✓ Pull request review comments
#                ✓ Pull request reviews`;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Every resolved PR review comment becomes a candidate lesson — tagged{' '}
        <code className="rounded bg-[var(--color-bg)] px-1 font-mono text-xs">
          source::pr-webhook
        </code>{' '}
        and visible in Lore Explorer.
      </p>

      {/* Per-repo secret manager — add a repo, list existing secrets, regenerate */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>Webhook secrets</SectionLabel>
        <WebhookSecretManager initialSecrets={webhookSecrets} />
      </div>

      {/* Add the webhook on GitHub */}
      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>
          Add the webhook on GitHub
        </SectionLabel>
        <CodeBlock code={githubGuide} filename="GitHub webhook settings" />
        <a
          href="https://github.com/settings/hooks"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-accent)]"
        >
          <ExternalLink className="size-3" />
          Open GitHub webhook settings
        </a>
      </div>
    </div>
  );
}

// ── Exported component ────────────────────────────────────────────────────────

interface OnboardingStepContentProps {
  step: 'connect' | 'webhook';
  mcpUrl: string;
  webhookUrl?: string;
  webhookSecrets?: WebhookSecret[];
  autoGeneratedToken?: string;
  /** When set (onboarding context), the connect step links to the persistent settings home. */
  manageHref?: string;
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
  webhookSecrets = [],
  autoGeneratedToken,
  manageHref,
  initialTokens = [],
}: OnboardingStepContentProps) {
  if (step === 'connect') {
    return (
      <ConnectStep
        mcpUrl={mcpUrl}
        initialTokens={initialTokens as ApiToken[]}
        autoGeneratedToken={autoGeneratedToken}
        manageHref={manageHref}
      />
    );
  }
  if (step === 'webhook') {
    return (
      <WebhookStep
        webhookUrl={webhookUrl ?? mcpUrl}
        webhookSecrets={webhookSecrets}
      />
    );
  }
  return null;
}
