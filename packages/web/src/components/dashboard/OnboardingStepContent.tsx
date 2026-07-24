'use client';

import { useState, useTransition } from 'react';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2, Key, RefreshCw, Eye, EyeOff, Loader2 } from 'lucide-react';
import { TokenManager } from './TokenManager';
import { generateWebhookSecret } from '@/lib/webhook-secrets';
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
// The secret is generated server-side on first dashboard visit and stored in
// webhook_secrets (mirroring api_tokens). The RSC passes it as a prop so the
// value is always real — no client-side generation, no ephemeral browser state.
//
// isNew = true  → show the amber "copy now" banner (first visit, just generated)
// isNew = false → show the masked existing secret with a "Regenerate" option

interface WebhookSecretDisplayProps {
  secret: string;
  isNew: boolean;
  onRegenerate: (newSecret: string) => void;
}

function WebhookSecretDisplay({ secret, isNew, onRegenerate }: WebhookSecretDisplayProps) {
  const [visible, setVisible] = useState(isNew); // show on first visit, hidden on return
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');

  function handleCopy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  function handleRegenerate() {
    setError('');
    startTransition(async () => {
      const result = await generateWebhookSecret();
      if ('error' in result) {
        setError(result.error);
        return;
      }
      onRegenerate(result.secret);
    });
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      {/* Thin accent strip — signals this requires action */}
      <div className="h-0.5 w-full bg-[var(--color-accent)]" aria-hidden />
      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <Key className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
          <p className="text-sm font-semibold text-[var(--color-content-primary)]">
            {isNew ? 'Your webhook secret — copy it now' : 'Your webhook secret'}
          </p>
        </div>

        {isNew && (
          <p className="mb-3 text-xs text-[var(--color-content-secondary)]">
            We generated this server-side and stored it securely. Set it as{' '}
            <code className="rounded bg-[var(--color-bg)] px-1 font-mono">GITHUB_WEBHOOK_SECRET</code>{' '}
            in Supabase secrets, then paste it into GitHub&apos;s &ldquo;Secret&rdquo; field below.
          </p>
        )}

        {!isNew && (
          <p className="mb-3 text-xs text-[var(--color-content-secondary)]">
            This is the secret currently set for your webhook. If you need to rotate it, click
            &ldquo;Regenerate&rdquo; and update both Supabase secrets and the GitHub webhook.
          </p>
        )}

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

        {error && <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p>}

        <button
          onClick={handleRegenerate}
          disabled={pending}
          className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)] transition-colors duration-150 disabled:opacity-50"
        >
          {pending
            ? <Loader2 className="size-3 animate-spin" />
            : <RefreshCw className="size-3" />}
          Regenerate secret
        </button>
      </div>
    </div>
  );
}

function WebhookStep({
  webhookUrl,
  webhookSecret,
  isNewWebhookSecret,
}: {
  webhookUrl: string;
  webhookSecret?: string;
  isNewWebhookSecret?: boolean;
}) {
  // Client-side state: the secret may be regenerated by the user after initial load.
  // Starts from the server-provided value; updates on regeneration.
  const [secret, setSecret] = useState<string | null>(webhookSecret ?? null);
  const isNew = isNewWebhookSecret ?? false;

  // Step 1 snippet — filled with real secret if available
  const envSnippet = secret
    ? `GITHUB_WEBHOOK_SECRET=${secret}`
    : `GITHUB_WEBHOOK_SECRET=<copy your secret above>`;

  // Step 2 snippet — all fields pre-filled
  const githubGuide = `# In your repo → Settings → Webhooks → Add webhook:
#
# Payload URL:    ${webhookUrl}
# Content type:  application/json
# Secret:        ${secret ?? '<copy your secret above>'}
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

      {/* Secret display — server-generated, persistently stored */}
      {secret ? (
        <WebhookSecretDisplay
          secret={secret}
          isNew={isNew}
          onRegenerate={(newSecret) => setSecret(newSecret)}
        />
      ) : (
        <p className="text-xs text-[var(--color-content-tertiary)]">
          Secret could not be generated. Reload the page to try again.
        </p>
      )}

      {/* Step 1 — server env */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>
          Step 1 — add to your Supabase Edge Function secrets
        </SectionLabel>
        <CodeBlock code={envSnippet} filename="Supabase secrets" />
        <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          Dashboard → Edge Functions → Manage secrets → add{' '}
          <code className="font-mono">GITHUB_WEBHOOK_SECRET</code>.
          Or via CLI:{' '}
          <code className="font-mono">supabase secrets set GITHUB_WEBHOOK_SECRET=&lt;value&gt;</code>
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
  webhookSecret?: string;
  isNewWebhookSecret?: boolean;
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
  webhookSecret,
  isNewWebhookSecret,
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
        webhookSecret={webhookSecret}
        isNewWebhookSecret={isNewWebhookSecret}
      />
    );
  }
  return null;
}
