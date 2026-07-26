'use client';

/**
 * OrganizationManager — the Organization settings client UI. Mirrors
 * `WebhookSecretManager`/`TokenManager`: motion-enter rows, `EmptyState` for
 * the zero state, `min-h-11` targets, CSS-var theming, `useTransition` around
 * every server-action call. Owns create / switch / member-list / invite /
 * pending-invites / role-change / remove / leave / delete — all against the
 * EXISTING `orgs.ts`/`org-invites.ts` server actions (plan.md Requirement 7),
 * plus the Phase 4 `org-members.ts` addition for real member identities.
 *
 * Role → UI-affordance gating reads exclusively from `roleCapabilities` /
 * `canActOnOrgMember` (org-ui.ts) — no bare `role === '...'` checks in this
 * file (plan.md Decision D4 / AC-10).
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, Plus, Loader2, Mail, X, LogOut, Trash2, Download, Link, Unlink } from 'lucide-react';
import {
  createOrg,
  listMembers,
  removeMember,
  changeMemberRole,
  leaveOrg,
  deleteOrg,
  exportOrgLore,
  type OrgMembership,
  type OrgMember,
  type OrgRole,
} from '@/lib/orgs';
import { inviteMember, listInvites, revokeInvite, type OrgInvite } from '@/lib/org-invites';
import { listMemberIdentities, type OrgMemberIdentity } from '@/lib/org-members';
import { listScopeBindings, listAvailableScopes, bindScope, unbindScope, type ScopeBinding } from '@/lib/scope-bindings';
import { normalizeSlug } from '@/lib/org-slug';
import { roleCapabilities, canActOnOrgMember, classifyInviteInput, ORG_DELETE_RETENTION_DAYS } from '@/lib/org-ui';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/providers/ToastProvider';

const ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

// Only render an avatar <img> when the URL is a GitHub avatar host. The handle
// and avatar come from `auth.users.raw_user_meta_data` (OAuth-provider-set, not
// user-editable via our app), but gating the `src` on a known host is a cheap
// defense-in-depth: a value that ever became attacker-controlled still can't
// point the browser at an arbitrary origin. Anything else falls back to the
// placeholder glyph.
function isTrustedAvatarUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).hostname === 'avatars.githubusercontent.com';
  } catch {
    return false;
  }
}

const ASSIGNABLE_ROLE_HELPER: Record<Exclude<OrgRole, 'owner'>, string> = {
  admin: 'Manages members and org settings.',
  member: 'Reads and writes shared lore.',
  viewer: 'Reads shared lore only.',
};

const ASSIGNABLE_ROLE_OPTIONS = (
  <>
    <option value="admin">Admin</option>
    <option value="member">Member</option>
    <option value="viewer">Viewer</option>
  </>
);

type ConfirmState =
  | { kind: 'leave' }
  | { kind: 'delete' }
  | { kind: 'revoke'; invite: OrgInvite }
  | { kind: 'remove'; member: OrgMember; label: string }
  | { kind: 'unbind'; binding: ScopeBinding };

// ── Create-org form ───────────────────────────────────────────────────────────

function CreateOrgForm({
  onCreated,
  onCancel,
}: {
  onCreated: (orgId: string, membership: OrgMembership) => void;
  onCancel?: () => void;
}) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Organization name is required');
      return;
    }
    const normalizedSlug = normalizeSlug(slug);
    if (!normalizedSlug) {
      setError('Invalid organization slug — use 2–48 lowercase letters, digits, or dashes.');
      return;
    }

    startTransition(async () => {
      const result = await createOrg(normalizedSlug, name.trim());
      if ('error' in result) {
        setError(result.error);
        return;
      }
      const trimmedName = name.trim();
      onCreated(result.orgId, {
        id: result.orgId,
        slug: normalizedSlug,
        name: trimmedName,
        role: 'owner',
        created_at: new Date().toISOString(),
      });
      showToast(`${trimmedName} created — you're the owner.`, 'success');
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
    >
      <p className="text-xs font-medium text-[var(--color-content-secondary)]">Create an organization</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="org-name" className="text-xs text-[var(--color-content-secondary)]">
          Organization name
        </label>
        <input
          id="org-name"
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Team"
          maxLength={100}
          required
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="org-slug" className="text-xs text-[var(--color-content-secondary)]">
          Organization slug
        </label>
        <input
          id="org-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="acme-team"
          maxLength={48}
          required
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-content-primary)] placeholder:font-sans placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <p className="text-[10px] text-[var(--color-content-tertiary)]">
          2–48 lowercase letters, digits, or dashes. Used in URLs.
        </p>
      </div>

      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !name.trim() || !slug.trim()}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Create
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ── Invite form ───────────────────────────────────────────────────────────────

function InviteForm({ orgId, orgName, onInvited }: { orgId: string; orgName: string; onInvited: (invite: OrgInvite) => void }) {
  const { showToast } = useToast();
  const [input, setInput] = useState('');
  const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('member');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const classified = classifyInviteInput(input);
    if (classified.kind === 'empty') {
      setError('An email or GitHub handle is required');
      return;
    }

    startTransition(async () => {
      const result = await inviteMember(orgId, classified.value, role, orgName);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      onInvited({
        id: result.inviteId,
        org_id: orgId,
        invitee_email: classified.kind === 'email' ? classified.value : null,
        invitee_handle: classified.kind === 'handle' ? classified.value : null,
        role,
        status: 'pending',
        invited_by: null,
        created_at: new Date().toISOString(),
        responded_at: null,
        expires_at: null,
      });
      showToast(`Invite sent to ${classified.value}.`, 'success');
      setInput('');
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
    >
      <p className="text-xs font-medium text-[var(--color-content-secondary)]">Invite a teammate</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="invite-input" className="text-xs text-[var(--color-content-secondary)]">
          GitHub handle or email
        </label>
        <input
          id="invite-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="octocat or octocat@example.com"
          maxLength={200}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <p className="text-[10px] text-[var(--color-content-tertiary)]">
          They&apos;ll see this invite next time they sign in.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="invite-role" className="text-xs text-[var(--color-content-secondary)]">
          Role
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as Exclude<OrgRole, 'owner'>)}
          className="min-h-11 w-full max-w-[10rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-content-primary)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          {ASSIGNABLE_ROLE_OPTIONS}
        </select>
        <p className="text-[10px] text-[var(--color-content-tertiary)]">{ASSIGNABLE_ROLE_HELPER[role]}</p>
      </div>

      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Send invite
        </button>
      </div>
    </form>
  );
}

// ── Bind-scope form ───────────────────────────────────────────────────────────

interface BindScopeFormProps {
  orgId: string;
  orgName: string;
  /** Scopes visible to the user that are not yet bound to this org — shown as clickable suggestions. */
  availableScopes: string[];
  onBound: (binding: ScopeBinding) => void;
}

function BindScopeForm({ orgId, orgName, availableScopes, onBound }: BindScopeFormProps) {
  const { showToast } = useToast();
  const [scope, setScope] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  /** Bind the given scope string (already trimmed + lowercased by the caller). */
  function doBindScope(normalized: string) {
    setError('');
    startTransition(async () => {
      const result = await bindScope(orgId, normalized);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      onBound({
        id: result.id,
        org_id: orgId,
        scope: normalized,
        created_by: null,
        created_at: new Date().toISOString(),
      });
      showToast(`Scope ${normalized} bound to ${orgName}.`, 'success');
      setScope('');
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = scope.trim().toLowerCase();
    if (!trimmed) {
      setError('Scope is required');
      return;
    }
    doBindScope(trimmed);
  }

  // Filter suggestions by what the user has typed so far (substring match).
  const inputLower = scope.trim().toLowerCase();
  const suggestions = inputLower
    ? availableScopes.filter((s) => s.includes(inputLower))
    : availableScopes;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
    >
      <p className="text-xs font-medium text-[var(--color-content-secondary)]">Bind a scope</p>
      <p className="text-[10px] text-[var(--color-content-tertiary)]">
        Memories written under this scope are automatically shared with {orgName} for write-capable members.
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor="bind-scope" className="text-xs text-[var(--color-content-secondary)]">
          Scope (e.g. <code className="font-mono">repo::owner/name</code>)
        </label>
        <input
          id="bind-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="repo::owner/name"
          maxLength={500}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-content-primary)] placeholder:font-mono placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>

      {/* Scope suggestions — clickable chips that immediately trigger the bind. */}
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] text-[var(--color-content-tertiary)]">
            {inputLower ? 'Matching scopes' : 'Your existing scopes'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 20).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => doBindScope(s)}
                disabled={pending}
                className="flex min-h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                <Link className="size-3 shrink-0" aria-hidden />
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}

      <button
        type="submit"
        disabled={pending || !scope.trim()}
        className="flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Link className="size-4" aria-hidden />}
        Bind scope
      </button>
    </form>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface OrganizationManagerProps {
  initialOrgs: OrgMembership[];
  currentUserId: string;
}

export function OrganizationManager({ initialOrgs, currentUserId }: OrganizationManagerProps) {
  const { showToast } = useToast();
  const [orgs, setOrgs] = useState<OrgMembership[]>(initialOrgs);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(initialOrgs[0]?.id ?? null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [identities, setIdentities] = useState<OrgMemberIdentity[]>([]);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [bindings, setBindings] = useState<ScopeBinding[]>([]);
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [loadingOrgData, setLoadingOrgData] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(initialOrgs.length === 0);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId) ?? null;
  const myRole = selectedOrg?.role ?? null;
  const caps = myRole ? roleCapabilities[myRole] : null;

  // Load member/identity/invite data whenever the selected org changes.
  useEffect(() => {
    if (!selectedOrgId) {
      setMembers([]);
      setIdentities([]);
      setInvites([]);
      setBindings([]);
      setAvailableScopes([]);
      return;
    }
    let cancelled = false;
    setLoadingOrgData(true);
    (async () => {
      // Fetch bindings first so listAvailableScopes can exclude already-bound ones.
      const binds = await listScopeBindings(selectedOrgId);
      if (cancelled) return;
      const boundScopes = binds.map((b) => b.scope);
      const [m, ids, inv, scopes] = await Promise.all([
        listMembers(selectedOrgId),
        listMemberIdentities(selectedOrgId),
        listInvites(selectedOrgId),
        listAvailableScopes(selectedOrgId, boundScopes),
      ]);
      if (cancelled) return;
      setMembers(m);
      setIdentities(ids);
      setInvites(inv);
      setBindings(binds);
      setAvailableScopes(scopes);
      setLoadingOrgData(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  function handleCreated(orgId: string, membership: OrgMembership) {
    setOrgs((prev) => [...prev, membership]);
    setSelectedOrgId(orgId);
    setShowCreateForm(false);
  }

  function handleLeave() {
    if (!selectedOrgId) return;
    startTransition(async () => {
      const result = await leaveOrg(selectedOrgId);
      setConfirm(null);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setOrgs((prev) => {
        const next = prev.filter((o) => o.id !== selectedOrgId);
        setSelectedOrgId(next[0]?.id ?? null);
        return next;
      });
      showToast('You left the organization.', 'success');
    });
  }

  function handleDelete() {
    if (!selectedOrgId) return;
    startTransition(async () => {
      const result = await deleteOrg(selectedOrgId);
      setConfirm(null);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setOrgs((prev) => {
        const next = prev.filter((o) => o.id !== selectedOrgId);
        setSelectedOrgId(next[0]?.id ?? null);
        return next;
      });
      showToast(`Organization deleted — recoverable for ${ORG_DELETE_RETENTION_DAYS} days.`, 'success');
    });
  }

  // Download the org's shared lore as JSON — offered before delete so an owner
  // can keep a copy. Browser-only (Blob + object URL), no server round-trip
  // beyond the RLS-scoped read.
  function handleExportLore() {
    if (!selectedOrgId || !selectedOrg) return;
    const org = selectedOrg;
    startTransition(async () => {
      const result = await exportOrgLore(selectedOrgId);
      if ('error' in result) {
        showToast(result.error, 'error');
        return;
      }
      const payload = {
        org: { id: org.id, slug: org.slug, name: org.name },
        exported_at: new Date().toISOString(),
        memories: result.rows,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lorekit-${org.slug}-lore.json`;
      // Append to the DOM (Firefox requires the anchor be in the document to
      // dispatch the click), and defer cleanup: revoking the object URL
      // synchronously after click() aborts the download in Safari before the
      // browser has queued it.
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 100);
      showToast(
        result.truncated
          ? `Exported the first ${result.rows.length} memories (export is capped).`
          : `Exported ${result.rows.length} ${result.rows.length === 1 ? 'memory' : 'memories'}.`,
        'success',
      );
    });
  }

  function handleRevoke(invite: OrgInvite) {
    startTransition(async () => {
      const result = await revokeInvite(invite.id);
      setConfirm(null);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      showToast(`Invite for ${invite.invitee_handle ?? invite.invitee_email} revoked.`, 'success');
    });
  }

  function handleRemoveMember(member: OrgMember) {
    if (!selectedOrgId) return;
    startTransition(async () => {
      const result = await removeMember(selectedOrgId, member.user_id);
      setConfirm(null);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setMembers((prev) => prev.filter((m) => m.user_id !== member.user_id));
      showToast('Member removed.', 'success');
    });
  }

  function handleRoleChange(member: OrgMember, role: Exclude<OrgRole, 'owner'>) {
    if (!selectedOrgId) return;
    startTransition(async () => {
      const result = await changeMemberRole(selectedOrgId, member.user_id, role);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setMembers((prev) => prev.map((m) => (m.user_id === member.user_id ? { ...m, role } : m)));
      showToast('Role updated.', 'success');
    });
  }

  function handleInvited(invite: OrgInvite) {
    setInvites((prev) => [invite, ...prev]);
  }

  function handleUnbind(binding: ScopeBinding) {
    if (!selectedOrgId) return;
    startTransition(async () => {
      const result = await unbindScope(selectedOrgId, binding.scope);
      setConfirm(null);
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      setBindings((prev) => prev.filter((b) => b.id !== binding.id));
      // Return the unbound scope to the suggestions list (insert back in sorted order).
      setAvailableScopes((prev) => {
        const next = [...prev, binding.scope];
        next.sort();
        return next;
      });
      showToast(`Scope ${binding.scope} unbound.`, 'success');
    });
  }

  const pendingInvites = invites.filter((i) => i.status === 'pending');

  return (
    <div className="flex flex-col gap-4">
      {orgs.length === 0 && !showCreateForm && (
        <div className="flex flex-col items-center gap-4">
          <EmptyState
            icon={Users}
            title="Create an organization"
            description="You'll become its owner and can invite teammates once it exists."
          />
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="flex min-h-11 items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-150 hover:opacity-90"
          >
            <Plus className="size-4" aria-hidden />
            Create organization
          </button>
        </div>
      )}

      {showCreateForm && (
        <CreateOrgForm
          onCreated={handleCreated}
          onCancel={orgs.length > 0 ? () => setShowCreateForm(false) : undefined}
        />
      )}

      {selectedOrg && !showCreateForm && (
        <>
          {orgs.length > 1 && (
            <div className="flex flex-col gap-1">
              <label htmlFor="org-switcher" className="text-xs text-[var(--color-content-secondary)]">
                Organization
              </label>
              <select
                id="org-switcher"
                value={selectedOrgId ?? ''}
                onChange={(e) => setSelectedOrgId(e.target.value)}
                className="min-h-11 w-full max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-content-primary)] focus:border-[var(--color-accent)] focus:outline-none"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-accent)]">
              <Users className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">{selectedOrg.name}</h3>
              <p className="text-xs text-[var(--color-content-tertiary)]">
                You are {selectedOrg.role === 'owner' || selectedOrg.role === 'admin' ? 'an' : 'a'}{' '}
                {ROLE_LABEL[selectedOrg.role]}
              </p>
            </div>
            {orgs.length > 0 && !showCreateForm && (
              <button
                type="button"
                onClick={() => setShowCreateForm(true)}
                className="ml-auto flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
              >
                <Plus className="size-3.5" aria-hidden />
                New organization
              </button>
            )}
          </div>

          {/* Member list */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
              Members
            </p>
            {loadingOrgData ? (
              <p className="text-xs text-[var(--color-content-tertiary)]">Loading members…</p>
            ) : (
              <AnimatePresence>
                {members.map((member) => {
                  const isSelf = member.user_id === currentUserId;
                  const identity = identities.find((i) => i.user_id === member.user_id);
                  const acts = myRole !== null && canActOnOrgMember(myRole, member.role) && !isSelf;
                  const canChangeRole = Boolean(caps?.canManageRoles) && acts;
                  const canRemove = Boolean(caps?.canRemoveMembers) && acts;
                  const displayName = isSelf
                    ? 'You'
                    : identity?.handle
                      ? `@${identity.handle}`
                      : `Member ${member.user_id.slice(0, 8)}`;
                  // Trusted-host-gated avatar (see isTrustedAvatarUrl) — null
                  // when absent or from an unexpected origin, so the <img> only
                  // renders a known-safe src.
                  const avatarUrl = isTrustedAvatarUrl(identity?.avatar_url)
                    ? identity.avatar_url
                    : null;

                  return (
                    <motion.div
                      key={member.user_id}
                      layout
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.2 }}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
                    >
                      {avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={avatarUrl}
                          alt=""
                          className="size-6 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]">
                          <Users className="size-3.5" aria-hidden />
                        </div>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-content-primary)]">
                        {displayName}
                      </span>

                      {canChangeRole ? (
                        <div className="flex flex-col gap-0.5">
                          <label htmlFor={`role-${member.user_id}`} className="sr-only">
                            Role for {displayName}
                          </label>
                          <select
                            id={`role-${member.user_id}`}
                            value={member.role}
                            onChange={(e) =>
                              handleRoleChange(member, e.target.value as Exclude<OrgRole, 'owner'>)
                            }
                            className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs text-[var(--color-content-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                          >
                            {ASSIGNABLE_ROLE_OPTIONS}
                          </select>
                        </div>
                      ) : (
                        <span className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-content-secondary)]">
                          {ROLE_LABEL[member.role]}
                        </span>
                      )}

                      {canRemove && (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirm({ kind: 'remove', member, label: identity?.handle ?? displayName })
                          }
                          aria-label={`Remove ${identity?.handle ?? displayName}`}
                          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-error)]"
                        >
                          <X className="size-4" aria-hidden />
                        </button>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>

          {/* Invite form — invite/admin+owner only */}
          {caps?.canInvite && <InviteForm orgId={selectedOrg.id} orgName={selectedOrg.name} onInvited={handleInvited} />}

          {/* Pending invites */}
          {pendingInvites.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                Pending invites
              </p>
              <AnimatePresence>
                {pendingInvites.map((invite) => (
                  <motion.div
                    key={invite.id}
                    layout
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
                  >
                    <Mail className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <span className="truncate text-sm text-[var(--color-content-primary)]">
                        {invite.invitee_handle ?? invite.invitee_email}
                      </span>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-content-tertiary)]">
                        <span className="rounded-full bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[var(--color-accent)]">
                          Pending
                        </span>
                        {ROLE_LABEL[invite.role]}
                      </div>
                    </div>
                    {caps?.canInvite && (
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: 'revoke', invite })}
                        aria-label={`Revoke invite for ${invite.invitee_handle ?? invite.invitee_email}`}
                        className="flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-error)]/40 hover:text-[var(--color-error)]"
                      >
                        Revoke
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          {/* Shared scopes — admin/owner only */}
          {caps?.canManageScopes && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                Shared scopes
              </p>
              <p className="text-[10px] text-[var(--color-content-tertiary)]">
                Writes under a bound scope auto-route to {selectedOrg.name} for write-capable members.
              </p>
              {loadingOrgData ? (
                <p className="text-xs text-[var(--color-content-tertiary)]">Loading scopes…</p>
              ) : bindings.length === 0 ? (
                <EmptyState
                  icon={Link}
                  title="No shared scopes"
                  description="Bind a scope so agent writes under it are automatically attributed to this org."
                />
              ) : (
                <AnimatePresence>
                  {bindings.map((binding) => (
                    <motion.div
                      key={binding.id}
                      layout
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5"
                    >
                      <Link className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--color-content-primary)]">
                        {binding.scope}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: 'unbind', binding })}
                        aria-label={`Unbind scope ${binding.scope}`}
                        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-error)]/40 hover:text-[var(--color-error)]"
                      >
                        <Unlink className="size-3.5" aria-hidden />
                        Unbind
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
              <BindScopeForm
                orgId={selectedOrg.id}
                orgName={selectedOrg.name}
                availableScopes={availableScopes}
                onBound={(binding) => {
                  setBindings((prev) => [...prev, binding]);
                  // Remove the just-bound scope from suggestions so it doesn't appear twice.
                  setAvailableScopes((prev) => prev.filter((s) => s !== binding.scope));
                }}
              />
            </div>
          )}

          {/* Leave / delete */}
          <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
            <button
              type="button"
              onClick={() => setConfirm({ kind: 'leave' })}
              className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
            >
              <LogOut className="size-4" aria-hidden />
              Leave organization
            </button>
            {caps?.canDelete && (
              <>
                <button
                  type="button"
                  onClick={handleExportLore}
                  disabled={pending}
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
                >
                  <Download className="size-4" aria-hidden />
                  Export lore
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm({ kind: 'delete' })}
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] px-4 text-sm text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-error)]/40 hover:text-[var(--color-error)]"
                >
                  <Trash2 className="size-4" aria-hidden />
                  Delete organization
                </button>
              </>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'leave'
            ? `Leave ${selectedOrg?.name ?? 'this organization'}?`
            : confirm?.kind === 'delete'
              ? `Delete ${selectedOrg?.name ?? 'this organization'}?`
              : confirm?.kind === 'revoke'
                ? `Revoke invite for ${confirm.invite.invitee_handle ?? confirm.invite.invitee_email}?`
                : confirm?.kind === 'remove'
                  ? `Remove ${confirm.label}?`
                  : confirm?.kind === 'unbind'
                    ? `Unbind scope ${confirm.binding.scope}?`
                    : ''
        }
        description={
          confirm?.kind === 'leave'
            ? "You'll lose access to this organization's shared lore. You can be invited back later."
            : confirm?.kind === 'delete'
              ? `The organization and its shared lore are hidden from all members immediately, but kept recoverable for ${ORG_DELETE_RETENTION_DAYS} days before permanent deletion. Export a copy first if you want one.`
              : confirm?.kind === 'revoke'
                ? 'The invited person will no longer be able to accept this invite. You can invite them again later.'
                : confirm?.kind === 'remove'
                  ? "They'll lose access to this organization's shared lore. You can invite them back later."
                  : confirm?.kind === 'unbind'
                    ? 'Writes under this scope will no longer auto-route to this organization. Existing shared memories are unaffected.'
                    : ''
        }
        confirmLabel={
          confirm?.kind === 'leave'
            ? 'Leave'
            : confirm?.kind === 'delete'
              ? 'Delete'
              : confirm?.kind === 'revoke'
                ? 'Revoke'
                : confirm?.kind === 'unbind'
                  ? 'Unbind'
                  : 'Remove'
        }
        destructive
        pending={pending}
        confirmPhrase={confirm?.kind === 'delete' ? (selectedOrg?.name ?? undefined) : undefined}
        onConfirm={() => {
          if (confirm?.kind === 'leave') handleLeave();
          else if (confirm?.kind === 'delete') handleDelete();
          else if (confirm?.kind === 'revoke') handleRevoke(confirm.invite);
          else if (confirm?.kind === 'remove') handleRemoveMember(confirm.member);
          else if (confirm?.kind === 'unbind') handleUnbind(confirm.binding);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
