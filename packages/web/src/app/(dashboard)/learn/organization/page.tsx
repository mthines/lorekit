import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';

export const metadata: Metadata = { title: 'Team sharing — Learn' };

export default function LearnOrganizationPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Team sharing</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Create an organization, invite teammates, and share one authoritative set of lore
          across the whole team. Updates are instant — no syncing, no copy-fan-out.
        </p>
      </div>

      <TutorialCallout variant="tip">
        Org sharing is <strong>org-first</strong>: there is a single shared row owned by
        the org, not a personal copy per member. Every team member reads and writes the
        same memory. When one person updates it, everyone sees the change immediately.
      </TutorialCallout>

      {/* Role overview */}
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">Role capabilities</p>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Role</th>
                <th className="px-3 py-2 text-center font-medium text-[var(--color-content-secondary)]">Read</th>
                <th className="px-3 py-2 text-center font-medium text-[var(--color-content-secondary)]">Write</th>
                <th className="px-3 py-2 text-center font-medium text-[var(--color-content-secondary)]">Hard-delete</th>
                <th className="px-3 py-2 text-center font-medium text-[var(--color-content-secondary)]">Manage members</th>
                <th className="px-3 py-2 text-center font-medium text-[var(--color-content-secondary)]">Rename / delete org</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {[
                { role: 'viewer', caps: [true, false, false, false, false] },
                { role: 'member', caps: [true, true, false, false, false] },
                { role: 'admin', caps: [true, true, true, true, false] },
                { role: 'owner', caps: [true, true, true, true, true] },
              ].map(({ role, caps }) => (
                <tr key={role} className="text-[var(--color-content-secondary)]">
                  <td className="px-3 py-2 font-mono">{role}</td>
                  {caps.map((has, i) => (
                    <td key={i} className="px-3 py-2 text-center">
                      {has ? (
                        <span className="text-[var(--color-accent)]" aria-label="yes">✓</span>
                      ) : (
                        <span className="text-[var(--color-content-tertiary)]" aria-label="no">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col">
        <TutorialStep number={1} title="Create an organization">
          <p>
            Go to{' '}
            <Link href="/settings/organization" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings → Organization
            </Link>{' '}
            and click <strong>Create organization</strong>. Enter a display name and a URL-safe
            slug (lowercase letters, digits, hyphens). The slug must be globally unique.
          </p>
          <p className="mt-2">
            You become the org's <strong>owner</strong> automatically.
          </p>
        </TutorialStep>

        <TutorialStep number={2} title="Invite teammates">
          <p>
            From the same page, enter a GitHub handle or an email address and pick a role.
            Only <code>admin</code> and <code>owner</code> can invite.
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>An <strong>email</strong> invite sends a transactional notification (if Resend is configured).</li>
            <li>A <strong>handle</strong> invite is in-app only — the invitee sees a banner on their{' '}
              <Link href="/dashboard" className="text-[var(--color-accent)] underline underline-offset-2">Overview</Link>.
            </li>
          </ul>
          <p className="mt-2">
            Invites are secured by identity: when someone accepts, the new membership is
            bound to <em>their</em> verified <code>auth.uid()</code> — a forwarded invite
            email can only be redeemed by the identity it was addressed to.
          </p>
        </TutorialStep>

        <TutorialStep number={3} title="Write org-owned lore">
          <p>
            Agents write org-owned lore by passing the org slug on <code>memory.write</code>:
          </p>
          <pre><code>{`memory.write {
  scope:  "repo::myteam/api",
  key:    "deployment-checklist",
  value:  "Always run smoke tests on the staging env before promoting to prod.",
  org:    "my-team"          // org slug
}`}</code></pre>
          <p className="mt-2">
            Authorization is derived server-side — the write is accepted only if the caller
            is a write-capable member. A <code>viewer</code> or non-member is rejected.
          </p>
        </TutorialStep>

        <TutorialStep number={4} title="Bind a scope to your org (optional)">
          <p>
            Instead of passing <code>org</code> on every write, an admin can bind a scope
            to the org so writes auto-route:
          </p>
          <p className="mt-2">
            Go to{' '}
            <Link href="/settings/organization" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings → Organization → Shared scopes
            </Link>{' '}
            → enter a scope string (e.g. <code>repo::myteam/api</code>) → click{' '}
            <strong>Bind scope</strong>.
          </p>
          <p className="mt-2">
            After binding, any write under <code>repo::myteam/api</code> by a write-capable
            member routes to the org automatically. A non-member writing under a bound scope
            gets a graceful fallback to personal lore (never rejected) with a{' '}
            <code>notice</code> in the response.
          </p>
        </TutorialStep>

        <TutorialStep number={5} title="Browse team lore in the Explorer">
          <p>
            In the{' '}
            <Link href="/lore" className="text-[var(--color-accent)] underline underline-offset-2">
              Explorer
            </Link>, use the <strong>All · Personal · {'{org}'}</strong>{' '}
            filter to narrow to your org's lore. Org-owned memories show an ownership badge
            next to the scope badge. The detail panel shows the owning org and who last
            updated the memory.
          </p>
        </TutorialStep>
      </div>

      <TutorialCallout>
        <strong>Next:</strong> understand how personal and org-owned lore coexist and how
        scope precedence decides which memory wins. See the{' '}
        <Link href="/learn/private" className="text-[var(--color-accent)] underline underline-offset-2">
          Private lore tutorial
        </Link>.
      </TutorialCallout>
    </div>
  );
}
