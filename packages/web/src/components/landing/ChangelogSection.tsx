'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';

const ENTRIES = [
  { version: 'v0.12.0', text: 'Reminded agent: we use Zod for API validation' },
  { version: 'v0.11.0', text: 'Reminded agent: we use Zod for API validation' },
  { version: 'v0.10.0', text: 'Re-reminded agent: Zod. Not Yup.' },
  { version: 'v0.9.0 ', text: 'Told agent (again): Zod for validation' },
  { version: 'v0.8.0 ', text: 'Explained Zod preference to agent' },
  { version: 'v0.7.0 ', text: 'Same. Zod.' },
  { version: 'v∞     ', text: 'You could keep doing this.' },
] as const;

export function ChangelogSection() {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-80px' });
  const [visibleCount, setVisibleCount] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!isInView || started.current) return;
    started.current = true;

    if (reducedMotion) {
      setVisibleCount(ENTRIES.length);
      return;
    }

    let i = 0;
    const tick = () => {
      i += 1;
      setVisibleCount(i);
      if (i < ENTRIES.length) {
        setTimeout(tick, 750);
      }
    };
    setTimeout(tick, 200);
  }, [isInView, reducedMotion]);

  return (
    <section
      ref={ref}
      aria-label="Changelog — the same reminder, version after version"
      className="w-full max-w-2xl mx-auto"
    >
      <h2 className="text-xs font-mono text-[var(--color-content-tertiary)] mb-4 uppercase tracking-widest">
        ## CHANGELOG.md
      </h2>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden">
        <div className="px-5 py-4 space-y-2 font-mono text-sm">
          {ENTRIES.map((entry, i) => (
            <div
              key={entry.version}
              aria-hidden={i >= visibleCount}
              className="flex gap-4 transition-opacity duration-300"
              style={{ opacity: i < visibleCount ? 1 : 0 }}
            >
              <span
                className={
                  entry.version.trim() === 'v∞'
                    ? 'text-[var(--color-accent)] shrink-0 w-16'
                    : 'text-[var(--color-content-tertiary)] shrink-0 w-16'
                }
              >
                {entry.version}
              </span>
              <span
                className={
                  entry.version.trim() === 'v∞'
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-content-secondary)]'
                }
              >
                {entry.text}
              </span>
            </div>
          ))}
        </div>

        {/* Separator + product explanation */}
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={
            visibleCount >= ENTRIES.length
              ? { opacity: 1, y: 0 }
              : { opacity: 0, y: 6 }
          }
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="border-t border-[var(--color-accent)]/30 bg-[var(--color-accent-subtle)] px-5 py-4"
          aria-live="polite"
        >
          <p className="font-mono text-sm text-[var(--color-content-secondary)] leading-relaxed">
            Or give your agent a memory that survives sessions.{' '}
            <span className="text-[var(--color-accent)] select-all">npx @lorekit/cli install</span>
          </p>
        </motion.div>
      </div>
    </section>
  );
}
