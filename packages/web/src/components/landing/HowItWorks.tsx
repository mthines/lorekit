import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';
import { StepBadge } from './StepBadge';
import { LANDING_SECTION_ID } from './sections';

type Step = {
  title: string;
  body: string;
  /** What the step looks like in practice — an illustration, `aria-hidden`. */
  visual: ReactNode;
};

/**
 * "02 / how it works" — from one laptop to the whole team.
 *
 * It used to retell the loop "01" already tells (session A writes → store →
 * session B reads), one section apart. The loop is the WHY; this section is
 * the HOW, and the how a visitor actually needs is the part "01" assumes: how
 * an agent gets connected, how a lesson stays with the repo it is about, and
 * how the teammate on day 4 came to have it at all. Every claim is current:
 *
 * - `install` wires skills, the MCP server and the four Claude Code hooks
 *   (`CLAUDE_HOOK_EVENTS` in `packages/cli/src/shared/config.mjs`) and reports
 *   the scope it read from the git remote. Cursor is three copied files
 *   (`plugins/lorekit-cursor/README.md`), so the copy says so.
 * - Scopes resolve narrow → broad: branch, repo, project, global
 *   (`docs/scope-format.md`).
 * - Team sharing is org-first: an admin binds a scope (or `repo::acme/*`) and
 *   writes under it route to one org-owned copy every member reads and writes;
 *   anything unbound stays personal (`/docs/organization`). CI reads with a
 *   read-only `lk_ro_` token.
 */
const STEPS: Step[] = [
  {
    title: 'Connect each agent',
    body: 'One command wires the MCP server, the skills and the hooks into Claude Code, and picks up your repo’s scope from its git remote. Cursor is three copied files.',
    visual: <InstallVisual />,
  },
  {
    title: 'Lessons stay with their repo',
    body: 'Every lesson lands under a scope: a branch, a repo, a project, or everywhere. Agents read narrowest first, so one repo’s lore never crowds another’s.',
    visual: <ScopeVisual />,
  },
  {
    title: 'One shared set for the team',
    body: 'Bind repo::acme/* to your org and every teammate’s agent reads and writes the same lessons — one copy, updated for everyone at once. CI reads with a read-only token; anything unbound stays personal.',
    visual: <TeamVisual />,
  },
];

export function HowItWorks() {
  return (
    <section aria-labelledby={LANDING_SECTION_ID.howItWorks} className="lk-reveal w-full max-w-5xl">
      <SectionHeading
        id={LANDING_SECTION_ID.howItWorks}
        eyebrow="02 / how it works"
        title={
          <>
            Wire it once.{' '}
            <span className="lk-gradient-text block">The whole team learns.</span>
          </>
        }
        lede="The teammate on day 4 got the lesson because of three things: every agent is connected, every lesson knows which repo it belongs to, and the team shares one store."
      />

      <ol className="grid gap-8 lg:grid-cols-3 lg:gap-5">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="lk-step flex flex-col"
            style={{ '--lk-step': index } as React.CSSProperties}
          >
            {/* One fixed height for all three pictures, so the step text below
                them starts on the same line in every column. */}
            <div aria-hidden className="h-[200px]">
              {step.visual}
            </div>
            <div className="mt-5 flex gap-4">
              <StepBadge step={index + 1} />
              <div>
                <h3 className="mb-1.5 text-base font-semibold text-[var(--color-content-primary)]">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
                  {step.body}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ─── Visuals ────────────────────────────────────────────────────────────────

const PANEL =
  'flex h-full flex-col rounded-2xl p-4 font-mono text-[11px] leading-relaxed';

function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-3 text-[10px] uppercase tracking-widest text-[var(--color-content-secondary)]">
      {children}
    </span>
  );
}

/** Mirrors the shape of `install`'s own status lines (skill / mcp / hooks / token / scope). */
function InstallVisual() {
  const rows = [
    { mark: '✓', label: 'skills', value: 'lorekit-memory +2' },
    { mark: '✓', label: 'mcp', value: 'lorekit → .mcp.json' },
    { mark: '✓', label: 'hooks', value: 'all · 4 lifecycle events' },
    { mark: '✓', label: 'token', value: 'read+write (lk_rw_*)' },
    { mark: '·', label: 'scope', value: 'repo::acme/api' },
  ];

  return (
    <div className={cn(PANEL, 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80')}>
      <PanelLabel>your machine · once</PanelLabel>
      <p className="mb-2 truncate text-[var(--color-content-primary)]">
        <span className="select-none text-[var(--color-content-secondary)]">$ </span>
        npx @lorekit/cli install
      </p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex gap-2 truncate">
            <span className={row.mark === '✓' ? 'text-[var(--color-success)]' : 'text-[var(--color-content-secondary)]'}>
              {row.mark}
            </span>
            <span className="w-[6ch] shrink-0 text-[var(--color-content-secondary)]">{row.label}</span>
            <span
              className={cn(
                'truncate',
                row.label === 'scope' ? 'text-[var(--color-scope-repo)]' : 'text-[var(--color-content-primary)]',
              )}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Narrow → broad, drawn as widening bars in the product's own scope colours.
 * The narrowest bar is 76 %, not less: at the three-column width (~280px of
 * panel) that is the least that still fits `branch::acme/api::feat/x` and its
 * order label without truncating the one string the picture is about.
 */
function ScopeVisual() {
  const scopes = [
    { scope: 'branch::acme/api::feat/x', order: '1st', color: 'var(--color-scope-branch)', width: 'w-[76%]' },
    { scope: 'repo::acme/api', order: '2nd', color: 'var(--color-scope-repo)', width: 'w-[84%]' },
    { scope: 'project::acme', order: '3rd', color: 'var(--color-scope-project)', width: 'w-[92%]' },
    { scope: 'global', order: 'last', color: 'var(--color-scope-global)', width: 'w-full' },
  ];

  return (
    <div className={cn(PANEL, 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80')}>
      <PanelLabel>read order · narrow → broad</PanelLabel>
      <ul className="flex flex-1 flex-col justify-between">
        {scopes.map((row) => (
          <li
            key={row.scope}
            className={cn(
              'flex items-center justify-between gap-2 rounded-md border-l-2 bg-[var(--color-bg)]/80 px-2.5 py-1.5',
              row.width,
            )}
            style={{ borderLeftColor: row.color }}
          >
            <span className="truncate" style={{ color: row.color }}>
              {row.scope}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--color-content-secondary)]">{row.order}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Three writers and readers, one org-owned copy. The store gets the amber frame. */
function TeamVisual() {
  const members = [
    { who: 'you · claude code', access: 'read+write' },
    { who: 'teammate · cursor', access: 'read+write' },
    { who: 'ci · lk_ro_ token', access: 'read-only' },
  ];

  return (
    <div className={cn(PANEL, 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80')}>
      <PanelLabel>org · acme</PanelLabel>
      <ul className="flex flex-col gap-1">
        {members.map((member) => (
          <li key={member.who} className="flex items-center justify-between gap-2">
            <span className="truncate text-[var(--color-content-primary)]">{member.who}</span>
            <span className="shrink-0 rounded border border-[var(--color-border)] px-1.5 text-[10px] text-[var(--color-content-secondary)]">
              {member.access}
            </span>
          </li>
        ))}
      </ul>
      <span className="my-1.5 text-center text-[var(--color-accent)]">↓ ↑</span>
      <div className="lk-glow-frame flex items-center justify-between gap-2 rounded-lg px-3 py-2 [--lk-frame-fill:var(--color-bg-elevated)]">
        <span className="truncate text-[var(--color-scope-repo)]">repo::acme/*</span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
          one shared copy
        </span>
      </div>
    </div>
  );
}
