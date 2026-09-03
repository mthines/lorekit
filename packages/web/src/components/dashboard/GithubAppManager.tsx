'use client';

/**
 * GitHub App installation manager — dashboard section.
 *
 * Displays the current user's linked GitHub App installations and the
 * repositories each covers, and lets an org admin/owner share a covered repo's
 * lore with a LoreKit Organization by binding its `repo::owner/name` scope
 * (reusing lib/scope-bindings.ts — no new backend). It is the only card on
 * Settings → Integrations.
 *
 * Installation lifecycle (add/remove repos, suspend, uninstall) still happens on
 * GitHub via the "Manage" link — only the repo→org binding is done in LoreKit.
 *
 * The binding decision logic is the pure, node-tested lib/github-app-bindings.ts
 * (functional core); this component is the impure shell (React state + the
 * bindScope/unbindScope server actions).
 */

import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Github,
  GitBranch,
  Building2,
  User,
  ShieldCheck,
  Info,
  Settings2,
  ExternalLink,
  Link as LinkIcon,
  X,
  Search,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import type { GithubInstallation } from '@/lib/github-installations';
import type { OrgMembership } from '@/lib/orgs';
import { bindScope, unbindScope } from '@/lib/scope-bindings';
import { showToast } from '@/lib/toast';
import { Button } from '@/components/ui/Button';
import {
  partitionRepos,
  bindingSuggestion,
  repoScope,
  type BindingsByScope,
  type BindingSuggestion,
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

// ── Suggestion banner — the one-click "share all" nudge ──────────────────────

function SuggestionBanner({
  suggestion,
  busy,
  onBind,
}: {
  suggestion: BindingSuggestion;
  busy: boolean;
  onBind: (orgId: string, fullNames: string[]) => void;
}) {
  const count = suggestion.repos.length;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] p-3 sm:flex-row sm:items-center sm:gap-3">
      <Sparkles className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--color-content-secondary)]">
        Share {count === 1 ? 'this repository' : `all ${count} repositories`} with{' '}
        <span className="font-medium text-[var(--color-content-primary)]">{suggestion.org.name}</span>?
        Their PR review comments become {suggestion.org.name} memories.
      </p>
      <Button
        variant="primary"
        size="sm"
        className="shrink-0"
        analyticsId="github-app.share-all"
        onClick={() => onBind(suggestion.org.id, suggestion.repos)}
        isLoading={busy}
        leftIcon={<LinkIcon className="size-3.5" aria-hidden />}
      >
        Share all
      </Button>
    </div>
  );
}

// ── Repository row — display, plus a selection control when it's bindable ─────

function RepoRow({
  fullName,
  boundOrgSlug,
  selectable,
  selected,
  onToggle,
  onUnbind,
  busy,
}: {
  fullName: string;
  /** The LoreKit org this repo's scope is bound to, or undefined when unbound. */
  boundOrgSlug?: string;
  /** Unbound + the caller manages at least one org → the row is a select target. */
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  /** Present only when the caller can manage the bound org (admin/owner). */
  onUnbind?: () => void;
  busy: boolean;
}) {
  const name = (
    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-content-primary)]">
      {fullName}
    </span>
  );

  // Selectable (unbound) rows: the whole row is a checkbox label with a clear
  // selected state so multi-select reads at a glance.
  if (selectable) {
    return (
      <label
        className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
          selected
            ? 'border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)]/60'
            : 'border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-content-tertiary)] hover:bg-[var(--color-bg-elevated)]'
        }`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="size-4 shrink-0 rounded accent-[var(--color-accent)]"
        />
        {name}
      </label>
    );
  }

  // Static rows: covered-but-not-shared (icon only) or shared (org chip + unbind).
  return (
    <div className="flex min-h-11 items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      {/* size-4 matches the selectable row's checkbox so both start the name column at the same offset. */}
      <GitBranch className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
      {name}
      {boundOrgSlug && (
        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-accent-subtle)] py-0.5 pl-2 pr-1 text-[11px] font-medium text-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent-glow)]">
          <LinkIcon className="size-3 shrink-0" aria-hidden />
          {boundOrgSlug}
          {onUnbind && (
            <button
              type="button"
              onClick={onUnbind}
              disabled={busy}
              aria-label={`Stop sharing ${fullName} with ${boundOrgSlug}`}
              className="ml-0.5 flex size-6 items-center justify-center rounded-full text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20 disabled:opacity-50"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// ── Bind action bar — pick a target org, share the selected repos ────────────

function BindActionBar({
  manageableOrgs,
  targetOrgId,
  onTargetChange,
  selectedCount,
  busy,
  onBind,
  orgSelectId,
}: {
  manageableOrgs: OrgMembership[];
  targetOrgId: string;
  onTargetChange: (id: string) => void;
  selectedCount: number;
  busy: boolean;
  onBind: () => void;
  orgSelectId: string;
}) {
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <label htmlFor={orgSelectId} className="shrink-0 text-[11px] text-[var(--color-content-secondary)]">
          Share with
        </label>
        <div className="relative flex-1 sm:flex-initial">
          <select
            id={orgSelectId}
            value={targetOrgId}
            onChange={(e) => onTargetChange(e.target.value)}
            className="min-h-11 w-full appearance-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-2 pl-3 pr-9 text-xs text-[var(--color-content-primary)] transition-colors hover:border-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            {manageableOrgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-content-tertiary)]"
            aria-hidden
          />
        </div>
      </div>
      <Button
        variant="primary"
        analyticsId="github-app.bind"
        onClick={onBind}
        disabled={busy || selectedCount === 0 || !targetOrgId}
        isLoading={busy}
        leftIcon={<LinkIcon className="size-4" aria-hidden />}
      >
        {selectedCount === 0 ? 'Select repos to share' : `Share ${selectedCount}`}
      </Button>
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
  const [pending, startTransition] = useTransition();
  const orgSelectId = useId();

  // Local, optimistic view of the bindings so badges update without a round-trip.
  // Seeding from the prop once is correct here: the parent is a server component,
  // so it never re-renders in place — `bindScope`/`unbindScope` call
  // revalidatePath, and the fresh prop only arrives on the next navigation, which
  // remounts this subtree and re-seeds. In-session updates are the optimistic ones.
  const [localBindings, setLocalBindings] = useState<BindingsByScope>(bindingsByScope);
  const canManage = manageableOrgs.length > 0;
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

  // Bind-form state: the target org (defaulting to the suggestion), the current
  // multi-selection, and the filter query over the one unified repo list.
  const [targetOrgId, setTargetOrgId] = useState(() => suggestion?.org.id ?? manageableOrgs[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  // Progressive disclosure: the card is a calm read-only coverage list by
  // default; the org-picker + multi-select "share" controls stay hidden until
  // the user opts in, so the three jobs (see coverage / see what's shared /
  // share more) don't crowd each other.
  const [sharing, setSharing] = useState(false);

  // Once a repo is bound it leaves `unbound`; prune it from `selected` so the
  // "Share N" count stays truthful and a second click can't re-submit it.
  const unboundNames = useMemo(() => new Set(state.unbound.map((r) => r.fullName)), [state.unbound]);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((name) => unboundNames.has(name)));
      return next.size === prev.size ? prev : next;
    });
  }, [unboundNames]);

  const visibleRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? repos.filter((r) => r.full_name.toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  function toggle(fullName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  // Keep keyboard focus with the disclosure: entering share mode focuses the org
  // picker, leaving it returns focus to the entry button — never dropping to
  // <body>. Skip the mount run so we don't steal focus on first paint.
  const shareEntryRef = useRef<HTMLButtonElement>(null);
  const focusOnMount = useRef(true);
  useEffect(() => {
    if (focusOnMount.current) {
      focusOnMount.current = false;
      return;
    }
    if (sharing) document.getElementById(orgSelectId)?.focus();
    else shareEntryRef.current?.focus();
  }, [sharing, orgSelectId]);

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
          <p className="text-[11px] text-[var(--color-content-secondary)]">
            {installation.account_type} · Installed {relativeTime(installation.created_at)}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--color-success)]">
          linked
        </span>
      </div>

      {/* Covered repos + binding */}
      <div className="flex flex-col gap-3 p-4">
        {repos.length > 0 ? (
          <>
            {/* Section header: coverage stated once, plus a live shared count */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-content-secondary)]">
                Repositories
              </p>
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-content-secondary)]">
                <ShieldCheck className="size-3.5 shrink-0 text-[var(--color-success)]" aria-hidden />
                {repos.length} covered{state.bound.length > 0 ? ` · ${state.bound.length} shared` : ''}
              </span>
            </div>

            {repos.length > 8 && (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 focus-within:border-[var(--color-accent)]">
                <Search className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter repositories…"
                  aria-label="Filter repositories"
                  className="min-h-11 w-full bg-transparent text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:outline-none"
                />
              </div>
            )}

            <div className="-mr-1 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
              {visibleRepos.map((repo) => {
                const bound = boundByFullName.get(repo.full_name);
                return (
                  <RepoRow
                    key={repo.id}
                    fullName={repo.full_name}
                    boundOrgSlug={bound?.orgSlug}
                    selectable={sharing && canManage && !bound}
                    selected={selected.has(repo.full_name)}
                    onToggle={() => toggle(repo.full_name)}
                    onUnbind={
                      bound && manageableIds.has(bound.orgId)
                        ? () => doUnbind(repo.full_name, bound.orgId)
                        : undefined
                    }
                    busy={pending}
                  />
                );
              })}
              {visibleRepos.length === 0 && (
                <p className="px-1 py-2 text-[11px] text-[var(--color-content-secondary)]">
                  No repositories match &ldquo;{query}&rdquo;.
                </p>
              )}
            </div>

            {/* Read mode: the suggestion nudge (if any) stays visible here so
                users who haven't shared yet see it, plus one entry into manual
                multi-select. */}
            {canManage && !sharing && state.unbound.length > 0 && (
              <div className="flex flex-col gap-2">
                {suggestion && (
                  <SuggestionBanner suggestion={suggestion} busy={pending} onBind={doBind} />
                )}
                <Button
                  ref={shareEntryRef}
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  analyticsId="github-app.share-open"
                  onClick={() => setSharing(true)}
                  leftIcon={<LinkIcon className="size-3.5 shrink-0" aria-hidden />}
                >
                  {suggestion ? 'Choose specific repos to share' : 'Share repositories with an organization'}
                </Button>
              </div>
            )}

            {/* Select mode: the org picker + multi-select controls, revealed on demand */}
            {canManage && sharing && (
              <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
                <BindActionBar
                  manageableOrgs={manageableOrgs}
                  targetOrgId={targetOrgId}
                  onTargetChange={setTargetOrgId}
                  selectedCount={selected.size}
                  busy={pending}
                  onBind={() => doBind(targetOrgId, [...selected])}
                  orgSelectId={orgSelectId}
                />
                {/* Exit only — bindings apply on Share, so leaving keeps any
                    in-progress selection rather than silently discarding it. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  analyticsId="github-app.share-done"
                  onClick={() => setSharing(false)}
                >
                  Done
                </Button>
              </div>
            )}

            {/* No org to share with — point the user at where to make one */}
            {!canManage && (
              <p className="flex items-start gap-1.5 border-t border-[var(--color-border)] pt-3 text-[11px] leading-relaxed text-[var(--color-content-secondary)]">
                <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                Create an organization under{' '}
                <span className="font-medium text-[var(--color-content-primary)]">Settings → Organization</span>{' '}
                to share these repositories&rsquo; PR review comments with your team.
              </p>
            )}
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-content-secondary)]">
            <Info className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
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
 * admin/owner share a repo's lore with a LoreKit Organization.
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
        <span className="rounded-full border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--color-accent)]">
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

      {/* How-it-works callout — only shown when repos exist */}
      {installations.some((i) => i.repositories.length > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          <p className="text-[11px] leading-relaxed text-[var(--color-content-secondary)]">
            Covered repos need no per-repo webhook secret. Share one with an{' '}
            <span className="font-medium text-[var(--color-accent)]">organization</span> and its
            PR review comments become shared team memories instead of personal ones.
          </p>
        </div>
      )}
    </div>
  );
}
