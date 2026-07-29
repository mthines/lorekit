'use client';

/**
 * GettingStartedDialog — full learn-section content in a modal overlay,
 * accessible before the user signs in.
 *
 * Layout: left tab strip (mirrors LearnNav order) + right scrollable content.
 * Body scroll is locked while the dialog is open (overflow:hidden on document.body).
 * Follows the same AnimatePresence + focus-trap pattern as ConfirmDialog.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X, Rocket, HardDrive, Cloud, Users, Lock, Tag, FileCog, Zap } from 'lucide-react';

// ── Shared primitives (inlined — no auth-gated imports) ───────────────────────

function TutorialCallout({
  children,
  variant = 'default',
}: {
  children: React.ReactNode;
  variant?: 'default' | 'tip' | 'info';
}) {
  const bg =
    variant === 'tip'
      ? 'bg-[var(--color-accent-subtle)] border-[var(--color-accent)]/30'
      : 'bg-[var(--color-bg-elevated)] border-[var(--color-border)]';
  return (
    <div className={`rounded-lg border p-4 text-sm text-[var(--color-content-secondary)] ${bg}`}>
      {children}
    </div>
  );
}

function TutorialStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 pb-8">
      <div className="flex shrink-0 flex-col items-center">
        <span className="flex size-7 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-xs font-bold text-[var(--color-accent)]">
          {number}
        </span>
        <div className="mt-2 w-px flex-1 bg-[var(--color-border)]" />
      </div>
      <div className="flex-1 pb-2">
        <p className="mb-3 text-sm font-semibold text-[var(--color-content-primary)]">{title}</p>
        <div className="flex flex-col gap-2 text-sm text-[var(--color-content-secondary)] [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-elevated)] [&_pre]:p-3 [&_pre]:text-xs [&_code]:font-mono [&_code]:text-xs [&_code]:text-[var(--color-content-primary)] [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Tab content components ─────────────────────────────────────────────────────

const MCP_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

function SetupContent() {
  const jsonSnippet = `{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}", "--header", "Authorization:Bearer lk_rw_…"]
    }
  }
}`;
  const yamlSnippet = `mcp:
  servers:
    lorekit:
      command: npx
      args: [-y, mcp-remote, "${MCP_URL}", --header, "Authorization:Bearer lk_rw_…"]`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Getting started</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect LoreKit to your AI coding agent in three steps. Once connected, your agent can read
          and write memories so knowledge accumulates across sessions.
        </p>
      </div>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Generate an API token">
          <p>After signing in, go to <strong>Settings → API keys</strong> and click <strong>Generate new token</strong>. Choose a permission tier:</p>
          <ul>
            <li><code>lk_rw_…</code> — read + write (recommended for coding agents)</li>
            <li><code>lk_ro_…</code> — read only (context injection, CI)</li>
            <li><code>lk_wo_…</code> — write only (one-way memory feeders)</li>
          </ul>
          <p>The token is shown <strong>once</strong> — copy it before closing the modal.</p>
        </TutorialStep>
        <TutorialStep number={2} title="Add LoreKit to your agent's MCP config">
          <p>Replace <code>lk_rw_…</code> with your token. Claude Code / Cursor / opencode (<code>.mcp.json</code>):</p>
          <pre><code>{jsonSnippet}</code></pre>
          <p>Codex CLI (<code>~/.codex/config.yaml</code>):</p>
          <pre><code>{yamlSnippet}</code></pre>
          <TutorialCallout variant="tip">
            All agents use the same URL — only the config file path differs. Requires Node.js;{' '}
            <code>npx</code> downloads <code>mcp-remote</code> automatically on first run.
          </TutorialCallout>
        </TutorialStep>
        <TutorialStep number={3} title="Verify the connection">
          <p>Start a new agent session and write a test memory:</p>
          <pre><code>{`memory.write {
  scope: "global",
  key:   "hello-lorekit",
  value: "Connection is working."
}`}</code></pre>
          <p>Then confirm with the CLI doctor:</p>
          <pre><code>npx @lorekit/cli doctor</code></pre>
        </TutorialStep>
      </div>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5">
        <p className="text-sm font-medium text-[var(--color-content-primary)]">Optional: auto-memories from PR reviews</p>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Connect a GitHub webhook and every resolved PR review comment becomes a memory automatically,
          tagged <code className="rounded bg-[var(--color-bg-elevated)] px-1 font-mono text-xs">source::pr-webhook</code>.
          Set this up from <strong>Settings → Webhooks</strong> after signing in.
        </p>
      </div>
    </div>
  );
}

function OfflineContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Offline storage</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Store lore locally on your machine using the LoreKit CLI — no account, no network, full privacy.
          Memories live in a plain directory you own and control.
        </p>
      </div>
      <TutorialCallout variant="tip">
        Offline storage is the fastest way to start. You can migrate to remote storage later by adding
        a <code>LOREKIT_MCP_URL</code> and <code>LOREKIT_TOKEN</code> — the CLI reads both stores and
        merges them automatically.
      </TutorialCallout>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Install the CLI">
          <pre><code>npx @lorekit/cli install</code></pre>
          <p>Scaffolds the <code>lorekit-memory</code> and <code>lorekit-setup</code> skills, the local
          MCP server, and lifecycle hooks into your <code>.claude/</code> or <code>~/.claude/</code>{' '}
          directory. To skip hook injection:</p>
          <pre><code>npx @lorekit/cli install --no-hooks</code></pre>
        </TutorialStep>
        <TutorialStep number={2} title="Verify the local store">
          <pre><code>npx @lorekit/cli doctor</code></pre>
          <p>Confirms the local MCP server is reachable and the store directory is writable.</p>
        </TutorialStep>
        <TutorialStep number={3} title="Write your first memory">
          <pre><code>npx @lorekit/cli mcp</code></pre>
          <p>Starts the local stdio MCP server. Your agent can then call <code>memory.write</code>:</p>
          <pre><code>{`memory.write {
  scope: "global",
  key:   "my-first-lesson",
  value: "Always run unit tests before committing."
}`}</code></pre>
        </TutorialStep>
        <TutorialStep number={4} title="Browse and search">
          <pre><code>{`npx @lorekit/cli list
npx @lorekit/cli search "commit"
npx @lorekit/cli tree`}</code></pre>
          <p><code>list</code> shows all memories in scope. <code>search</code> does literal substring
          search. <code>tree</code> shows the precedence hierarchy — which key wins per scope.</p>
        </TutorialStep>
        <TutorialStep number={5} title="Commit a project config (optional)">
          <pre><code>{`// .lorekit.json (safe to commit)
{
  "mode": "local",
  "store": ".lorekit",
  "deny": ["remote"]
}`}</code></pre>
        </TutorialStep>
      </div>
    </div>
  );
}

function RemoteContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Remote storage</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Sync lore to the hosted LoreKit MCP server so your memories are available on every machine,
          from every agent, without extra setup on each device.
        </p>
      </div>
      <TutorialCallout variant="tip">
        Use the hosted instance at <code>lorekit.io</code> or self-host your own. Sign in first, then
        follow these steps.
      </TutorialCallout>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Generate an API token">
          <p>After signing in, go to <strong>Settings → API keys</strong> and generate a token:</p>
          <ul>
            <li><code>lk_rw_…</code> — read + write (agents that learn)</li>
            <li><code>lk_ro_…</code> — read only (CI context injection)</li>
            <li><code>lk_wo_…</code> — write only (one-way feeders)</li>
          </ul>
          <p>The token is shown <strong>once</strong> — copy it before closing the modal.</p>
        </TutorialStep>
        <TutorialStep number={2} title="Point your agent at the MCP server">
          <p>The fastest path is <code>npx @lorekit/cli install</code>. Or add manually:</p>
          <pre><code>{`// .mcp.json
{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
        "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp",
        "--header", "Authorization:Bearer lk_rw_…"]
    }
  }
}`}</code></pre>
        </TutorialStep>
        <TutorialStep number={3} title="CI injection (optional)">
          <p>Generate a <code>lk_ro_…</code> token and store it as <code>LOREKIT_TOKEN</code> in your
          repo secrets:</p>
          <pre><code>{`- name: Inject LoreKit context
  run: npx @lorekit/cli list --scope repo::\${{ github.repository }} --json
  env:
    LOREKIT_TOKEN: \${{ secrets.LOREKIT_TOKEN }}`}</code></pre>
        </TutorialStep>
        <TutorialStep number={4} title="Two-store merge">
          <p>When both local and remote stores are configured, the CLI merges them: local shadows remote
          for the same key — offline-first behaviour. Run <code>npx @lorekit/cli diff</code> to see
          divergences between stores.</p>
        </TutorialStep>
      </div>
    </div>
  );
}

function OrganizationContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Team sharing</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Create an organization, invite teammates, and share one authoritative set of lore across the
          whole team. Updates are instant — no syncing, no copy-fan-out.
        </p>
      </div>
      <TutorialCallout variant="tip">
        Org sharing is <strong>org-first</strong>: a single shared row owned by the org, not a personal
        copy per member. When one person updates it, everyone sees the change immediately.
      </TutorialCallout>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {['Role', 'Read', 'Write', 'Hard-delete', 'Manage members', 'Rename / delete org'].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {([
              { role: 'viewer', caps: [true, false, false, false, false] },
              { role: 'member', caps: [true, true, false, false, false] },
              { role: 'admin',  caps: [true, true, true, true, false] },
              { role: 'owner',  caps: [true, true, true, true, true] },
            ] as const).map(({ role, caps }) => (
              <tr key={role} className="text-[var(--color-content-secondary)]">
                <td className="px-3 py-2 font-mono">{role}</td>
                {caps.map((has, i) => (
                  <td key={i} className="px-3 py-2 text-center">
                    {has
                      ? <span className="text-[var(--color-accent)]" aria-label="yes">✓</span>
                      : <span className="text-[var(--color-content-tertiary)]" aria-label="no">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Create an organization">
          <p>After signing in, go to <strong>Settings → Organization</strong> and click{' '}
          <strong>Create organization</strong>. You become the owner automatically.</p>
        </TutorialStep>
        <TutorialStep number={2} title="Invite teammates">
          <p>Enter a GitHub handle or email and pick a role. Only <code>admin</code> and{' '}
          <code>owner</code> can invite. Invites are identity-locked — a forwarded invite can only
          be accepted by the identity it was addressed to.</p>
        </TutorialStep>
        <TutorialStep number={3} title="Write org-owned lore">
          <pre><code>{`memory.write {
  scope: "repo::myteam/api",
  key:   "deployment-checklist",
  value: "Always smoke-test staging before promoting to prod.",
  org:   "my-team"
}`}</code></pre>
        </TutorialStep>
        <TutorialStep number={4} title="Browse team lore">
          <p>In the Explorer, use the <strong>All · Personal · org</strong> filter to narrow to your
          org&apos;s lore. Org-owned memories show an ownership badge next to the scope badge.</p>
        </TutorialStep>
      </div>
    </div>
  );
}

function PrivateContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Private lore</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Every memory is personal by default — visible only to the user or token that wrote it. This
          tutorial explains how personal and org-owned lore coexist.
        </p>
      </div>
      <TutorialCallout variant="info">
        You never have to do anything to make a memory private. Omitting the <code>org</code> parameter
        on <code>memory.write</code> is all that is needed.
      </TutorialCallout>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Write a private memory">
          <pre><code>{`memory.write {
  scope: "global",
  key:   "my-api-key-pattern",
  value: "Never commit API keys. Use environment variables."
}
// No "org" parameter → personal, only you can read it.`}</code></pre>
        </TutorialStep>
        <TutorialStep number={2} title="At a bound scope">
          <p>If an admin has bound a scope to an org:</p>
          <ul>
            <li><strong>Write-capable member</strong> — write auto-routes to the org. Use a
            more-specific scope (e.g. branch) to write personal instead.</li>
            <li><strong>Non-member</strong> — write falls back to personal, never rejected. You receive
            a <code>notice</code> in the response.</li>
          </ul>
        </TutorialStep>
        <TutorialStep number={3} title="Archive or delete a private memory">
          <pre><code>{`// Soft-archive (recoverable)
memory.archive { scope: "global", key: "my-api-key-pattern" }

// Hard-delete (permanent)
memory.delete { scope: "global", key: "my-api-key-pattern", force: true }`}</code></pre>
        </TutorialStep>
      </div>
    </div>
  );
}

function TagsContent() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Tags &amp; scopes</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Scopes partition lore by location (global, repo, branch). Tags are free-form labels that cut
          across scopes.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {['Type', 'Format', 'When to use'].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {[
              ['global', 'global', 'Universal principles — always apply'],
              ['project', 'project::{name}', 'Memories shared across a monorepo'],
              ['repo', 'repo::{owner}/{repo}', "Memories about this repo's codebase"],
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
      <div className="flex flex-col">
        <TutorialStep number={1} title="Add tags when writing">
          <pre><code>{`memory.write {
  scope:        "global",
  key:          "aw-lessons::worktree-naming",
  value:        "Always use the branch name as the worktree directory name.",
  tags:         ["skill::aw", "source::stuck-loop", "loop::aw-lessons"],
  source_agent: "aw-executor",
  trigger:      "stuck-loop"
}`}</code></pre>
        </TutorialStep>
        <TutorialStep number={2} title="Filter by tag">
          <pre><code>{`memory.list { scope: "global", tags: ["loop::aw-lessons"], limit: 50 }`}</code></pre>
        </TutorialStep>
        <TutorialStep number={3} title="Search across scopes with wildcards">
          <pre><code>{`memory.search {
  q:      "worktree naming conflict",
  scopes: ["repo::mthines/*", "global"],
  tags:   ["skill::aw"],
  limit:  10
}`}</code></pre>
          <p>Wildcards only work in <code>memory.search</code> — not in <code>memory.read</code> or
          <code>memory.list</code>.</p>
        </TutorialStep>
        <TutorialStep number={4} title="Read narrow-to-broad before a task">
          <pre><code>{`memory.list { scope: "branch::mthines/gw-tools::feat/x" }
memory.list { scope: "repo::mthines/gw-tools" }
memory.list { scope: "global" }`}</code></pre>
        </TutorialStep>
        <TutorialStep number={5} title="CLI tools">
          <pre><code>{`npx @lorekit/cli list            # all applicable memories
npx @lorekit/cli search "term"   # literal substring search
npx @lorekit/cli tree            # precedence hierarchy
npx @lorekit/cli lint            # flag low-quality entries
npx @lorekit/cli dedupe          # near-duplicate detection`}</code></pre>
        </TutorialStep>
      </div>
    </div>
  );
}

function ConfigContent() {
  const repoSnippet = `// .lorekit.json — repo root, safe to commit (no secrets)
{
  "mode": "local",
  "store": ".lorekit",
  "mcp.endpoint": "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp",
  "tags.default": ["team", "project::my-app"],
  "deny": [],
  "hooks.disabled": ["Stop"],
  "hooks.instructions": {
    "SessionStart": "Focus on migration safety.",
    "PostToolUseFailure": "Include the exact command and exit code.",
    "Stop": null
  },
  "telemetry.disabled": true
}`;

  const userSnippet = `// ~/.lorekit/config.json — user/machine, not committed
{
  "deny": ["remote"],
  "tags.default": ["mads"],
  "hooks.adapter": "claude"
}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Configuration</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          LoreKit reads two optional JSON config files that decide the memory mode, store location, and
          write &amp; hook behaviour. Both share the same schema — every field is optional.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {['Layer', 'File', 'Scope'].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            <tr className="text-[var(--color-content-secondary)]">
              <td className="px-3 py-2">Repo / team</td>
              <td className="px-3 py-2 font-mono">.lorekit.json</td>
              <td className="px-3 py-2">Repo root — safe to commit, no secrets.</td>
            </tr>
            <tr className="text-[var(--color-content-secondary)]">
              <td className="px-3 py-2">User / machine</td>
              <td className="px-3 py-2 font-mono">~/.lorekit/config.json</td>
              <td className="px-3 py-2">Personal overrides — not committed.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-col">
        <TutorialStep number={1} title="Commit team defaults">
          <pre><code>{repoSnippet}</code></pre>
        </TutorialStep>
        <TutorialStep number={2} title="Personal overrides">
          <pre><code>{userSnippet}</code></pre>
          <p>A <code>deny</code> ceiling here can never be lifted by any repo default or env flag.</p>
        </TutorialStep>
        <TutorialStep number={3} title="Precedence & deny">
          <pre><code>{`// Selection (highest-precedence first):
// env LOREKIT_MODE → user config → repo config → default ("remote")
// Deny is a union across all layers and always wins.`}</code></pre>
        </TutorialStep>
        <TutorialStep number={4} title="Check the resolved config">
          <pre><code>npx @lorekit/cli doctor</code></pre>
          <p>Shows the resolved mode, which source decided it, and any active deny constraints.</p>
        </TutorialStep>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              {['Environment variable', 'Purpose'].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {[
              ['LOREKIT_MODE', 'Select a mode: off / local / remote'],
              ['LOREKIT_DENY', 'Comma-separated modes to forbid'],
              ['LOREKIT_HOME', 'Home-tier root + config directory'],
              ['LOREKIT_STORE', 'Project-tier store directory'],
              ['LOREKIT_TOKEN', 'Token fallback for remote mode'],
              ['LOREKIT_TELEMETRY', 'Set to 0 to disable usage telemetry'],
            ].map(([name, purpose]) => (
              <tr key={name} className="text-[var(--color-content-secondary)] align-top">
                <td className="px-3 py-2 font-mono whitespace-nowrap text-[var(--color-content-primary)]">{name}</td>
                <td className="px-3 py-2">{purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UseCasesContent() {
  const ciCode = `- name: Inject LoreKit context
  run: npx @lorekit/cli list --scope repo::\${{ github.repository }} --json
  env:
    LOREKIT_TOKEN: \${{ secrets.LOREKIT_TOKEN }}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--color-content-primary)]">Use cases</h3>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          End-to-end examples showing how scopes, tags, and org sharing come together for real
          development workflows.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">Autonomous workflow self-improvement</p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <p className="mb-2 text-xs font-medium text-[var(--color-content-primary)]">Read memories before planning (narrow-to-broad)</p>
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{`memory.list { scope: "repo::mthines/lorekit", tags: ["loop::aw-lessons"], limit: 50 }
memory.list { scope: "global",               tags: ["loop::aw-lessons"], limit: 50 }`}</code></pre>
        </div>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <p className="mb-2 text-xs font-medium text-[var(--color-content-primary)]">Record a stuck-loop memory</p>
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{`memory.write {
  scope: "repo::mthines/lorekit",
  key:   "aw-lessons::supabase-rls-debugging",
  value: "RLS failures return 200 with empty array. Check .data.length.",
  tags:  ["loop::aw-lessons", "skill::aw", "source::stuck-loop"]
}`}</code></pre>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">CI / GitHub Actions context injection</p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{ciCode}</code></pre>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">Team playbook with org sharing</p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{`memory.write {
  scope: "global",
  key:   "team::incident-runbook",
  value: "On-call: 1. Check Dash0. 2. Ping #incidents. 3. Post-mortem within 48h.",
  org:   "my-team",
  tags:  ["team::runbook"]
}`}</code></pre>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">Branch-scoped experimentation</p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{`// Write to branch scope
memory.write  { scope: "branch::mthines/lorekit::feat/cache", key: "cache-strategy", value: "Write-through." }

// After merging — promote and delete the branch copy
memory.write  { scope: "repo::mthines/lorekit", key: "cache-strategy", value: "Write-through." }
memory.delete { scope: "branch::mthines/lorekit::feat/cache", key: "cache-strategy" }`}</code></pre>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-[var(--color-content-primary)]">Transient memories with auto-expiry</p>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <pre className="overflow-x-auto rounded-md bg-[var(--color-bg-elevated)] p-3 font-mono text-xs text-[var(--color-content-secondary)]"><code>{`memory.write {
  scope:    "repo::mthines/lorekit",
  key:      "triage::ENG-123",
  value:    "Already triaged — assigned to backend team.",
  ttl_days: 7
}
// Expires automatically — no manual cleanup needed`}</code></pre>
        </div>
      </div>
    </div>
  );
}

// ── Tab registry ───────────────────────────────────────────────────────────────

const TABS = [
  { id: 'setup',        label: 'Getting started', icon: Rocket,    content: SetupContent },
  { id: 'offline',      label: 'Offline storage',  icon: HardDrive, content: OfflineContent },
  { id: 'remote',       label: 'Remote storage',   icon: Cloud,     content: RemoteContent },
  { id: 'organization', label: 'Team sharing',     icon: Users,     content: OrganizationContent },
  { id: 'private',      label: 'Private lore',     icon: Lock,      content: PrivateContent },
  { id: 'tags',         label: 'Tags & scopes',    icon: Tag,       content: TagsContent },
  { id: 'config',       label: 'Configuration',    icon: FileCog,   content: ConfigContent },
  { id: 'use-cases',    label: 'Use cases',        icon: Zap,       content: UseCasesContent },
] as const;

type TabId = (typeof TABS)[number]['id'];

// ── Dialog ─────────────────────────────────────────────────────────────────────

export interface GettingStartedDialogProps {
  open: boolean;
  onClose: () => void;
}

export function GettingStartedDialog({ open, onClose }: GettingStartedDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<TabId>('setup');
  const contentRef = useRef<HTMLDivElement>(null);

  // Body scroll lock
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus management
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      const timer = setTimeout(() => {
        dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
    previouslyFocused.current?.focus?.();
    return undefined;
  }, [open]);

  // Keyboard: Escape + Tab trap
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Scroll content to top on tab switch
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeTab]);

  const ActiveContent = TABS.find((t) => t.id === activeTab)!.content;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="gs-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Dialog panel */}
          <motion.div
            key="gs-dialog"
            ref={dialogRef}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 10 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-4 top-[50%] z-[10000] flex max-h-[min(90dvh,860px)] -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl sm:inset-x-auto sm:left-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-4xl sm:-translate-x-1/2"
            role="dialog"
            aria-modal="true"
            aria-label="LoreKit setup guide"
          >
            {/* Sticky header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
              <p className="text-sm font-semibold text-[var(--color-content-primary)]">Setup guide</p>
              <button
                type="button"
                onClick={onClose}
                className="flex size-8 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                aria-label="Close setup guide"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            {/* Body: sidebar + content */}
            <div className="flex min-h-0 flex-1">
              {/* Desktop sidebar */}
              <nav
                aria-label="Setup guide sections"
                className="hidden shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border)] p-3 sm:flex sm:w-52"
              >
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTab(id)}
                    aria-current={activeTab === id ? 'page' : undefined}
                    className={[
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors duration-150',
                      activeTab === id
                        ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                        : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
                    ].join(' ')}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    {label}
                  </button>
                ))}
              </nav>

              {/* Mobile + desktop content column */}
              <div className="flex min-w-0 flex-1 flex-col">
                {/* Mobile: horizontal tab strip */}
                <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-3 py-2 sm:hidden">
                  {TABS.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      aria-current={activeTab === id ? 'page' : undefined}
                      className={[
                        'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                        activeTab === id
                          ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                          : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                      ].join(' ')}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Scrollable content area */}
                <div ref={contentRef} className="flex-1 overflow-y-auto p-6">
                  <ActiveContent />
                  <div className="mt-8 border-t border-[var(--color-border)] pt-4">
                    <p className="text-xs text-[var(--color-content-tertiary)]">
                      Ready to get started?{' '}
                      <button
                        type="button"
                        onClick={onClose}
                        className="text-[var(--color-accent)] underline underline-offset-2 hover:no-underline"
                      >
                        Sign in
                      </button>{' '}
                      to generate your API token and connect your first agent.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
