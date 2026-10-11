import type { CSSProperties } from 'react';
import { Archive, Lightbulb, TrendingUp, Zap, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';
import { LANDING_SECTION_ID } from './sections';

type LineKind = 'command' | 'error' | 'agent' | 'lore' | 'added' | 'muted';

type Stage = {
  verb: string;
  when: string;
  icon: LucideIcon;
  lines: { kind: LineKind; text: string }[];
  /** The number the story is about: how much the same problem still costs. */
  stat: string;
  statCaption: string;
  outcome: string;
};

/**
 * One lesson's month, in four beats. Each beat is a mechanic LoreKit has today:
 *
 * 1. LEARNS — the hooks nudge the agent to write a lesson when a session hit
 *    friction (errored tool calls, a stuck loop); the agent writes it, not you.
 * 2. RECALLS — on a failing tool call the hook searches the store with the
 *    tool name and error text and injects up to three matching lessons before
 *    the agent retries (`packages/cli/src/core`, Claude Code's adapter).
 * 3. PROMOTES — a lesson re-written in later sessions accrues `seen_count`;
 *    session start ranks the most-recurring first, and the `lorekit-setup` loop
 *    hardens recurring lessons into permanent rules (Insights labels them
 *    "load-bearing — promote it to a rule").
 * 4. PRUNES — a retention policy archives lore nobody has opened in N days,
 *    swept nightly or reviewed by you; `lorekit restore` brings it back.
 *
 * The scenario and its numbers are a story, labelled as one in the UI — not a
 * measurement. What is literal is the mechanism in each beat.
 */
const STAGES: Stage[] = [
  {
    verb: 'Learns',
    when: 'day 1 · your laptop',
    icon: Lightbulb,
    lines: [
      { kind: 'command', text: 'pnpm test:integration' },
      { kind: 'error', text: '✗ ECONNREFUSED :5432  ×3' },
      { kind: 'agent', text: 'db not ready yet' },
      { kind: 'added', text: 'memory.write ci/pg-ready' },
    ],
    stat: '4',
    statCaption: 'tries',
    outcome: 'Fixed on the fourth try — and written down by the agent. Nobody asked it to.',
  },
  {
    verb: 'Recalls',
    when: 'day 4 · a teammate’s laptop',
    icon: Zap,
    lines: [
      { kind: 'command', text: 'pnpm test:integration' },
      { kind: 'error', text: '✗ ECONNREFUSED :5432' },
      { kind: 'lore', text: 'ci/pg-ready' },
      { kind: 'agent', text: 'waits on pg_isready' },
    ],
    stat: '1',
    statCaption: 'try',
    outcome: 'The lesson arrived with the error, on a machine that had never seen it.',
  },
  {
    verb: 'Promotes',
    when: 'day 9 · CI',
    icon: TrendingUp,
    lines: [
      { kind: 'muted', text: 'ci/pg-ready · seen 3×' },
      { kind: 'agent', text: 'recurring: promote' },
      { kind: 'added', text: 'rule: wait on pg_isready' },
    ],
    stat: '0',
    statCaption: 'tries',
    outcome: 'Three hits in three places earned it a permanent rule. Now it’s applied before the run.',
  },
  {
    verb: 'Prunes',
    when: 'day 90 · nightly sweep',
    icon: Archive,
    lines: [
      { kind: 'muted', text: 'policy · unopened ≥ 90 days' },
      { kind: 'muted', text: 'build/webpack-alias · 112d' },
      { kind: 'added', text: 'archived — restorable' },
    ],
    stat: '−1',
    statCaption: 'from context',
    outcome: 'Lore nobody opens stops riding along in every session. Archived, never deleted.',
  },
];

const COMPARISON = [
  {
    aspect: 'Written by',
    rulesFile: 'You, when you remember to.',
    lore: 'Your agents, the moment they hit friction.',
  },
  {
    aspect: 'Knows',
    rulesFile: 'What you predicted would matter.',
    lore: 'What actually broke — and the fix that worked.',
  },
  {
    aspect: 'Shows up',
    rulesFile: 'All of it, every session.',
    lore: 'What matches: at session start, on each prompt, on the failing call.',
  },
  {
    aspect: 'Over time',
    rulesFile: 'Grows until someone prunes it.',
    lore: 'Promotes what recurs. Archives what nobody uses.',
  },
] as const;

/**
 * "01 / why not just CLAUDE.md?" — the page's differentiator, stated as the
 * objection a developer actually has.
 *
 * The section it replaces showed a convention ("Zod, not Yup") being written
 * once and read back. True, but it is exactly what a rules file already does,
 * so it argued for a CLAUDE.md line rather than for LoreKit. What a rules file
 * CANNOT do is the loop: learn something nobody knew to write down, hand it to
 * the next agent at the moment the same error recurs, notice it recurring and
 * promote it, and retire what stopped earning its place. That is the story the
 * timeline tells, and the comparison underneath states it plainly for whoever
 * skipped the picture.
 *
 * Positioned as complementary, not a replacement: promotion ends in a rule, so
 * LoreKit is how a team finds out what deserves to be in its CLAUDE.md.
 */
export function LearningLoop() {
  return (
    <section aria-labelledby={LANDING_SECTION_ID.learningLoop} className="lk-reveal w-full max-w-6xl">
      <SectionHeading
        id={LANDING_SECTION_ID.learningLoop}
        eyebrow="01 / why not just a CLAUDE.md?"
        title={
          <>
            Your CLAUDE.md is frozen.{' '}
            <span className="lk-gradient-text block">Your lore keeps learning.</span>
          </>
        }
        lede="A rules file holds what you knew to write down before anything broke. LoreKit captures what your agents find out the hard way — and keeps sorting it: what recurs becomes a rule, what nobody uses gets archived."
      />

      <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-content-secondary)]">
        a month in the life of one lesson
      </p>

      {/* Four across only from `xl`: below 1280px a quarter of the row leaves
          the transcripts ~26 monospace characters, and every line is written
          to fit 28. Two columns from `sm`, one below. */}
      <ol className="relative grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* The rail through the four stage icons, drawn left to right as the
            section scrolls in (`lk-draw`); fully drawn at rest. It stops at the
            last icon's centre: 25 % of the row minus ¾ of the 16px gap and the
            18px icon radius. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-[18px] right-[calc(25%-30px)] top-[18px] hidden h-px xl:block"
        >
          <span className="lk-draw block h-full w-full bg-gradient-to-r from-[var(--color-accent)]/30 via-[var(--color-accent)] to-[var(--color-accent)]/30" />
        </span>

        {STAGES.map((stage, index) => (
          <StageCard key={stage.verb} stage={stage} index={index} />
        ))}
      </ol>

      {/* The loop closing: from the last beat back to the first. Wide screens
          only — stacked, the cards already read top to bottom. */}
      <div aria-hidden className="relative mx-[12.5%] mt-3 hidden xl:block">
        <div className="h-8 rounded-b-3xl border-x border-b border-dashed border-[var(--color-accent)]/40" />
        <span className="absolute -top-1.5 left-0 -translate-x-1/2 text-[10px] leading-none text-[var(--color-accent)]">
          ▲
        </span>
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 bg-[var(--color-bg)] px-3 font-mono text-[11px] text-[var(--color-accent)]">
          and round again — every session, every agent
        </span>
      </div>

      <ComparisonTable />
    </section>
  );
}

function StageCard({ stage, index }: { stage: Stage; index: number }) {
  const Icon = stage.icon;
  const isPromotion = stage.verb === 'Promotes';

  return (
    <li
      className="lk-step relative flex flex-col"
      style={{ '--lk-step': index } as CSSProperties}
    >
      <div className="mb-3 flex items-center gap-3">
        {/* Opaque, and above the rail, so the rail reads as running THROUGH the
            icons rather than over them. */}
        <span
          aria-hidden
          className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/50 bg-[var(--color-bg-elevated)] text-[var(--color-accent)] shadow-[0_0_20px_var(--color-accent-glow)]"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-content-secondary)]">
            {stage.when}
          </p>
          <h3 className="text-base font-semibold text-[var(--color-content-primary)]">{stage.verb}</h3>
        </div>
      </div>

      <div
        className={cn(
          'flex flex-1 flex-col rounded-2xl p-4',
          isPromotion
            ? 'lk-glow-frame'
            : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80',
        )}
      >
        <div className="mb-4 flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-3xl font-bold tabular-nums tracking-tight',
              index === 0 ? 'text-[var(--color-content-primary)]' : 'lk-gradient-text',
            )}
          >
            {stage.stat}
          </span>
          <span className="text-xs text-[var(--color-content-secondary)]">{stage.statCaption}</span>
        </div>

        <ol
          aria-hidden
          className="mb-4 flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/80 p-3 font-mono text-[11px] leading-relaxed"
        >
          {stage.lines.map((line) => (
            <TranscriptLine key={line.text} kind={line.kind} text={line.text} />
          ))}
        </ol>

        <p className="mt-auto text-sm leading-relaxed text-[var(--color-content-secondary)]">
          {stage.outcome}
        </p>
      </div>
    </li>
  );
}

function TranscriptLine({ kind, text }: { kind: LineKind; text: string }) {
  switch (kind) {
    case 'command':
      return (
        <li className="truncate text-[var(--color-content-primary)]">
          <span className="select-none text-[var(--color-content-secondary)]">$ </span>
          {text}
        </li>
      );
    case 'error':
      return <li className="truncate text-[var(--color-error)]">{text}</li>;
    case 'agent':
      return (
        <li className="truncate text-[var(--color-content-primary)]">
          <span className="text-[var(--color-accent)]">agent › </span>
          {text}
        </li>
      );
    case 'lore':
      return (
        <li className="truncate text-[var(--color-scope-repo)]">
          ↳ lore › <span className="text-[var(--color-accent)]">{text}</span>
        </li>
      );
    case 'added':
      return <li className="truncate text-[var(--color-success)]">+ {text}</li>;
    case 'muted':
      return <li className="truncate text-[var(--color-content-secondary)]">{text}</li>;
  }
}

function ComparisonTable() {
  return (
    <div className="mx-auto mt-16 max-w-4xl">
      <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">A rules file compared with LoreKit</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th scope="col" className="w-[22%] px-4 py-3 sm:px-6">
                <span className="sr-only">Aspect</span>
              </th>
              <th
                scope="col"
                className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-widest text-[var(--color-content-secondary)] sm:px-6"
              >
                CLAUDE.md / AGENTS.md
              </th>
              <th
                scope="col"
                className="bg-[var(--color-accent-subtle)] px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-widest text-[var(--color-accent)] sm:px-6"
              >
                LoreKit
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {COMPARISON.map((row) => (
              <tr key={row.aspect}>
                <th
                  scope="row"
                  className="px-4 py-4 align-top font-mono text-[11px] font-medium uppercase tracking-widest text-[var(--color-content-secondary)] sm:px-6"
                >
                  {row.aspect}
                </th>
                <td className="px-4 py-4 align-top text-[var(--color-content-secondary)] sm:px-6">
                  {row.rulesFile}
                </td>
                <td className="bg-[var(--color-accent-subtle)]/60 px-4 py-4 align-top font-medium text-[var(--color-content-primary)] sm:px-6">
                  {row.lore}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-5 text-center text-sm text-[var(--color-content-primary)]">
        Keep your CLAUDE.md. LoreKit is how you find out what has earned a place in it.
      </p>
      <p className="mt-2 text-center text-xs text-[var(--color-content-secondary)]">
        Error-matched recall runs on Claude Code’s hooks; Cursor reads lessons through its
        rule and an end-of-turn hook.
      </p>
    </div>
  );
}
