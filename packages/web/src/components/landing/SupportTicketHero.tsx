'use client';

import { motion, useReducedMotion } from 'motion/react';

const REPLIES = [
  { age: '3 days ago', text: 'We use 2 spaces. Please follow the .editorconfig.' },
  { age: '1 week ago', text: '2 spaces throughout. Check the repo\'s .editorconfig.' },
  { age: '2 weeks ago', text: '2-space indentation. It\'s in the .editorconfig file.' },
  { age: '3 weeks ago', text: 'We use 2-space indentation everywhere.' },
  { age: '1 month ago', text: 'Indentation is 2 spaces...' },
] as const;

const RE_PREFIX = 'Re: Re: Re: Re: Re: ';
const SUBJECT_REST = 'What is the preferred indentation style for this codebase?';

export function SupportTicketHero() {
  const reducedMotion = useReducedMotion();

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Ticket panel */}
      <div
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden font-mono text-sm"
        role="article"
        aria-label="Support ticket showing repeated questions"
      >
        {/* Ticket header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <span className="text-[var(--color-content-tertiary)]">
            TICKET <span className="text-[var(--color-content-secondary)]">#00847</span>
          </span>
          <span className="text-[var(--color-content-tertiary)]">
            Status:{' '}
            <span className="text-[var(--color-error)] font-semibold">OPEN</span>
          </span>
        </div>

        {/* From / To */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-2.5 border-b border-[var(--color-border)] text-xs">
          <span className="text-[var(--color-content-tertiary)]">
            From:{' '}
            <span className="text-[var(--color-content-secondary)]">your-agent (automated)</span>
          </span>
          <span className="text-[var(--color-content-tertiary)]">
            To:{' '}
            <span className="text-[var(--color-content-secondary)]">you</span>
          </span>
        </div>

        {/* Subject */}
        <div className="px-5 py-3 border-b border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-content-tertiary)] mb-1">Subject:</p>
          <p className="text-sm leading-snug break-words">
            <span className="text-[var(--color-accent)]">{RE_PREFIX}</span>
            <span className="text-[var(--color-content-primary)]">{SUBJECT_REST}</span>
          </p>
        </div>

        {/* Replies */}
        <div className="divide-y divide-[var(--color-border)]">
          {REPLIES.map((reply, i) => (
            <motion.div
              key={reply.age}
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { delay: i * 0.15, duration: 0.35, ease: 'easeOut' }
              }
              className="px-5 py-3"
            >
              <p className="text-xs text-[var(--color-content-tertiary)] mb-1.5">
                ─── Reply from you · <span className="text-[var(--color-content-secondary)]">{reply.age}</span> ───
              </p>
              <p className="text-[var(--color-content-primary)] text-sm leading-relaxed">
                {reply.text}
              </p>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Headline + CTA link */}
      <motion.div
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reducedMotion ? { duration: 0 } : { delay: REPLIES.length * 0.15 + 0.2, duration: 0.4 }}
        className="mt-6 text-center"
      >
        <p className="text-[var(--color-content-secondary)] text-sm font-mono mb-2">
          Your agent files this ticket. Every session.
        </p>
      </motion.div>
    </div>
  );
}
