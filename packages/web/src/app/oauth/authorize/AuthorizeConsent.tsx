'use client';

import { useState, useTransition } from 'react';
import { Building2, KeyRound, Loader2, User } from 'lucide-react';
import type { TokenPermission } from '@/lib/tokens';
import { approveAuthorization, denyAuthorization } from './actions';

export interface ConsentOrg {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface Props {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  userEmail: string | null;
  orgs: ConsentOrg[];
}

/**
 * The consent screen.
 *
 * Three decisions are surfaced, in the order they matter:
 *
 *   1. WHO is asking (the registered client name) and where it will be sent
 *      back to. The redirect target is shown verbatim, because "which app is
 *      this really" is the question a consent screen exists to answer.
 *   2. WHAT it may do — read, or read and write.
 *   3. WHICH orgs it may reach. Personal lore is always included (it is the
 *      caller's own data); each org is opt-in and unticked by default. Nothing
 *      here is a dark pattern: the default is the least access that is still
 *      useful, and "Cancel" is as prominent as "Authorize".
 *
 * The checkboxes are a UI affordance only — `approveAuthorization` re-derives
 * the caller's real memberships server-side and intersects, so a tampered form
 * cannot widen the grant.
 */
export function AuthorizeConsent({
  clientName,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  scope,
  userEmail,
  orgs,
}: Props) {
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<TokenPermission[]>(['read', 'write']);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleOrg = (id: string) =>
    setSelectedOrgs((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const go = (result: { redirectTo: string } | { error: string }) => {
    if ('error' in result) {
      setError(result.error);
      return;
    }
    // A full navigation, not router.push: the target is an external loopback
    // or custom-scheme URL owned by the MCP client, not a Next.js route.
    window.location.href = result.redirectTo;
  };

  const onApprove = () =>
    startTransition(async () => {
      setError(null);
      go(
        await approveAuthorization({
          clientId,
          redirectUri,
          codeChallenge,
          state,
          scope,
          orgIds: selectedOrgs,
          permissions,
        }),
      );
    });

  const onDeny = () =>
    startTransition(async () => {
      setError(null);
      go(await denyAuthorization({ clientId, redirectUri, state }));
    });

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-4 md:p-6">
      <div className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <header className="mb-6">
          <div className="mb-3 flex items-center gap-3">
            <KeyRound className="size-5 shrink-0 text-[var(--color-accent)]" aria-hidden />
            <h1 className="font-mono text-sm font-semibold text-[var(--color-text)]">
              Authorize {clientName}
            </h1>
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">
            {clientName} wants to connect to your LoreKit memory
            {userEmail ? ` as ${userEmail}` : ''}. Choose what it may reach.
          </p>
        </header>

        <section className="mb-6">
          <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            Access level
          </h2>
          <div className="flex flex-col gap-2">
            <PermissionOption
              label="Read and write"
              description="The agent can read your lore and record new lessons."
              checked={permissions.includes('write')}
              onSelect={() => setPermissions(['read', 'write'])}
            />
            <PermissionOption
              label="Read only"
              description="The agent can read your lore but never change it."
              checked={!permissions.includes('write')}
              onSelect={() => setPermissions(['read'])}
            />
          </div>
        </section>

        <section className="mb-6">
          <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            Which lore
          </h2>

          <div className="mb-2 flex items-start gap-3 rounded-md border border-[var(--color-border)] px-3 py-3">
            <User className="mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
            <div className="min-w-0">
              <p className="font-mono text-xs text-[var(--color-text)]">Your personal lore</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Always included — this is the account you are signed in as.
              </p>
            </div>
          </div>

          {orgs.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              You are not a member of any organization yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {orgs.map((org) => (
                <li key={org.id}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-[var(--color-border)] px-3 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                      checked={selectedOrgs.includes(org.id)}
                      onChange={() => toggleOrg(org.id)}
                    />
                    <Building2 className="mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs text-[var(--color-text)]">{org.name}</span>
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        {org.slug} · you are {org.role}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {orgs.length > 0 && (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              Unticked organizations stay invisible to this connection. Leaving an organization
              revokes its access immediately, whatever you pick here.
            </p>
          )}
        </section>

        <section className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3">
          <p className="font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            After you authorize, you will be sent to
            <br />
            <span className="break-all text-[var(--color-text)]">{redirectUri}</span>
          </p>
        </section>

        {error && (
          <p role="alert" className="mb-4 text-xs text-[var(--color-scope-branch)]">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onDeny}
            disabled={pending}
            className="min-h-11 rounded-md border border-[var(--color-border)] px-4 font-mono text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={pending}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-4 font-mono text-xs font-semibold text-[var(--color-bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Authorize
          </button>
        </div>
      </div>
    </main>
  );
}

function PermissionOption({
  label,
  description,
  checked,
  onSelect,
}: {
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-[var(--color-border)] px-3 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
      <input
        type="radio"
        name="oauth-permissions"
        className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block font-mono text-xs text-[var(--color-text)]">{label}</span>
        <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}
