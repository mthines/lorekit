/**
 * Pure decision logic for binding GitHub App-covered repositories to LoreKit
 * Organizations — the functional core behind the installation card's
 * "share this repo's lore with an org" control.
 *
 * No I/O, no React. The impure shell (server actions `bindScope`/`unbindScope`
 * from `lib/scope-bindings.ts`, the fetch in the Settings → Integrations page)
 * lives elsewhere.
 * These helpers are node-vitest-tested, mirroring `lib/ownership.ts` /
 * `lib/org-ui.ts`.
 *
 * A repo binds under the canonical scope `repo::<owner>/<name>` (see
 * docs/scope-format.md); once bound, PR-webhook lore written under that scope is
 * routed to the org for write-capable members (00026_scope_org_bindings.sql).
 */

import { roleCapabilities } from './org-ui';
import type { OrgMembership } from './orgs';

/** Scope → the org it is bound to. The Integrations page builds this from `listScopeBindings`. */
export type BindingsByScope = Record<string, { orgId: string; orgSlug: string }>;

/** The canonical LoreKit scope string for a GitHub repo `full_name` (`owner/name`). */
export function repoScope(fullName: string): string {
  return `repo::${fullName.trim().toLowerCase()}`;
}

export interface BoundRepo {
  fullName: string;
  scope: string;
  orgId: string;
  orgSlug: string;
}

export interface UnboundRepo {
  fullName: string;
  scope: string;
}

export interface RepoBindingState {
  bound: BoundRepo[];
  unbound: UnboundRepo[];
}

/**
 * Split an installation's covered repos into already-bound (with their org) and
 * still-bindable, preserving input order within each group.
 */
export function partitionRepos(
  repos: ReadonlyArray<{ full_name: string }>,
  bindingsByScope: BindingsByScope,
): RepoBindingState {
  const bound: BoundRepo[] = [];
  const unbound: UnboundRepo[] = [];
  for (const repo of repos) {
    const scope = repoScope(repo.full_name);
    const binding = bindingsByScope[scope];
    if (binding) {
      bound.push({ fullName: repo.full_name, scope, orgId: binding.orgId, orgSlug: binding.orgSlug });
    } else {
      unbound.push({ fullName: repo.full_name, scope });
    }
  }
  return { bound, unbound };
}

/** The orgs the caller may bind scopes to (admin/owner — `manage_scopes`). */
export function manageableOrgs(orgs: ReadonlyArray<OrgMembership>): OrgMembership[] {
  return orgs.filter((org) => roleCapabilities[org.role].canManageScopes);
}

export type SuggestionReason = 'name-match' | 'only-org';

export interface BindingSuggestion {
  org: OrgMembership;
  /** The unbound repo `full_name`s the suggestion would bind. */
  repos: string[];
  reason: SuggestionReason;
}

/**
 * Propose which LoreKit Organization to bind an installation's still-unbound
 * repos to, or `null` when there is nothing worth suggesting.
 *
 * Rules (least surprising first):
 *   - Nothing unbound, or no org the caller can manage → no suggestion.
 *   - A manageable org whose slug equals the installation's GitHub account login
 *     (e.g. GitHub org `acme` ↔ LoreKit org `acme`) → suggest it (`name-match`).
 *   - Otherwise, if the caller manages exactly one org → suggest it (`only-org`).
 *   - Multiple manageable orgs with no name match → no suggestion; the user picks
 *     explicitly rather than have one guessed for them.
 */
export function bindingSuggestion(
  installation: { github_account_login: string },
  manageable: ReadonlyArray<OrgMembership>,
  state: RepoBindingState,
): BindingSuggestion | null {
  if (state.unbound.length === 0 || manageable.length === 0) return null;

  const repos = state.unbound.map((r) => r.fullName);
  const login = installation.github_account_login.trim().toLowerCase();

  const nameMatch = manageable.find((org) => org.slug.toLowerCase() === login);
  if (nameMatch) return { org: nameMatch, repos, reason: 'name-match' };

  if (manageable.length === 1) return { org: manageable[0], repos, reason: 'only-org' };

  return null;
}
