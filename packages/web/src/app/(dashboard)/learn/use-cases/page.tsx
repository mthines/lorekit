import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { TutorialCard } from '@/components/learn/TutorialCard';

export const metadata: Metadata = { title: 'Use cases — Getting started' };

interface UseCaseProps {
  title: string;
  description: string;
  code: string;
  note?: string;
}

function UseCase({ title, description, code, note }: UseCaseProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5">
      <div>
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">{title}</p>
        <p className="mt-0.5 text-xs text-[var(--color-content-secondary)]">{description}</p>
      </div>
      <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-4 font-mono text-xs text-[var(--color-content-secondary)]">
        <code>{code}</code>
      </pre>
      {note && (
        <p className="text-xs text-[var(--color-content-tertiary)]">{note}</p>
      )}
    </div>
  );
}

// GitHub Actions expressions use ${{ }} syntax which conflicts with JSX template
// literals. Define these strings outside JSX to avoid the parse ambiguity.
const CI_INJECT_CODE = [
  '- name: Inject LoreKit context',
  '  run: |',
  '    curl -s -X POST "$LOREKIT_MCP_URL" \\',
  '      -H "Authorization: Bearer $LOREKIT_TOKEN" \\',
  '      -H "Content-Type: application/json" \\',
  "      -d '{",
  '        "jsonrpc":"2.0","id":1,"method":"tools/call",',
  '        "params":{',
  '          "name":"memory.list",',
  '          "arguments":{',
  '            "scope":"repo::${{ github.repository }}",',
  '            "tags":["loop::aw-lessons"],',
  '            "limit":20',
  '          }',
  '        }',
  "      }'",
  '  env:',
  '    LOREKIT_MCP_URL: https://…/functions/v1/mcp',
  '    LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN }}',
].join('\n');

export default function LearnUseCasesPage() {
  return (
    <TutorialCard>
      <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Use cases</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          End-to-end examples showing how scopes, tags, and org sharing come together for
          real development workflows.
        </p>
      </div>

      {/* Section 1 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
          Autonomous workflow self-improvement
        </h3>
        <p className="text-sm text-[var(--color-content-secondary)]">
          The{' '}
          <a
            href="https://github.com/mthines/agent-skills/tree/main/skills/workflow/autonomous-workflow"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            autonomous-workflow
          </a>{' '}
          skill (part of{' '}
          <a
            href="https://github.com/mthines/agent-skills"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            mthines/agent-skills
          </a>
          ) defines a multi-phase agent dispatcher. The <code>aw</code> executor reads memories
          at Phase 1 (planning) and writes new ones at Phase 4 (stuck-loop) and Phase 7
          (end-of-run). Universal memories go to{' '}
          <code>global</code>; repo-bound memories go to <code>repo::{'{owner}/{repo}'}</code>.
        </p>
        <UseCase
          title="Read memories before planning"
          description="Narrow-to-broad fan-out — more specific wins."
          code={`// Phase 1 — read narrow first, then global
memory.list {
  scope: "repo::mthines/lorekit",
  tags:  ["loop::aw-lessons"],
  limit: 50
}
memory.list {
  scope: "global",
  tags:  ["loop::aw-lessons"],
  limit: 50
}`}
        />
        <UseCase
          title="Record a stuck-loop memory"
          description="Write when the agent is stuck for the third iteration on the same area."
          code={`memory.write {
  scope:        "repo::mthines/lorekit",
  key:          "aw-lessons::supabase-rls-debugging",
  value:        "RLS failures return 200 with an empty array, not a 4xx. Always\\ncheck .data.length before concluding the query returned no rows.",
  tags:         ["loop::aw-lessons", "skill::aw", "source::stuck-loop"],
  source_agent: "aw-executor",
  trigger:      "stuck-loop"
}`}
          note="The memory is repo-scoped so it only surfaces for this codebase, not globally."
        />
      </div>

      {/* Section 2 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
          CI / GitHub Actions context injection
        </h3>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Inject global and repo-scoped memories into any CI step so AI-assisted jobs have
          the same context as local agents. Generate a read-only token in{' '}
          <Link href="/settings/api-keys" className="text-[var(--color-accent)] underline underline-offset-2">
            Settings → API keys
          </Link>{' '}
          and store it as <code>LOREKIT_TOKEN</code> in your repo secrets.
        </p>
        <UseCase
          title="Inject memories before an AI step"
          description="Use a read-only token (lk_ro_…) stored as LOREKIT_TOKEN."
          code={CI_INJECT_CODE}
        />
      </div>

      {/* Section 3 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
          Team playbook with org sharing
        </h3>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Store deployment checklists, incident runbooks, and coding standards in an org
          so every team member's agent gets the same context automatically. Set up your org
          in{' '}
          <Link href="/settings/organization" className="text-[var(--color-accent)] underline underline-offset-2">
            Settings → Organization
          </Link>.
        </p>
        <UseCase
          title="Write a shared team runbook"
          description="An admin writes; every member's agent reads it during planning."
          code={`// Write once by a member/admin
memory.write {
  scope: "global",
  key:   "team::incident-runbook",
  value: "On-call: 1. Check Dash0. 2. Ping #incidents. 3. Write a post-mortem within 48h.",
  org:   "my-team",
  tags:  ["team::runbook", "source::manual"]
}

// Every agent in the org reads it
memory.list {
  scope: "global",
  tags:  ["team::runbook"]
}
// → includes the org-owned entry for every member`}
        />
        <UseCase
          title="Bind a repo scope to the org"
          description="After binding, member agents auto-route writes without passing org every time."
          code={`// Admin binds the scope from Settings → Organization → Shared scopes
// scope: "repo::myteam/api" → org: "my-team"

// Now any member write under this scope auto-routes to the org
memory.write {
  scope: "repo::myteam/api",
  key:   "deploy-checklist",
  value: "Always smoke-test staging before promoting."
  // no "org" needed — binding routes it automatically
}`}
        />
      </div>

      {/* Section 4 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
          Branch-scoped experimentation
        </h3>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Keep experimental memories on a feature branch so they don't pollute the repo
          set. Browse them in the{' '}
          <Link href="/lore" className="text-[var(--color-accent)] underline underline-offset-2">
            Explorer
          </Link>{' '}
          with a branch scope filter, then promote to repo scope after the branch merges.
        </p>
        <UseCase
          title="Write to a branch scope"
          description="Memory only surfaces when the agent is on this branch."
          code={`memory.write {
  scope: "branch::mthines/lorekit::feat/new-cache",
  key:   "cache-invalidation-strategy",
  value: "Use write-through for the session store; write-behind for lesson aggregates.",
  tags:  ["wip"]
}`}
        />
        <UseCase
          title="Promote to repo scope after merging"
          description="Once proven, promote the memory so it persists beyond the branch."
          code={`// After merge: write the same key at repo scope, delete the branch copy
memory.write {
  scope: "repo::mthines/lorekit",
  key:   "cache-invalidation-strategy",
  value: "Use write-through for session store; write-behind for lesson aggregates."
}
memory.delete {
  scope: "branch::mthines/lorekit::feat/new-cache",
  key:   "cache-invalidation-strategy"
}`}
        />
      </div>


      {/* Section 5 */}
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
          Transient memories with auto-expiry
        </h3>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Not every memory should live forever. Pass <code>ttl_days</code> to{' '}
          <code>memory.write</code> and the entry automatically becomes invisible once
          the TTL elapses — no manual cleanup required. This is ideal for session-scoped
          signals: issues already triaged, PR reviews in progress, or any fact that is
          only relevant for a few days.
        </p>
        <UseCase
          title="Flag a triaged issue (expires in 7 days)"
          description="The entry disappears automatically, so the agent won't revisit it next session."
          code={`memory.write {
  scope:    "repo::mthines/lorekit",
  key:      "triage::ENG-123",
  value:    "Already triaged — assigned to backend team, no action needed.",
  ttl_days: 7
}
// → response includes expires_at so you can confirm the deadline
// { id: "…", created_at: "…", expires_at: "2026-08-04T…" }`}
          note="On an update, omitting ttl_days leaves the existing expiry unchanged. Pass a new ttl_days to refresh the countdown."
        />
        <UseCase
          title="Renew a TTL on the next encounter"
          description="Update the value without resetting the expiry, or refresh both at once."
          code={`// Update only the value — expiry stays where it was
memory.write {
  scope: "repo::mthines/lorekit",
  key:   "triage::ENG-123",
  value: "Triaged — backend confirmed fix ships Friday."
}

// Extend the countdown by supplying a new ttl_days
memory.write {
  scope:    "repo::mthines/lorekit",
  key:      "triage::ENG-123",
  value:    "Triaged — backend confirmed fix ships Friday.",
  ttl_days: 3
}`}
        />
        <UseCase
          title="Clean up expired entries explicitly"
          description="Expired rows are invisible to reads immediately. Call memory.purge_expired to reclaim storage."
          code={`// Expired rows are hidden from all reads once expires_at passes.
// Call memory.purge_expired to physically remove them and reclaim storage:
memory.purge_expired {}
// → { purged: 4 }`}
          note="The CLI `npx @lorekit/cli list` always skips expired entries — you'll never see stale data in read results."
        />
      </div>

      <TutorialCallout variant="tip">
        The CLI <code>npx @lorekit/cli tree</code> command shows the full scope precedence
        hierarchy — which memory wins per key, and which are shadowed — so you can audit
        exactly what an agent will see before a task. You can also browse memories visually
        in the{' '}
        <Link href="/lore" className="text-[var(--color-accent)] underline underline-offset-2">
          Explorer
        </Link>.
      </TutorialCallout>
    </div>
    </TutorialCard>
  );
}
