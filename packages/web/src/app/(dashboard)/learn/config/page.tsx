import type { Metadata } from 'next';
import Link from 'next/link';
import { TutorialStep } from '@/components/learn/TutorialStep';
import { TutorialCallout } from '@/components/learn/TutorialCallout';
import { TutorialCard } from '@/components/learn/TutorialCard';

export const metadata: Metadata = { title: 'Configuration — Getting started' };

/**
 * Configuration — a reference for the two LoreKit config files.
 *
 * Mirrors the Tags & scopes page's reference-table + step layout rather than a
 * pure step-by-step tutorial: the config schema is something users scan and
 * look up, not walk through once. The property table is the single source of
 * truth on the site for the `.lorekit.json` / `~/.lorekit/config.json` schema —
 * keep it in sync with `packages/cli/README.md` → "The control model" and the
 * resolver in `packages/cli/src/control.mjs`.
 */

// The full config schema — the same fields both layers accept. Kept as data so
// the table below and the JSON example stay derivable from one list.
const PROPERTIES: {
  name: string;
  type: string;
  layer: 'Both' | 'Repo' | 'User';
  description: string;
}[] = [
  {
    name: 'mode',
    type: '"off" | "local" | "remote"',
    layer: 'Both',
    description:
      'Select the memory backend. off disables storage, local uses on-disk markdown, remote syncs to the hosted server.',
  },
  {
    name: 'store',
    type: 'string',
    layer: 'Both',
    description:
      'Project-tier store path for local mode, relative to the repo root or absolute. Defaults to .lorekit.',
  },
  {
    name: 'deny',
    type: '("local" | "remote")[]',
    layer: 'Both',
    description:
      'Forbid modes outright. Deny always wins and is a union across every layer — a ceiling no other layer can lift.',
  },
  {
    name: 'mcp.endpoint',
    type: 'string',
    layer: 'Repo',
    description:
      'Committable MCP URL without a token, so the connection can live in VCS. The token still comes from .mcp.json or LOREKIT_TOKEN.',
  },
  {
    name: 'tags.default',
    type: 'string[]',
    layer: 'Both',
    description:
      'Tags appended to every memory.write. Both layers are merged: repo tags first, then user tags.',
  },
  {
    name: 'scope.defaults',
    type: 'Record<string, { tags: string[] }>',
    layer: 'Repo',
    description:
      'Per-scope tag defaults, applied to writes whose scope starts with the key (prefix match, no wildcards). A team-level write policy.',
  },
  {
    name: 'hooks.disabled',
    type: '("SessionStart" | "PostToolUseFailure" | "Stop")[]',
    layer: 'Both',
    description:
      'Suppress specific lifecycle hook events. Union across layers — either layer can turn an event off.',
  },
  {
    name: 'hooks.adapter',
    type: '"claude" | "cursor" | "codex"',
    layer: 'Both',
    description:
      'Explicit host adapter when auto-detection is ambiguous. Repo wins over user.',
  },
  {
    name: 'telemetry.disabled',
    type: 'boolean',
    layer: 'Repo',
    description:
      'Team-level opt-out of anonymous CLI usage telemetry, read from .lorekit.json only. The env var LOREKIT_TELEMETRY=0 always wins if set.',
  },
  {
    name: 'dedupe.threshold',
    type: 'number (0–1)',
    layer: 'Repo',
    description:
      'Jaccard similarity cutoff for lorekit dedupe. The --threshold flag wins when passed explicitly. Defaults to 0.8.',
  },
];

const REPO_SNIPPET = `// .lorekit.json — repo root, safe to commit (no secrets)
{
  "mode": "local",
  "store": ".lorekit",
  "mcp.endpoint": "https://<ref>.supabase.co/functions/v1/mcp",
  "tags.default": ["team", "project::my-app"],
  "scope.defaults": {
    "repo::owner/name":     { "tags": ["team"] },
    "branch::owner/name::": { "tags": ["ephemeral"] }
  },
  "hooks.disabled": ["Stop"],
  "telemetry.disabled": true,
  "dedupe.threshold": 0.8
}`;

const USER_SNIPPET = `// ~/.lorekit/config.json — user/machine, not committed
{
  "deny": ["remote"],
  "tags.default": ["mads"],
  "hooks.adapter": "claude"
}`;

const ENV_VARS: [string, string][] = [
  ['LOREKIT_MODE', 'Select a mode: off / local / remote'],
  ['LOREKIT_DENY', 'Comma-separated modes to forbid (deny-wins), e.g. remote'],
  ['LOREKIT_HOME', 'Home-tier root + config directory (default ~/.lorekit)'],
  ['LOREKIT_STORE', 'Project-tier store directory (default .lorekit)'],
  ['LOREKIT_MCP_URL / LOREKIT_ENDPOINT', 'Endpoint fallback for remote mode'],
  ['LOREKIT_TOKEN', 'Token fallback for remote mode'],
  ['LOREKIT_TELEMETRY', 'Set to 0 / off / false to disable usage telemetry'],
  ['DO_NOT_TRACK', 'Set to 1 to disable usage telemetry (cross-vendor standard)'],
];

export default function LearnConfigPage() {
  return (
    <TutorialCard>
      <div className="flex flex-col gap-8">
        <div>
          <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">
            Configuration
          </h2>
          <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
            LoreKit reads two optional JSON config files that decide the memory mode, the store
            location, and write &amp; hook behaviour. Both files share the same schema and every
            field is optional — start with an empty file and add only what you need.
          </p>
        </div>

        {/* The two config files */}
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">The two config layers</p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Layer</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">File</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Scope</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                <tr className="text-[var(--color-content-secondary)]">
                  <td className="px-3 py-2">Repo / team</td>
                  <td className="px-3 py-2 font-mono">.lorekit.json</td>
                  <td className="px-3 py-2">Repo root — safe to commit, holds no secrets.</td>
                </tr>
                <tr className="text-[var(--color-content-secondary)]">
                  <td className="px-3 py-2">User / machine</td>
                  <td className="px-3 py-2 font-mono">~/.lorekit/config.json</td>
                  <td className="px-3 py-2">Personal overrides — not committed.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Property reference */}
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">Property reference</p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Property</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Type</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Layer</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {PROPERTIES.map((prop) => (
                  <tr key={prop.name} className="text-[var(--color-content-secondary)] align-top">
                    <td className="px-3 py-2 font-mono whitespace-nowrap text-[var(--color-content-primary)]">{prop.name}</td>
                    <td className="px-3 py-2 font-mono">{prop.type}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{prop.layer}</td>
                    <td className="px-3 py-2">{prop.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            <strong>Layer</strong> notes where a property is read from: <code>Both</code> layers,
            the <code>Repo</code> file only (team-level policy), or the <code>User</code> file only.
          </p>
        </div>

        {/* Examples */}
        <div className="flex flex-col">
          <TutorialStep number={1} title="Commit team defaults to .lorekit.json">
            <p>
              Put team-wide policy — the connection URL, default tags, per-scope write rules — in a{' '}
              <code>.lorekit.json</code> at the repo root. It carries no secrets, so it is safe to
              commit:
            </p>
            <pre className="mt-2"><code>{REPO_SNIPPET}</code></pre>
          </TutorialStep>

          <TutorialStep number={2} title="Keep personal overrides in ~/.lorekit/config.json">
            <p>
              Machine-local preferences live in <code>~/.lorekit/config.json</code>. This is where a
              privacy or compliance <code>deny</code> ceiling belongs — it can never be lifted by any
              repo default or env flag:
            </p>
            <pre className="mt-2"><code>{USER_SNIPPET}</code></pre>
          </TutorialStep>

          <TutorialStep number={3} title="Understand precedence & deny">
            <p>A <em>selection</em> (which mode to use) is resolved highest-precedence first:</p>
            <pre className="mt-2"><code>{`env LOREKIT_MODE → user config "mode" → repo config "mode" → built-in default ("remote")`}</code></pre>
            <p className="mt-2">
              A <em>constraint</em> (<code>deny</code>) always wins, regardless of the selection. Denies
              are a union across every layer and only accumulate:
            </p>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>
                A user with <code>&quot;deny&quot;: [&quot;remote&quot;]</code> can never be flipped to remote by a
                repo default or env flag.
              </li>
              <li>
                A repo or CI job with <code>&quot;deny&quot;: [&quot;local&quot;]</code> makes local unselectable
                there, even against <code>LOREKIT_MODE=local</code>.
              </li>
              <li>
                <code>off</code> is never deniable, so it is always the terminal fallback.
              </li>
            </ul>
          </TutorialStep>

          <TutorialStep number={4} title="Check the resolved mode">
            <p>
              Run the CLI doctor to see the resolved mode, <strong>which source decided it</strong>,
              and any active deny constraints:
            </p>
            <pre className="mt-2"><code>npx @lorekit/cli doctor</code></pre>
          </TutorialStep>
        </div>

        {/* Env var reference */}
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">Environment variables</p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            The core mode, store, and connection settings have env-var equivalents that outrank the
            config files — useful in CI where you cannot commit a config change.
          </p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Variable</th>
                  <th className="px-3 py-2 text-left font-medium text-[var(--color-content-secondary)]">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {ENV_VARS.map(([name, purpose]) => (
                  <tr key={name} className="text-[var(--color-content-secondary)] align-top">
                    <td className="px-3 py-2 font-mono whitespace-nowrap text-[var(--color-content-primary)]">{name}</td>
                    <td className="px-3 py-2">{purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <TutorialCallout variant="tip">
          Tokens never belong in <code>.lorekit.json</code> — it is meant to be committed. Keep the
          <code>lk_rw_…</code> token in your agent&apos;s <code>.mcp.json</code> (gitignored) or the
          <code>LOREKIT_TOKEN</code> env var. See the{' '}
          <Link href="/learn/setup" className="text-[var(--color-accent)] underline underline-offset-2">
            Getting started
          </Link>{' '}
          guide for the connection setup.
        </TutorialCallout>

        <TutorialCallout>
          <strong>Next:</strong> learn how scopes and tags shape what gets written and read in the{' '}
          <Link href="/learn/tags" className="text-[var(--color-accent)] underline underline-offset-2">
            Tags &amp; scopes
          </Link>{' '}
          tutorial.
        </TutorialCallout>
      </div>
    </TutorialCard>
  );
}
