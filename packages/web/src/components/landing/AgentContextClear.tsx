'use client';

import { useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

const INITIAL_CONTENT = `# AGENT_CONTEXT.md

## Project conventions
- Use 2-space indentation
- snake_case for database columns
- Prefer functional components

## Architecture decisions
- Auth: Supabase RLS with row-level policies
- State: TanStack Query, no Redux
- API: tRPC with Zod validation

## Do not
- Use default exports
- Import from barrel files in /lib`;

type Phase = 'filling' | 'cleared' | 'revealed';

export function AgentContextClear() {
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<Phase>('filling');
  const [showCta, setShowCta] = useState(false);

  function handleEndSession() {
    setPhase('cleared');
    const delay = reducedMotion ? 0 : 600;
    setTimeout(() => {
      setPhase('revealed');
      const ctaDelay = reducedMotion ? 0 : 900;
      setTimeout(() => setShowCta(true), ctaDelay);
    }, delay);
  }

  function handleReset() {
    setPhase('filling');
    setShowCta(false);
  }

  return (
    <section
      aria-label="Interactive demo: agent context that doesn't survive sessions"
      className="w-full max-w-2xl mx-auto"
    >
      <div className="mb-6 text-center">
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)] mb-2">
          Every session starts here.
        </h2>
        <p className="text-sm text-[var(--color-content-secondary)]">
          Click &lsquo;End session&rsquo; to see what your agent experiences.
        </p>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] overflow-hidden">
        {/* Textarea */}
        <div className="relative">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
            <span className="font-mono text-xs text-[var(--color-content-tertiary)]">AGENT_CONTEXT.md</span>
            <span className="ml-auto text-xs text-[var(--color-success)] font-mono">● active</span>
          </div>
          <textarea
            aria-label="Agent context file contents"
            className="w-full h-56 px-4 py-3 bg-transparent font-mono text-sm text-[var(--color-content-primary)] resize-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] placeholder:text-[var(--color-content-tertiary)]"
            value={phase === 'filling' ? INITIAL_CONTENT : ''}
            onChange={() => {/* controlled but editable feel */}}
            readOnly={phase !== 'filling'}
            spellCheck={false}
          />
        </div>

        {/* Footer with button */}
        <div className="border-t border-[var(--color-border)] px-4 py-3 bg-[var(--color-bg-elevated)] flex items-center justify-between">
          {phase === 'filling' ? (
            <button
              onClick={handleEndSession}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 text-sm font-medium text-[var(--color-content-secondary)] transition-all duration-200 hover:border-[var(--color-error)] hover:text-[var(--color-error)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              End session →
            </button>
          ) : (
            <button
              onClick={handleReset}
              className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 text-sm font-medium text-[var(--color-content-tertiary)] transition-all duration-200 hover:text-[var(--color-content-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              ↺ New session
            </button>
          )}
          <span className="font-mono text-xs text-[var(--color-content-tertiary)]">
            {phase === 'filling' ? 'session: active' : 'session: terminated'}
          </span>
        </div>
      </div>

      {/* Post-clear revelation */}
      <AnimatePresence>
        {phase !== 'filling' && (
          <motion.div
            key="cleared-state"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-5 py-4 font-mono text-sm space-y-2"
            aria-live="assertive"
          >
            <p className="text-[var(--color-content-secondary)]">
              Session ended.{' '}
              <span className="text-[var(--color-error)]">Memory: none.</span>
            </p>
            <AnimatePresence>
              {phase === 'revealed' && (
                <motion.p
                  key="memory-line"
                  initial={reducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className="text-[var(--color-content-tertiary)] italic"
                >
                  &ldquo;You filled this out last Tuesday.&rdquo;
                </motion.p>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CTA fade-in */}
      <AnimatePresence>
        {showCta && (
          <motion.div
            key="cta"
            initial={reducedMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="mt-5 text-center"
          >
            <p className="text-sm text-[var(--color-content-secondary)]">
              Give your agent a memory that{' '}
              <span className="text-[var(--color-accent)] font-medium">survives the session.</span>
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
