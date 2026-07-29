'use client';

import { useState } from 'react';
import { Copy, CheckCheck } from 'lucide-react';

// ── MCP client definitions ────────────────────────────────────────────────────

type InstallScope = 'project' | 'global';

export interface McpClientConfig {
  id: string;
  name: string;
  scope: InstallScope;
  filename: string;
  hint: string;
  snippet: string;
}

// ── Greyscale logo marks ──────────────────────────────────────────────────────
//
// Each mark is a 20×20 inline SVG that uses `currentColor` so active/inactive
// colouring cascades from the parent button — no per-state overrides needed.

function LogoClaudeCode({ className }: { className?: string }) {
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

const LOGOS: Record<string, React.ComponentType<{ className?: string }>> = {
  'claude-code': LogoClaudeCode,
  'opencode':    LogoOpencode,
  'cursor':      LogoCursor,
  'windsurf':    LogoWindsurf,
  'codex-cli':   LogoCodexCli,
};

// ── Code block with copy ──────────────────────────────────────────────────────

function CopyableCode({ code, filename }: { code: string; filename: string }) {
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

// ── Main component ────────────────────────────────────────────────────────────

interface ClientConfigTabsProps {
  clients: McpClientConfig[];
}

/**
 * ClientConfigTabs — a logo-tab switcher that shows the MCP config snippet
 * for one client at a time.
 *
 * Used in two contexts:
 * - `OnboardingStepContent` (ConnectStep): live token substitution.
 * - `learn/setup` tutorial page: static snippets.
 *
 * UX rationale: five text-only pills are slower to scan than five logo+name
 * tabs. Logos provide instant visual recognition for the user's current tool
 * without reading every label. Greyscale keeps the selector visually quiet
 * relative to the config snippet that is the primary content.
 */
export function ClientConfigTabs({ clients }: ClientConfigTabsProps) {
  const [activeId, setActiveId] = useState(clients[0]?.id ?? '');
  const active = clients.find((c) => c.id === activeId) ?? clients[0];
  if (!active) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* Tab strip */}
      <div
        role="tablist"
        aria-label="MCP client"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${clients.length}, minmax(0, 1fr))` }}
      >
        {clients.map((client) => {
          const isActive = client.id === activeId;
          const Logo = LOGOS[client.id];
          return (
            <button
              key={client.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`client-panel-${client.id}`}
              id={`client-tab-${client.id}`}
              onClick={() => setActiveId(client.id)}
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

      {/* Panel */}
      <div
        role="tabpanel"
        id={`client-panel-${active.id}`}
        aria-labelledby={`client-tab-${active.id}`}
      >
        <CopyableCode code={active.snippet} filename={active.filename} />
        <p className="mt-1.5 text-[10px] text-[var(--color-content-tertiary)]">
          {active.hint}
        </p>
      </div>
    </div>
  );
}
