'use client';

/**
 * GitHub App installation manager — dashboard section.
 *
 * Displays the current user's linked GitHub App installations and the
 * repositories each covers, and lets an org admin/owner share a covered repo's
 * lore with a LoreKit Organization by binding its `repo::owner/name` scope
 * (reusing lib/scope-bindings.ts — no new backend). App-covered repos are
 * visually distinguished from the manual per-repo webhook secret setup.
 *
 * Installation lifecycle (add/remove repos, suspend, uninstall) still happens on
 * GitHub via the "Manage" link — only the repo→org binding is done in LoreKit.
 *
 * The binding decision logic is the pure, node-tested lib/github-app-bindings.ts
 * (functional core); this component is the impure shell (React state + the
 * bindScope/unbindScope server actions).
 */

import { useEffect, useId, useMemo, useState, useTransition, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Github,
  GitBranch,
  Building2,
  User,
  CircleCheck,
  Info,
  Settings2,
  ExternalLink,
  Link as LinkIcon,
  X,
  Loader2,
  Search,
} from 'lucide-react';
import type { GithubInstallation } from '@/lib/github-installations';
import type { OrgMembership } from '@/lib/orgs';
import { bindScope, unbindScope } from '@/lib/scope-bindings';
import { useToast } from '@/components/providers/ToastProvider';
import {
  partitionRepos,
  bindingSuggestion,
  repoScope,
  type BindingsByScope,
  type BindingSuggestion,
  type UnboundRepo,
} from '@/lib/github-app-bindings';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Install link — sends the user to the App's public installation page ──────

/**
 * Anchor to GitHub's public "install this App" page. Renders only when an
 * install URL is configured (NEXT_PUBLIC_GITHUB_APP_SLUG is set); callers pass
 * `null` otherwise.
 *
 * One component, two variants, so the new-tab semantics (target / rel / the
 * screen-reader cue) live in exactly one place and can't drift:
 *   - `primary` — the empty-state "Install GitHub App" call to action.
 *   - `ghost`   — the quieter "Manage" action beside the count when an
 *                 installation already exists (the same page manages both).
 */
function AppInstallLink({
  url,
  label,
  variant,
  icon,
}: {
  url: string;
  label: string;
  variant: 'primary' | 'ghost';
  icon: ReactNode;
}) {
  const focusRing =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]';
  const variantClass =
    variant === 'primary'
      ? 'gap-2 border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-3.5 py-2 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent)]/15'
      : 'ml-auto gap-1.5 border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-content-secondary)] hover:border-[var(--color-accent-glow)] hover:text-[var(--color-accent)]';
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-11 items-center rounded-lg font-medium transition-colors ${variantClass} ${focusRing}`}
    >
      {icon}
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
      {variant === 'primary' && (
        <ExternalLink className="size-3 shrink-0 opacity-70" aria-hidden />
      )}
    </a>
  );
}

// ── Repo row — one App-covered repository, with its binding state ─────────────

function AppCoveredRepoRow({
  fullName,
  boundOrgSlug,
  onUnbind,
  busy,
}: {
  fullName: string;
  /** The LoreKit org this repo's scope is bound to, or undefined when unbound. */
  boundOrgSlug?: string;
  /** Present only when the caller can manage the bound org (admin/owner). */
  onUnbind?: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <GitBranch className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-content-primary)]">
        {fullName}
      </span>
      {boundOrgSlug ? (
        <div className="flex items-center gap-1">
          <span className="flex items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
            <LinkIcon className="size-3" aria-hidden />
            {boundOrgSlug}
          </span>
          {onUnbind && (
            <button
              type="button"
              onClick={onUnbind}
              disabled={busy}
              aria-label={`Unshare ${fullName} from ${boundOrgSlug}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      ) : (
        <span
          title="Covered by GitHub App — no manual webhook secret required"
          className="flex items-center gap-1 rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]"
        >
          <CircleCheck className="size-3" aria-hidden />
          App-covered
        </span>
      )}
    </div>
  );
}

// ── Bind panel — select unbound repos + a LoreKit org, then bind ─────────────

function RepoBindingPanel({
  unbound,
  manageableOrgs,
  suggestion,
  busy,
  onBind,
}: {
  unbound: UnboundRepo[];
  manageableOrgs: OrgMembership[];
  suggestion: BindingSuggestion | null;
  busy: boolean;
  onBind: (orgId: string, fullNames: string[]) => void;
}) {
  const [targetOrgId, setTargetOrgId] = useState(suggestion?.org.id ?? manageableOrgs[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const orgSelectId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? unbound.filter((r) => r.fullName.toLowerCase().includes(q)) : unbound;
  }, [unbound, query]);

  // Once a repo is bound it leaves `unbound`; drop it from `selected` too so the
  // "Bind N selected" count stays truthful and a second click can't re-submit an
  // already-bound scope.
  const unboundNames = useMemo(() => new Set(unbound.map((r) => r.fullName)), [unbound]);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((name) => unboundNames.has(name)));
      return next.size === prev.size ? prev : next;
    });
  }, [unboundNames]);

  function toggle(fullName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      {/* One-click suggestion */}
      {suggestion && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-3 py-2.5 sm:flex-row sm:items-center">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-accent)] sm:mt-0" aria-hidden />
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-[var(--color-content-secondary)]">
            Share {suggestion.repos.length} repo{suggestion.repos.length === 1 ? '' : 's'} with{' '}
            <span className="font-medium text-[var(--color-content-primary)]">{suggestion.org.name}</span>
            {suggestion.reason === 'name-match' ? ' (name match)' : ''}? PR lore will route to the org.
          </p>
          <button
            type="button"
            onClick={() => onBind(suggestion.org.id, suggestion.repos)}
            disabled={busy}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <LinkIcon className="size-3.5" aria-hidden />}
            Bind all
          </button>
        </div>
      )}

      {/* Manual selection */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={orgSelectId} className="text-[11px] text-[var(--color-content-secondary)]">
            Share selected repos with
          </label>
          <select
            id={orgSelectId}
            value={targetOrgId}
            onChange={(e) => setTargetOrgId(e.target.value)}
            className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-content-primary)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            {manageableOrgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>

        {unbound.length > 8 && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5">
            <Search className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repos…"
              aria-label="Filter repositories"
              className="min-h-11 w-full bg-transparent text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:outline-none"
            />
          </div>
        )}

        <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
          {filtered.map((repo) => (
            <label
              key={repo.fullName}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--color-bg-elevated)]"
            >
              <input
                type="checkbox"
                checked={selected.has(repo.fullName)}
                onChange={() => toggle(repo.fullName)}
                className="size-4 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-content-secondary)]">
                {repo.fullName}
              </span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-[var(--color-content-tertiary)]">No matching repos.</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onBind(targetOrgId, [...selected])}
          disabled={busy || selected.size === 0 || !targetOrgId}
          className="flex min-h-11 items-center justify-center gap-1.5 self-start rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" aria-hidden />}
          Bind {selected.size > 0 ? `${selected.size} ` : ''}selected
        </button>
      </div>
    </div>
  );
}

// ── Installation card ─────────────────────────────────────────────────────────

function InstallationCard({
  installation,
  manageableOrgs,
  bindingsByScope,
}: {
  installation: GithubInstallation;
  manageableOrgs: OrgMembership[];
  bindingsByScope: BindingsByScope;
}) {
  const AccountIcon = installation.account_type === 'Organization' ? Building2 : User;
  const repos = installation.repositories;
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  // Local, optimistic view of the bindings so badges update without a round-trip
  // (the server actions revalidate '/settings' for the next full load).
  const [localBindings, setLocalBindings] = useState<BindingsByScope>(bindingsByScope);
  const manageableIds = useMemo(() => new Set(manageableOrgs.map((o) => o.id)), [manageableOrgs]);

  const state = useMemo(() => partitionRepos(repos, localBindings), [repos, localBindings]);
  const suggestion = useMemo(
    () => bindingSuggestion(installation, manageableOrgs, state),
    [installation, manageableOrgs, state],
  );
  const boundByFullName = useMemo(
    () => new Map(state.bound.map((b) => [b.fullName, b])),
    [state.bound],
  );

  function doBind(orgId: string, fullNames: string[]) {
    const org = manageableOrgs.find((o) => o.id === orgId);
    if (!org || fullNames.length === 0) return;
    startTransition(async () => {
      // `.catch` per call so a transport-level rejection becomes a `{ error }`
      // result rather than rejecting Promise.all (which would escape the
      // transition to the error boundary instead of showing a toast). Partial
      // success is preserved — one repo failing never drops the rest.
      const results = await Promise.all(
        fullNames.map((fullName) =>
          bindScope(orgId, repoScope(fullName))
            .then((r) => ({ fullName, result: r }))
            .catch(() => ({ fullName, result: { error: 'Network error — please retry.' } })),
        ),
      );
      const ok = results.filter((x) => !('error' in x.result));
      const failed = results.filter((x) => 'error' in x.result);

      if (ok.length > 0) {
        setLocalBindings((prev) => {
          const next = { ...prev };
          for (const x of ok) next[repoScope(x.fullName)] = { orgId, orgSlug: org.slug };
          return next;
        });
        showToast(`${ok.length} repo${ok.length === 1 ? '' : 's'} shared with ${org.name}.`, 'success');
      }
      if (failed.length > 0) {
        const first = failed[0].result as { error: string };
        showToast(first.error, 'error');
      }
    });
  }

  function doUnbind(fullName: string, orgId: string) {
    startTransition(async () => {
      let error: string | undefined;
      try {
        ({ error } = await unbindScope(orgId, repoScope(fullName)));
      } catch {
        // Transport failure — the server action rejected rather than returning
        // an { error }. Surface it as a toast, never the error boundary.
        error = 'Network error — please retry.';
      }
      if (error) {
        showToast(error, 'error');
        return;
      }
      setLocalBindings((prev) => {
        const next = { ...prev };
        delete next[repoScope(fullName)];
        return next;
      });
      showToast(`${fullName} unshared.`, 'success');
    });
  }

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

      {/* Covered repos + binding */}
      <div className="flex flex-col gap-3 p-4">
        {repos.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
              App-covered repositories ({repos.length})
            </p>
            <div className="flex flex-col gap-1">
              <AnimatePresence>
                {repos.map((repo) => {
                  const bound = boundByFullName.get(repo.full_name);
                  return (
                    <AppCoveredRepoRow
                      key={repo.id}
                      fullName={repo.full_name}
                      boundOrgSlug={bound?.orgSlug}
                      busy={pending}
                      onUnbind={
                        bound && manageableIds.has(bound.orgId)
                          ? () => doUnbind(repo.full_name, bound.orgId)
                          : undefined
                      }
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)]">
            <Info className="size-3.5 shrink-0" aria-hidden />
            No repositories covered yet — add repos to this installation via GitHub.
          </p>
        )}

        {/* Binding control (only when there is something to bind and somewhere to bind it) */}
        {manageableOrgs.length > 0 && state.unbound.length > 0 && (
          <RepoBindingPanel
            unbound={state.unbound}
            manageableOrgs={manageableOrgs}
            suggestion={suggestion}
            busy={pending}
            onBind={doBind}
          />
        )}

        {/* No org to bind to — point the user at where to make one */}
        {manageableOrgs.length === 0 && repos.length > 0 && (
          <p className="flex items-start gap-1.5 border-t border-[var(--color-border)] pt-3 text-[10px] leading-relaxed text-[var(--color-content-tertiary)]">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Create an organization under{' '}
            <span className="font-medium text-[var(--color-content-secondary)]">Settings → Organization</span>{' '}
            to share these repos&rsquo; PR lore with your team.
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
        <AppInstallLink
          url={installUrl}
          label="Install GitHub App"
          variant="primary"
          icon={<Github className="size-3.5 shrink-0" aria-hidden />}
        />
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
  /**
   * LoreKit organizations the caller can bind scopes to (admin/owner). Already
   * filtered by the page via `manageableOrgs`; empty when the user manages none.
   */
  manageableOrgs?: OrgMembership[];
  /** Scope → bound org, across the caller's orgs. Empty when nothing is bound. */
  bindingsByScope?: BindingsByScope;
}

/**
 * GitHub App installation section for Settings → Integrations.
 *
 * Shows each linked installation with its covered repos, and lets an org
 * admin/owner share a repo's lore with a LoreKit Organization.  App-covered
 * repos are visually distinct from manually secret-configured repos (which are
 * rendered by the adjacent WebhookSecretManager under the same SectionPanel).
 */
export function GithubAppManager({
  installations,
  installUrl,
  manageableOrgs = [],
  bindingsByScope = {},
}: GithubAppManagerProps) {
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
        {/* Manage action — opens the App's config page (add/remove repos, suspend,
            uninstall). Shown beside the count once at least one install exists. */}
        {installUrl && installations.length > 0 && (
          <AppInstallLink
            url={installUrl}
            label="Manage"
            variant="ghost"
            icon={<Settings2 className="size-3 shrink-0" aria-hidden />}
          />
        )}
      </div>

      {/* Installation cards or empty state */}
      {installations.length === 0 ? (
        <NoInstallations installUrl={installUrl} />
      ) : (
        <div className="flex flex-col gap-3">
          <AnimatePresence>
            {installations.map((inst) => (
              <InstallationCard
                key={inst.id}
                installation={inst}
                manageableOrgs={manageableOrgs}
                bindingsByScope={bindingsByScope}
              />
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
            Bind a repo to an <span className="font-medium text-[var(--color-accent)]">organization</span>{' '}
            to share its PR lore with your team.
          </p>
        </div>
      )}
    </div>
  );
}
