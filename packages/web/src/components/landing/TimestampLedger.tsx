'use client';

import { useEffect, useRef, useState } from 'react';
import { useInView, useReducedMotion } from 'motion/react';

const ROWS = [
  { date: '2026-05-12', question: "What's our DB naming convention?",   tokens: '1,847', cost: '$0.04' },
  { date: '2026-05-19', question: 'What naming convention for DB?',       tokens: '1,903', cost: '$0.04' },
  { date: '2026-05-26', question: 'How do we name DB columns?',           tokens: '1,891', cost: '$0.04' },
  { date: '2026-06-02', question: 'snake_case or camelCase for DB?',      tokens: '2,104', cost: '$0.05' },
  { date: '2026-06-09', question: 'Remind me: DB column naming?',         tokens: '1,923', cost: '$0.04' },
  { date: '2026-06-16', question: "What's the column naming rule?",       tokens: '1,856', cost: '$0.04' },
  { date: '2026-06-23', question: 'DB naming convention please',          tokens: '1,902', cost: '$0.04' },
] as const;

const TOTAL = {
  tokens: '13,426',
  cost: '$0.29',
};

const STAGGER_MS = 500;

export function TimestampLedger() {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-80px' });
  const [visibleCount, setVisibleCount] = useState(0);
  const [showTotal, setShowTotal] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!isInView || started.current) return;
    started.current = true;

    if (reducedMotion) {
      setVisibleCount(ROWS.length);
      setShowTotal(true);
      return;
    }

    let i = 0;
    const tick = () => {
      i += 1;
      setVisibleCount(i);
      if (i < ROWS.length) {
        setTimeout(tick, STAGGER_MS);
      } else {
        setTimeout(() => setShowTotal(true), STAGGER_MS);
      }
    };
    setTimeout(tick, 300);
  }, [isInView, reducedMotion]);

  return (
    <section
      ref={ref}
      aria-label="Token cost ledger — the same question across 7 sessions"
      className="w-full max-w-2xl mx-auto"
    >
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden">
        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs" aria-label="Repeated DB naming question ledger">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                <th scope="col" className="text-left px-4 py-3 text-[var(--color-content-tertiary)] font-normal w-28">DATE</th>
                <th scope="col" className="text-left px-4 py-3 text-[var(--color-content-tertiary)] font-normal">QUESTION</th>
                <th scope="col" className="text-right px-4 py-3 text-[var(--color-content-tertiary)] font-normal w-20">TOKENS</th>
                <th scope="col" className="text-right px-4 py-3 text-[var(--color-content-tertiary)] font-normal w-16">COST</th>
              </tr>
              <tr className="border-b border-[var(--color-border)]" aria-hidden>
                <td colSpan={4} className="px-4 py-0.5">
                  <div className="h-px bg-[var(--color-border)]" />
                </td>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => (
                <tr
                  key={row.date}
                  className="border-b border-[var(--color-border)] last:border-b-0 transition-opacity duration-300"
                  style={{ opacity: i < visibleCount ? 1 : 0 }}
                  aria-hidden={i >= visibleCount}
                >
                  <td className="px-4 py-2.5 text-[var(--color-content-tertiary)]">{row.date}</td>
                  <td className="px-4 py-2.5 text-[var(--color-content-secondary)]">{row.question}</td>
                  <td className="px-4 py-2.5 text-right text-[var(--color-content-tertiary)]">{row.tokens}</td>
                  <td className="px-4 py-2.5 text-right text-[var(--color-content-tertiary)]">{row.cost}</td>
                </tr>
              ))}
            </tbody>

            {/* Total row */}
            <tfoot>
              <tr aria-hidden>
                <td colSpan={4} className="px-4 py-0.5 border-t border-[var(--color-border)]">
                  <div className="h-px bg-[var(--color-border)]" />
                </td>
              </tr>
              <tr
                className="transition-opacity duration-500 bg-[var(--color-accent-subtle)]"
                style={{ opacity: showTotal ? 1 : 0 }}
                aria-hidden={!showTotal}
              >
                <td className="px-4 py-3 text-[var(--color-accent)] font-semibold">TOTAL (est.)</td>
                <td className="px-4 py-3 text-[var(--color-accent)]">Same question, 7 sessions</td>
                <td className="px-4 py-3 text-right text-[var(--color-accent)] font-semibold">{TOTAL.tokens}</td>
                <td className="px-4 py-3 text-right text-[var(--color-accent)] font-semibold">{TOTAL.cost}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Tagline */}
      <p
        className="mt-4 text-center font-mono text-xs text-[var(--color-content-tertiary)] transition-opacity duration-500"
        style={{ opacity: showTotal ? 1 : 0 }}
        aria-live="polite"
      >
        &ldquo;This is what forgetting costs. One token at a time.&rdquo;
      </p>
    </section>
  );
}
