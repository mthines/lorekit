'use client';

/**
 * GitHub App installation manager — dashboard section.
 *
 * Displays the current user's linked GitHub App installations and the
 * repositories each covers, visually distinguishing App-covered repos from
 * the manual per-repo webhook secret setup.
 *
 * Read-only surface: mutations on GitHub App installations happen via the
 * GitHub App UI, not from within LoreKit (out of scope — see plan.md §Out of Scope).
 *
 * Mirrors the SectionPanel + motion-row + lucide-icon composition of
 * WebhookSecretManager, as the plan specifies (WRAP: sibling component).
 */

import { motion, AnimatePresence } from 'motion/react';
import {
  Github,
  GitBranch,
  Building2,
  User,
  CircleCheck,
  Info,
  Plus,
  ExternalLink,
} from 'lucide-react';
import type { GithubInstallation } from '@/lib/github-installations';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Install button — links to the App's public installation page ─────────────

/**
 * Anchor styled as a primary button that sends the user to GitHub's public
 * "install this App" page. Renders only when an install URL is configured
 * (NEXT_PUBLIC_GITHUB_APP_SLUG is set); callers pass `null` otherwise.
 *
 * `label` lets the empty state say "Install GitHub App" while an existing
 * installation says "Add repositories" (the same page manages both).
 */
function InstallAppButton({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      <Github className="size-3.5 shrink-0" aria-hidden />
      {label}
      <ExternalLink className="size-3 shrink-0 opacity-70" aria-hidden />
    </a>
  );
}

// ── Repo row — one App-covered repository ────────────────────────────────────

function AppCoveredRepoRow({ fullName }: { fullName: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <GitBranch className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-content-primary)]">
        {fullName}
      </span>
      <span
        title="Covered by GitHub App — no manual webhook secret required"
        className="flex items-center gap-1 rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]"
      >
        <CircleCheck className="size-3" aria-hidden />
        App-covered
      </span>
    </div>
  );
}

// ── Installation card ─────────────────────────────────────────────────────────

function InstallationCard({ installation }: { installation: GithubInstallation }) {
  const AccountIcon = installation.account_type === 'Organization' ? Building2 : User;
  const repos = installation.repositories;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      {/* Card header */}
      <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)]"
          aria-hidden
        >
          <AccountIcon className="size-4 text-[var(--color-accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-semibold text-[var(--color-content-primary)]">
            {installation.github_account_login}
          </p>
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            {installation.account_type} · Installed {relativeTime(installation.created_at)}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
          linked
        </span>
      </div>

      {/* Covered repos */}
      <div className="p-4">
        {repos.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
              App-covered repositories ({repos.length})
            </p>
            <div className="flex flex-col gap-1">
              <AnimatePresence>
                {repos.map((repo) => (
                  <AppCoveredRepoRow key={repo.id} fullName={repo.full_name} />
                ))}
              </AnimatePresence>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)]">
            <Info className="size-3.5 shrink-0" aria-hidden />
            No repositories covered yet — add repos to this installation via GitHub.
          </p>
        )}
      </div>
    </motion.div>
  );
}

// ── Empty / not-connected state ───────────────────────────────────────────────

function NoInstallations({ installUrl }: { installUrl: string | null }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-sm text-[var(--color-content-secondary)]">
      <div className="flex items-center gap-2">
        <Github className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <span className="font-medium text-[var(--color-content-primary)]">GitHub App not installed</span>
      </div>
      <p className="text-xs leading-relaxed text-[var(--color-content-secondary)]">
        Install the LoreKit GitHub App to automatically cover your repositories —
        no manual webhook secret needed. Each repo added to the App installation
        is covered instantly.
      </p>
      {installUrl ? (
        <InstallAppButton url={installUrl} label="Install GitHub App" />
      ) : (
        <p className="text-[10px] text-[var(--color-content-tertiary)]">
          The App is available once GITHUB_APP_ENABLED is set post-merge.
          See <code className="font-mono">docs/github-app.md</code> for the setup runbook.
        </p>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface GithubAppManagerProps {
  installations: GithubInstallation[];
  /**
   * Public "install this App" URL (github.com/apps/<slug>/installations/new),
   * or null when the App slug is not configured yet — see resolveGithubAppInstallUrl.
   */
  installUrl: string | null;
}

/**
 * GitHub App installation section for the webhooks settings page.
 *
 * Shows each linked installation with its covered repos.  App-covered repos
 * are visually distinct from manually secret-configured repos (which are
 * rendered by the adjacent WebhookSecretManager under the same SectionPanel).
 */
export function GithubAppManager({ installations, installUrl }: GithubAppManagerProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* Section label */}
      <div className="flex items-center gap-2">
        <Github className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
        <p className="text-xs font-semibold text-[var(--color-content-primary)]">
          GitHub App installations
        </p>
        <span className="rounded-full border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
          {installations.length}
        </span>
        {/* Add-repos action, shown beside the count once at least one install exists */}
        {installUrl && installations.length > 0 && (
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-content-secondary)] transition-colors hover:border-[var(--color-accent-glow)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          >
            <Plus className="size-3 shrink-0" aria-hidden />
            Add repositories
          </a>
        )}
      </div>

      {/* Installation cards or empty state */}
      {installations.length === 0 ? (
        <NoInstallations installUrl={installUrl} />
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {installations.map((inst) => (
              <InstallationCard key={inst.id} installation={inst} />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Visual distinction callout — only shown when repos exist */}
      {installations.some((i) => i.repositories.length > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          <p className="text-[10px] leading-relaxed text-[var(--color-content-tertiary)]">
            <span className="font-medium text-[var(--color-success)]">App-covered</span> repos
            use the single GitHub App webhook secret — no per-repo secret needed.
            Repos in the <span className="font-medium">&ldquo;Your repo secrets&rdquo;</span> section
            below use the manual per-repo setup (unaffected by the App).
          </p>
        </div>
      )}
    </div>
  );
}
