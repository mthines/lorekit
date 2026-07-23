'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, CheckCheck, ExternalLink, Terminal, Webhook, Link2, Key } from 'lucide-react';
import { TokenManager } from './TokenManager';
import type { ApiToken } from '@/lib/tokens';
import type { TokenPermission } from '@/lib/tokens';

// ── Easing constants (matching globals.css tokens) ───────────────────────────

const EASE_STANDARD = [0.2, 0.8, 0.2, 1] as const;
const EASE_IN       = [0.4, 0, 1, 1]     as const;

// ── MCP client definitions ────────────────────────────────────────────────────
//
// Each client entry drives the filename, config snippet shape, and guidance.
// Adding a new client here is the only change needed to support it everywhere.

type InstallScope = 'project' | 'global';

interface McpClient {
  id: string;
  name: string;
  /** Short glyph / abbreviation shown in the selector card */
  glyph: string;
  scope: InstallScope;
  /** Relative or absolute path shown under the code block */
  configPath: string;
  /** Short copy shown under the selector */
  hint: string;
  /** Full path label displayed in the CodeBlock header */
  filename: string;
  /**
   * Given the mcp-remote URL, produce the JSON config string.
   * All clients use the same shape; some (e.g. Cursor) wrap it in `mcpServers`.
   */
  buildConfig: (mcpUrlWithToken: string) => string;
}

const MCP_CLIENTS: McpClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    glyph: 'CC',
    scope: 'project',
    configPath: '.mcp.json',
    filename: '.mcp.json',
    hint: 'Project-local. Add to .gitignore — the token is in the URL.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'opencode',
    name: 'opencode',
    glyph: 'OC',
    scope: 'project',
    configPath: '.opencode/mcp.json',
    filename: '.opencode/mcp.json',
    hint: 'Project-local. opencode reads this automatically from the project root.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    glyph: 'Cu',
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
    glyph: 'WS',
    scope: 'global',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    filename: 'mcp_config.json (Windsurf global)',
    hint: 'Global. Windsurf reads MCP config from ~/.codeium/windsurf/mcp_config.json.',
    buildConfig: (url) => JSON.stringify({
      mcpServers: { lorekit: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
    }, null, 2),
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    glyph: 'Cx',
    scope: 'global',
    configPath: '~/.codex/config.yaml',
    filename: 'config.yaml (Codex CLI global)',
    hint: 'Global. Codex CLI reads MCP servers from ~/.codex/config.yaml.',
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

  // Detect language from filename extension
  const lang = filename.endsWith('.yaml') || filename.endsWith('.yml') ? 'yaml' : 'json';

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-content-tertiary)]">
          {filename}
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy to clipboard"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-[var(--color-content-tertiary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-accent)] active:[transform:scale(0.97)]"
        >
          {copied
            ? <><CheckCheck className="size-3" /> Copied!</>
            : <><Copy className="size-3" /> Copy</>}
        </button>
      </div>
      <pre
        className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre"
        data-language={lang}
      >
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
      className="group inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-xs text-[var(--color-content-secondary)] transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:[transform:scale(0.97)]"
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
// Horizontal row of glyph cards. The active card has an amber glow + accent
// border — the LoreKit signature. Motion `layoutId` slides the indicator pill
// underneath (Tab-switch catalog row: 200–280 ms, cubic-bezier(0.2,0.8,0.2,1)).

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
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
        MCP client
      </p>

      {/* Selector row */}
      <div
        role="radiogroup"
        aria-label="MCP client"
        className="flex gap-2 flex-wrap"
      >
        {clients.map((client) => {
          const isActive = client.id === active;
          return (
            <button
              key={client.id}
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(client.id)}
              className={[
                'relative flex flex-col items-center gap-1 rounded-xl border px-3 py-2.5',
                'text-center',
                'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2',
                // CSS-only press: scale(0.97) on :active, 80 ms ease-out
                '[transition:border-color_150ms,background-color_150ms,transform_80ms_ease-out] active:[transform:scale(0.97)]',
                isActive
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
                  : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-elevated)]',
              ].join(' ')}
              style={isActive ? {
                boxShadow: '0 0 18px -2px var(--color-accent-glow)',
              } : undefined}
            >
              {/* Glyph */}
              <span
                className={[
                  'font-mono text-xs font-bold tracking-tight',
                  isActive
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-content-tertiary)]',
                ].join(' ')}
                aria-hidden
              >
                {client.glyph}
              </span>

              {/* Name */}
              <span
                className={[
                  'text-[10px] font-medium whitespace-nowrap',
                  isActive
                    ? 'text-[var(--color-content-primary)]'
                    : 'text-[var(--color-content-tertiary)]',
                ].join(' ')}
              >
                {client.name}
              </span>

              {/* Scope badge */}
              <span
                className={[
                  'rounded-full px-1.5 py-px text-[8px] font-semibold uppercase tracking-wider',
                  client.scope === 'project'
                    ? 'bg-emerald-500/10 text-[var(--color-scope-project)]'
                    : 'bg-violet-500/10 text-[var(--color-scope-global)]',
                ].join(' ')}
              >
                {client.scope}
              </span>
            </button>
          );
        })}
      </div>

      {/* Hint text — cross-fades when client changes */}
      <AnimatePresence mode="wait">
        <motion.p
          key={active}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: EASE_IN }}
          className="text-[10px] text-[var(--color-content-tertiary)]"
        >
          {clients.find((c) => c.id === active)?.hint}
        </motion.p>
      </AnimatePresence>
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

  function handleNewToken(token: string) {
    setActiveToken(token);
  }

  const mcpUrlWithToken = `${mcpUrl}?token=${activeToken}`;
  const activeClient = MCP_CLIENTS.find((c) => c.id === activeClientId) ?? MCP_CLIENTS[0];
  const configSnippet = activeClient.buildConfig(mcpUrlWithToken);

  const tokenPlaceholder = activeToken === '<your-lorekit-token>';

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-content-secondary)]">
        {autoGeneratedToken
          ? <>
              We created a read+write token for you. Select your MCP client below,
              then copy the config — the token is already filled in.
            </>
          : <>
              Choose your MCP client, generate a token, and copy the ready-to-use config
              into the file shown. Works with any MCP-compatible agent.
            </>}
      </p>

      {/* Client selector */}
      <ClientSelector
        clients={MCP_CLIENTS}
        active={activeClientId}
        onChange={setActiveClientId}
      />

      {/* Token manager */}
      <div>
        <SectionLabel icon={<Key className="size-3" />}>API tokens</SectionLabel>
        <TokenManager
          initialTokens={initialTokens}
          onNewToken={handleNewToken}
          initialNewToken={autoGeneratedToken}
        />
      </div>

      {/* MCP endpoint */}
      <div>
        <SectionLabel icon={<Link2 className="size-3" />}>Your MCP endpoint</SectionLabel>
        <InlineCode>{mcpUrl}</InlineCode>
      </div>

      {/* Config snippet — cross-fades when client or token changes */}
      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>
          {activeClient.filename}
        </SectionLabel>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeClientId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE_IN }}
          >
            <CodeBlock code={configSnippet} filename={activeClient.filename} />
          </motion.div>
        </AnimatePresence>

        {tokenPlaceholder && (
          <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
            Generate a token above and it will fill in automatically.
          </p>
        )}

        <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          File path:{' '}
          <code className="font-mono">{activeClient.configPath}</code>.
          {' '}Requires Node.js —{' '}
          <code className="font-mono">npx</code> will download{' '}
          <code className="font-mono">mcp-remote</code> on first run.
          {activeClient.scope === 'project' && (
            <> Add the file to <code className="font-mono">.gitignore</code> — the token is in the URL.</>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Step: GitHub webhook ──────────────────────────────────────────────────────

function WebhookStep({ webhookUrl }: { webhookUrl: string }) {
  const webhookGuide = `# 1. Go to your repo → Settings → Webhooks → Add webhook
# 2. Payload URL:
${webhookUrl}

# 3. Content type: application/json
# 4. Secret: your GITHUB_WEBHOOK_SECRET value
# 5. Events: "Pull request review comments"
#            and "Pull request reviews"`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--color-content-secondary)]">
        Every resolved PR review comment becomes a candidate lesson — tagged{' '}
        <code className="rounded bg-[var(--color-bg)] px-1 font-mono text-xs">
          source::pr-webhook
        </code>{' '}
        and visible in Lore Explorer.
      </p>

      <div>
        <SectionLabel icon={<Webhook className="size-3" />}>Webhook payload URL</SectionLabel>
        <InlineCode>{webhookUrl}</InlineCode>
      </div>

      <div>
        <SectionLabel icon={<Terminal className="size-3" />}>Setup steps</SectionLabel>
        <CodeBlock code={webhookGuide} filename="bash" />
      </div>

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
