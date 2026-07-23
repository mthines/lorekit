'use client';

import { useState } from 'react';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2, Key, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { TokenManager } from './TokenManager';
import type { ApiToken } from '@/lib/tokens';
import type { TokenPermission } from '@/lib/tokens';

// ── MCP client definitions ────────────────────────────────────────────────────
//
// Each entry drives the filename, config snippet, and guidance.
// Adding a new client is the only change needed to support it everywhere.

type InstallScope = 'project' | 'global';

interface McpClient {
  id: string;
  name: string;
  scope: InstallScope;
  /** File path shown in footnote and CodeBlock header */
  configPath: string;
  filename: string;
  /** One-line hint shown under the selector */
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
//
// A compact pill-strip placed below the code block so it reads as a secondary
// "change config for a different client" affordance rather than a primary choice.

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

      {/* Token manager */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>API tokens</SectionLabel>
        <TokenManager
          initialTokens={initialTokens}
          onNewToken={(token) => setActiveToken(token)}
          initialNewToken={autoGeneratedToken}
        />
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

      {/* Client selector — secondary, below the code */}
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
// UX principle: the user needs a secret value they don't have yet.
// Generate it here so they can copy it into both places without guessing.
// Pattern mirrors the MCP token step: generate → amber banner → two-destination guide.

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface SecretDisplayProps {
  secret: string;
  onRegenerate: () => void;
}

function SecretDisplay({ secret, onRegenerate }: SecretDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      {/* Thin accent strip */}
      <div className="h-0.5 w-full bg-[var(--color-accent)]" aria-hidden />
      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <Key className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
          <p className="text-sm font-semibold text-[var(--color-content-primary)]">
            Your webhook secret — copy it now
          </p>
        </div>
        <p className="mb-3 text-xs text-[var(--color-content-secondary)]">
          Set this value as <code className="rounded bg-[var(--color-bg)] px-1 font-mono">GITHUB_WEBHOOK_SECRET</code> in your
          server environment, then paste it into GitHub&apos;s &ldquo;Secret&rdquo; field below.
          It isn&apos;t stored by LoreKit — if you lose it, generate a new one here and update both places.
        </p>

        {/* Secret display */}
        <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] p-3">
          <code className={[
            'min-w-0 flex-1 overflow-x-auto font-mono text-xs text-[var(--color-content-primary)] select-all',
            !visible ? 'blur-sm select-none' : '',
          ].join(' ')}>
            {secret}
          </code>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? 'Hide secret' : 'Show secret'}
              className="flex size-8 items-center justify-center rounded text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]"
            >
              {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              onClick={handleCopy}
              aria-label="Copy webhook secret"
              className="flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition-all duration-150 hover:bg-[var(--color-accent)] hover:text-[#000]"
            >
              {copied ? <><CheckCheck className="size-3" /> Copied!</> : <><Copy className="size-3" /> Copy</>}
            </button>
          </div>
        </div>

        <button
          onClick={onRegenerate}
          className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)] transition-colors duration-150"
        >
          <RefreshCw className="size-3" />
          Generate a different secret
        </button>
      </div>
    </div>
  );
}

function WebhookStep({ webhookUrl }: { webhookUrl: string }) {
  const [secret, setSecret] = useState<string>(() => generateWebhookSecret());

  // Step 1: set the env var on the server
  const envSnippet = `GITHUB_WEBHOOK_SECRET=${secret}`;

  // Step 2: GitHub webhook settings — secret is filled in so the user just copies
  const githubGuide = `# In your repo → Settings → Webhooks → Add webhook:
#
# Payload URL:    ${webhookUrl}
# Content type:  application/json
# Secret:        ${secret}
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

      {/* Generated secret — prominently first so users know what they're setting */}
      <SecretDisplay secret={secret} onRegenerate={() => setSecret(generateWebhookSecret())} />

      {/* Step 1 — server env */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>
          Step 1 — add to your server environment
        </SectionLabel>
        <CodeBlock code={envSnippet} filename=".env / Supabase secret" />
        <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          In Supabase: Dashboard → Edge Functions → Manage secrets → add{' '}
          <code className="font-mono">GITHUB_WEBHOOK_SECRET</code>.
        </p>
      </div>

      {/* Step 2 — GitHub */}
      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>
          Step 2 — add the webhook on GitHub
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
    return <WebhookStep webhookUrl={webhookUrl ?? mcpUrl} />;
  }
  return null;
}
