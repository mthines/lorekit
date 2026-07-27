import type { Metadata } from 'next';
import { TutorialStep } from '@/components/tutorials/TutorialStep';
import { TutorialCallout } from '@/components/tutorials/TutorialCallout';

export const metadata: Metadata = { title: 'Tags & scopes — Tutorials' };

export default function TagsTutorialPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Tags & scopes</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Scopes partition lore by location (global, repo, branch). Tags are free-form labels
          that cut across scopes — use them to identify lesson type, source agent, workflow,
          or any dimension you care about.
        </p>
      </div>

      {/* Scope reference */}
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">Scope reference</p>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Type</th>
                <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Format</th>
                <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">When to use</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {[
                ['global', 'global', 'Universal principles — always apply'],
                ['project', 'project::{name}', 'Lessons shared across a monorepo'],
                ['repo', 'repo::{owner}/{repo}', 'Lessons about this repo\'s codebase'],
                ['branch', 'branch::{owner}/{repo}::{branch}', 'Experimental learnings on a feature branch'],
              ].map(([type, format, when]) => (
                <tr key={type} className="text-[var(--color-content-secondary)]">
                  <td className="px-3 py-2 font-mono">{type}</td>
                  <td className="px-3 py-2 font-mono">{format}</td>
                  <td className="px-3 py-2">{when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--color-content-tertiary)]">
          <code>::</code> is the only valid separator. Single <code>:</code> or <code>/</code> returns a 400 error.
          All segments are lowercased on ingest.
        </p>
      </div>

      <div className="flex flex-col">
        <TutorialStep number={1} title="Choose the right scope">
          <p>Use the narrowest scope that correctly describes where the lesson applies:</p>
          <pre><code>{`// Universal: always apply to every agent everywhere
scope: "global"

// Repo-level: applies to this codebase
scope: "repo::mthines/my-app"

// Branch-level: experimental, won't pollute the repo set
scope: "branch::mthines/my-app::feat/new-auth"

// Project-level: shared across a monorepo
scope: "project::my-monorepo"`}</code></pre>
          <p className="mt-2">
            Branch-scoped lessons do not pollute the repo's lesson set.
            Repo-scoped lessons do not pollute global.
          </p>
        </TutorialStep>

        <TutorialStep number={2} title="Add tags when writing">
          <p>
            Tags are arbitrary strings. Use a <code>namespace::value</code> convention
            to keep them readable:
          </p>
          <pre><code>{`memory.write {
  scope:  "global",
  key:    "aw-lessons::worktree-naming",
  value:  "Always use the branch name as the worktree directory name.",
  tags:   ["skill::aw", "source::stuck-loop", "loop::aw-lessons"],
  source_agent: "aw-executor",
  trigger: "stuck-loop"
}`}</code></pre>
          <p className="mt-2">Common tag namespaces used in the ecosystem:</p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            <li><code>skill::aw</code> / <code>skill::fix-bug</code> — which skill owns the lesson</li>
            <li><code>loop::aw-lessons</code> — marks a lesson as part of the AW self-improvement loop</li>
            <li><code>source::stuck-loop</code> / <code>source::pr-webhook</code> — what triggered the write</li>
          </ul>
        </TutorialStep>

        <TutorialStep number={3} title="Filter by tag when listing">
          <p>
            Pass <code>tags</code> to <code>memory.list</code> to narrow results:
          </p>
          <pre><code>{`memory.list {
  scope: "global",
  tags:  ["loop::aw-lessons"],
  limit: 50
}`}</code></pre>
          <p className="mt-2">
            Tags are an <strong>OR</strong> filter by default in <code>memory.list</code> —
            a lesson is returned if it has at least one of the listed tags.
          </p>
        </TutorialStep>

        <TutorialStep number={4} title="Search across scopes with wildcards">
          <p>
            <code>memory.search</code> supports owner-level wildcards in the <code>scopes</code>{' '}
            parameter and can combine tag AND-filters:
          </p>
          <pre><code>{`memory.search {
  q:      "worktree naming conflict",
  scopes: ["repo::mthines/*", "global"],
  tags:   ["skill::aw"],
  limit:  10
}`}</code></pre>
          <p className="mt-2">
            Wildcards only work in <code>memory.search</code> — not in{' '}
            <code>memory.read</code>, <code>memory.list</code>, or <code>memory.delete</code>.
          </p>
        </TutorialStep>

        <TutorialStep number={5} title="Read narrow-to-broad before a task">
          <p>
            Agents should read from specific scopes first, then merge with broader ones.
            More-specific scopes win when the same key exists at multiple levels:
          </p>
          <pre><code>{`// Read order for a task on branch feat/x in mthines/gw-tools
memory.list { scope: "branch::mthines/gw-tools::feat/x" }
memory.list { scope: "repo::mthines/gw-tools" }
memory.list { scope: "project::gw-tools" }    // monorepo only
memory.list { scope: "global" }`}</code></pre>
        </TutorialStep>

        <TutorialStep number={6} title="Inspect with the CLI">
            <p>
              The CLI offers several commands that respect the same scope/tag logic:
            </p>
            <pre><code>{`# Human-readable view of all applicable lessons
npx @lorekit/cli list

# Full-text search
npx @lorekit/cli search "worktree"

# Inspect one lesson in full
npx @lorekit/cli show --scope global --key aw-lessons::worktree-naming

# Scope precedence tree (which lesson wins per key)
npx @lorekit/cli tree

# Flag low-quality or malformed lessons
npx @lorekit/cli lint

# Find near-duplicates (Jaccard similarity)
npx @lorekit/cli dedupe`}</code></pre>
          </TutorialStep>
      </div>

      <TutorialCallout>
        <strong>Next:</strong> see how tags, scopes, and org sharing come together in
        real-world patterns. See the{' '}
        <a href="/tutorials/use-cases" className="text-[var(--color-accent)] underline underline-offset-2">
          Use cases tutorial
        </a>.
      </TutorialCallout>
    </div>
  );
}
