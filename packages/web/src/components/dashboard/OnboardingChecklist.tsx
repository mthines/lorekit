'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, ChevronDown, ExternalLink } from 'lucide-react';

interface ChecklistStep {
  id: string;
  title: string;
  description: string;
  done: boolean;
  href?: string;
  linkLabel?: string;
}

interface OnboardingChecklistProps {
  steps: ChecklistStep[];
}

export function OnboardingChecklist({ steps }: OnboardingChecklistProps) {
  const [expanded, setExpanded] = useState(true);
  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;
  const progress = completedCount / steps.length;

  // Hide when everything is done and collapsed
  if (allDone) return null;

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="onboarding-steps"
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        {/* Progress ring (SVG, GPU-safe) */}
        <div className="relative size-9 shrink-0" aria-hidden>
          <svg className="size-9 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-[var(--color-border)]" />
            <motion.circle
              cx="18" cy="18" r="15"
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              className="stroke-[var(--color-accent)]"
              strokeDasharray={`${2 * Math.PI * 15}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 15 }}
              animate={{ strokeDashoffset: (1 - progress) * 2 * Math.PI * 15 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[var(--color-content-primary)]">
            {completedCount}/{steps.length}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            Get started with LoreKit
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            {completedCount === 0
              ? 'Complete these steps to unlock all features'
              : `${steps.length - completedCount} step${steps.length - completedCount > 1 ? 's' : ''} remaining`}
          </p>
        </div>

        <ChevronDown
          className={[
            'size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200',
            expanded ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden
        />
      </button>

      {/* Steps */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id="onboarding-steps"
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-col divide-y divide-[var(--color-border-subtle)] border-t border-[var(--color-border)] px-4 pb-4">
              {steps.map((step, i) => (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="flex items-start gap-3 py-3"
                >
                  {/* Check circle */}
                  <div
                    className={[
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-all duration-300',
                      step.done
                        ? 'border-[var(--color-success)] bg-[var(--color-success)]'
                        : 'border-[var(--color-border)] bg-transparent',
                    ].join(' ')}
                    aria-hidden
                  >
                    {step.done && <Check className="size-3 text-[#000]" strokeWidth={3} />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      className={[
                        'text-sm font-medium',
                        step.done
                          ? 'text-[var(--color-content-tertiary)] line-through'
                          : 'text-[var(--color-content-primary)]',
                      ].join(' ')}
                    >
                      {step.title}
                    </p>
                    {!step.done && (
                      <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">
                        {step.description}
                      </p>
                    )}
                  </div>

                  {step.href && !step.done && (
                    <a
                      href={step.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      {step.linkLabel ?? 'Go'}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
