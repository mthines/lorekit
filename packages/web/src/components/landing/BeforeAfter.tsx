import { Check, X } from 'lucide-react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';

type TranscriptLine = {
  day: string;
  who: 'you' | 'agent';
  text: string;
  /** The line that lands the point — the relapse, or the remembered answer. */
  emphasis?: boolean;
};

const WITHOUT: TranscriptLine[] = [
  { day: 'mon', who: 'you', text: 'we validate with Zod here, not Yup' },
  { day: 'tue', who: 'you', text: 'reminder: Zod, not Yup' },
  { day: 'wed', who: 'you', text: 'again — Zod.' },
  { day: 'thu', who: 'agent', text: 'pnpm add yup', emphasis: true },
];

const WITH: TranscriptLine[] = [
  { day: 'mon', who: 'agent', text: 'memory.write  conventions/validation  "Zod, not Yup"' },
  { day: 'tue', who: 'agent', text: 'memory.list   ↳ 1 lesson loaded' },
  { day: 'wed', who: 'agent', text: 'memory.list   ↳ 1 lesson loaded' },
  { day: 'thu', who: 'agent', text: 'import { z } from "zod"', emphasis: true },
];

/**
 * "01 / the problem" — the cost of forgetting, shown rather than described.
 *
 * The demo above it shows the MECHANISM (session A writes, session B reads).
 * This section shows what that is worth to the person at the keyboard: the
 * same sentence typed four days running, and the relapse anyway. It is the one
 * part of the page that argues with feeling instead of facts, so it stays a
 * single, recognisable scene — a convention every reader has had to repeat —
 * rather than an invented statistic about hours lost.
 *
 * The "with" column uses the real tool names and the real `memory.list` output
 * shape, so it promises exactly what the product does: a lesson written once
 * is read back in later sessions. It does not claim the agent can never
 * relapse — that depends on the agent reading what it is given.
 *
 * Server-rendered and static; the transcripts are presentational, so each
 * column also carries a plain-language summary line for screen readers and
 * skimmers alike.
 */
export function BeforeAfter() {
  return (
    <section aria-labelledby="the-problem" className="lk-reveal w-full max-w-5xl">
      <SectionHeading
        id="the-problem"
        eyebrow="01 / the problem"
        title={
          <>
            Every session starts from zero.{' '}
            <span className="lk-gradient-text">Yours don’t have to.</span>
          </>
        }
        lede="The agent that untangled your build an hour ago has no memory of it now. So you re-explain — and it still gets it wrong on Thursday."
      />

      <div className="grid gap-5 md:grid-cols-2">
        <TranscriptCard
          variant="without"
          title="Without LoreKit"
          summary="You repeat yourself every session, and it still slips."
          lines={WITHOUT}
        />
        <TranscriptCard
          variant="with"
          title="With LoreKit"
          summary="Said once. Read back in every session after."
          lines={WITH}
        />
      </div>
    </section>
  );
}

function TranscriptCard({
  variant,
  title,
  summary,
  lines,
}: {
  variant: 'without' | 'with';
  title: string;
  summary: string;
  lines: TranscriptLine[];
}) {
  const isWith = variant === 'with';
  const Icon = isWith ? Check : X;

  return (
    <article
      aria-label={title}
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl',
        isWith
          ? 'lk-glow-frame'
          : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/70',
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-5 py-3.5">
        <span
          aria-hidden
          className={cn(
            'flex size-6 items-center justify-center rounded-full',
            isWith
              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
              : 'bg-[var(--color-bg-elevated)] text-[var(--color-error)]',
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">{title}</h3>
      </header>

      <ol aria-hidden className="flex flex-1 flex-col gap-2.5 px-5 py-5 font-mono text-xs leading-relaxed sm:text-[13px]">
        {lines.map((line) => (
          <li key={`${line.day}-${line.text}`} className="flex gap-3">
            <span className="w-7 shrink-0 text-[var(--color-content-secondary)]">{line.day}</span>
            <span
              className={cn(
                'w-11 shrink-0',
                line.who === 'you'
                  ? 'text-[var(--color-scope-repo)]'
                  : 'text-[var(--color-accent)]',
              )}
            >
              {line.who} ›
            </span>
            <span
              className={cn(
                'min-w-0 break-words',
                line.emphasis
                  ? isWith
                    ? 'text-[var(--color-success)]'
                    : 'text-[var(--color-error)] line-through decoration-[var(--color-error)]/60'
                  : 'text-[var(--color-content-primary)]',
              )}
            >
              {line.text}
            </span>
          </li>
        ))}
      </ol>

      <p
        className={cn(
          'border-t border-[var(--color-border)] px-5 py-3.5 text-sm',
          isWith
            ? 'font-medium text-[var(--color-content-primary)]'
            : 'text-[var(--color-content-secondary)]',
        )}
      >
        {summary}
      </p>
    </article>
  );
}
