import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';
import { LANDING_SECTION_ID } from './sections';
import { StepBadge } from './StepBadge';

type Step = {
  title: string;
  body: string;
  /** What the node looks like in practice — an illustration, `aria-hidden`. */
  visual: ReactNode;
  /** The MCP call that carries the lesson on to the NEXT step, if any. */
  handoff?: 'memory.write' | 'memory.list';
};

/**
 * "02 / how it works" — the mechanism as one left-to-right flow:
 * session A → `memory.write` → one store → `memory.list` → session B.
 *
 * This replaces two things that said the same thing twice: the README's ASCII
 * box diagram (which rendered with its top-right corner one column short of the
 * right edge, left-aligned in a frame twice its width) and three separate step
 * cards joined by a rule that only showed as stubs in the gaps between them.
 * Now each step IS a node of the diagram, so the picture and the prose are one
 * object, and the calls that connect them are labelled on the arrows.
 *
 * The example is the same lesson the live demo above writes (`fix/ssr-window`),
 * so a reader who watched the demo sees the same lesson take the same path.
 *
 * Below `lg` the flow turns vertical and the arrows point down.
 */
const STEPS: Step[] = [
  {
    title: 'Your agent writes what it learns',
    body: 'One memory.write call when something is worth keeping — a gotcha, a convention, a fix that took three attempts.',
    visual: <SessionANode />,
    handoff: 'memory.write',
  },
  {
    title: 'The lesson is stored under a scope',
    body: 'This branch, this repo, this project, or everywhere. The scope is what keeps one repository’s lore out of another’s.',
    visual: <StoreNode />,
    handoff: 'memory.list',
  },
  {
    title: 'The next session reads it back',
    body: 'Narrowest scope first, then wider — so an agent gets this repo’s lessons without drowning in everything else you have ever recorded.',
    visual: <SessionBNode />,
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
            One store. <span className="lk-gradient-text">Every agent, every machine.</span>
          </>
        }
        lede="Two MCP tool calls are the whole mechanic. The CLI wires the hooks that make your agent call them."
      />

      {/* `gap-x-20` is the arrow's runway: the horizontal handoff arrow lives in
          that gap, so its width and the gap are the same number. */}
      <ol className="grid gap-y-0 lg:grid-cols-3 lg:gap-x-20">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative flex flex-col items-center text-center">
            <div aria-hidden className="w-full">
              {step.visual}
            </div>

            <div className="mt-6 flex flex-col items-center">
              <StepBadge step={index + 1} />
              <h3 className="mb-2 mt-4 text-base font-semibold text-[var(--color-content-primary)]">
                {step.title}
              </h3>
              <p className="max-w-xs text-sm leading-relaxed text-[var(--color-content-secondary)]">
                {step.body}
              </p>
            </div>

            {step.handoff && <Handoff call={step.handoff} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The labelled arrow from one step to the next. Two renderings of the same
 * thing: vertical between stacked steps below `lg`, and horizontal in the grid
 * gap from `lg` up. The horizontal one is placed so its LINE, not its label,
 * meets the nodes at their middle: 44px top + 15px label + 4px gap + 5px to the
 * line's centre = 68px, half of the 136px node height.
 */
function Handoff({ call }: { call: Step['handoff'] }) {
  return (
    <>
      <div aria-hidden className="flex flex-col items-center gap-1 py-6 lg:hidden">
        <span className="h-6 w-px bg-gradient-to-b from-[var(--color-border)] to-[var(--color-accent)]" />
        <span className="font-mono text-[11px] text-[var(--color-accent)]">{call}</span>
        <span className="text-xs leading-none text-[var(--color-accent)]">▼</span>
      </div>

      <div
        aria-hidden
        className="absolute left-full top-[44px] hidden w-20 flex-col items-center gap-1 lg:flex"
      >
        <span className="font-mono text-[10px] text-[var(--color-accent)]">{call}</span>
        <span className="flex w-full items-center">
          <span className="h-px flex-1 bg-gradient-to-r from-[var(--color-border)] to-[var(--color-accent)]" />
          <span className="-ml-1 text-[10px] leading-none text-[var(--color-accent)]">▶</span>
        </span>
      </div>
    </>
  );
}

// ─── Nodes ──────────────────────────────────────────────────────────────────
// One fixed height so the handoff arrows meet every node at its middle.

const NODE =
  'flex h-[136px] flex-col justify-center gap-1.5 rounded-xl px-4 text-left font-mono text-[11px] leading-relaxed';

function NodeLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 text-[10px] uppercase tracking-widest text-[var(--color-content-secondary)]">
      {children}
    </span>
  );
}

function SessionANode() {
  return (
    <div className={cn(NODE, 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80')}>
      <NodeLabel>session A · any tool</NodeLabel>
      <span className="text-[var(--color-error)]">✗ window is not defined</span>
      <span className="text-[var(--color-content-primary)]">
        <span className="text-[var(--color-accent)]">agent ›</span> fixed with a typeof guard
      </span>
    </div>
  );
}

/** The store is the product, so it is the node that gets the amber frame. */
function StoreNode() {
  return (
    <div className={cn(NODE, 'lk-glow-frame')}>
      <NodeLabel>one store · local or hosted</NodeLabel>
      <span className="w-fit rounded border border-[var(--color-scope-repo)]/40 px-1.5 text-[var(--color-scope-repo)]">
        repo::acme/web
      </span>
      <span>
        <span className="text-[var(--color-accent)]">fix/ssr-window</span>{' '}
        <span className="text-[var(--color-content-secondary)]">“guard window with typeof”</span>
      </span>
    </div>
  );
}

function SessionBNode() {
  return (
    <div className={cn(NODE, 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80')}>
      <NodeLabel>session B · any machine</NodeLabel>
      <span className="text-[var(--color-scope-repo)]">↳ 1 lesson loaded</span>
      <span className="text-[var(--color-success)]">✓ right the first time</span>
    </div>
  );
}
