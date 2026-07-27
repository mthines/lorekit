import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { TutorialCard } from '@/components/learn/TutorialCard';

export const metadata: Metadata = { title: 'Private lore — Getting started' };

export default function LearnPrivatePage() {
  return (
    <TutorialCard>
      <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Private lore</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Every lesson is personal by default — visible only to the user or token that wrote it.
          This tutorial explains how personal and org-owned lore coexist, and how to keep
          sensitive lessons private even in a shared team environment.
        </p>
      </div>

      <TutorialCallout variant="info">
        You never have to do anything to make a lesson private. Omitting the{' '}
        <code>org</code> parameter on <code>memory.write</code> is all that is needed —
        the lesson is personal by definition.
      </TutorialCallout>

      <div className="flex flex-col gap-6">
        <div>
          <p className="text-sm font-medium text-[var(--color-content-primary)] mb-2">
            Personal vs org-owned — the core distinction
          </p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Property</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Personal lore</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Org-owned lore</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {[
                  ['Who sees it', 'Your token / session only', 'Every org member'],
                  ['Who writes it', 'Any lk_rw_ or lk_wo_ token', 'Write-capable member only'],
                  ['How to write', 'Omit the org parameter', 'Pass org: "slug" on memory.write'],
                  ['Explorer filter', 'Personal filter', '{org} filter'],
                ].map(([prop, personal, org]) => (
                  <tr key={prop} className="text-[var(--color-content-secondary)]">
                    <td className="px-3 py-2 font-medium text-[var(--color-content-primary)]">{prop}</td>
                    <td className="px-3 py-2">{personal}</td>
                    <td className="px-3 py-2">{org}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        <TutorialStep number={1} title="Write a private lesson">
          <p>
            Simply omit <code>org</code>. The lesson is stored under your personal partition
            regardless of whether a scope binding exists:
          </p>
          <pre><code>{`memory.write {
  scope: "global",
  key:   "my-api-key-pattern",
  value: "Never commit API keys. Use environment variables."
}
// No "org" parameter → personal, only you can read it.`}</code></pre>
        </TutorialStep>

        <TutorialStep number={2} title="Understand what happens at a bound scope">
          <p>
            If an admin has bound a scope (e.g. <code>repo::myteam/api</code>) to an org
            (see{' '}
            <Link href="/settings/organization" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings → Organization → Shared scopes
            </Link>):
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li>
              <strong>You are a write-capable member</strong> → write auto-routes to the org.
              Use a more-specific scope (e.g. a branch scope) to write personal instead.
            </li>
            <li>
              <strong>You are not a write-capable member</strong> → the write falls back to
              personal, never rejected. You receive a <code>notice</code> in the response.
            </li>
          </ul>
          <TutorialCallout variant="tip">
            To intentionally write personal lore under a bound scope, use a more-specific
            scope that is not bound (e.g.{' '}
            <code>branch::myteam/api::feat/my-branch</code>).
          </TutorialCallout>
        </TutorialStep>

        <TutorialStep number={3} title="Filter to personal lore in the Explorer">
          <p>
            In the{' '}
            <Link href="/lore" className="text-[var(--color-accent)] underline underline-offset-2">
              Explorer
            </Link>, use the <strong>Personal</strong> filter in the{' '}
            <strong>All · Personal · {'{org}'}</strong> toolbar. This narrows the list to
            lessons that belong only to you.
          </p>
        </TutorialStep>

        <TutorialStep number={4} title="Archive or delete a private lesson">
          <p>
            Soft-archive (recoverable — hidden from reads, restorable via{' '}
            <code>memory.restore</code>):
          </p>
          <pre><code>{`memory.archive {
  scope: "global",
  key:   "my-api-key-pattern"
}`}</code></pre>
          <p className="mt-2">Hard-delete (permanent, requires explicit <code>force: true</code>):</p>
          <pre><code>{`memory.delete {
  scope: "global",
  key:   "my-api-key-pattern",
  force: true
}`}</code></pre>
        </TutorialStep>
      </div>

      <TutorialCallout>
        <strong>Next:</strong> learn how to organise lessons with tags and scope namespaces
        so the right lesson surfaces at the right time. See the{' '}
        <Link href="/learn/tags" className="text-[var(--color-accent)] underline underline-offset-2">
          Tags & scopes tutorial
        </Link>.
      </TutorialCallout>
    </div>
    </TutorialCard>
  );
}
