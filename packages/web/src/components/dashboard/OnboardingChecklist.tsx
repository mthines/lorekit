'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Check, ChevronDown, ChevronRight, X, PartyPopper, RotateCcw, ListChecks,
} from 'lucide-react';
import { useOnboarding } from '@/components/providers/OnboardingProvider';
import type { OnboardingStep } from '@/lib/onboarding';

// Re-exported for callers that build steps and render the checklist together.
export type { OnboardingStep } from '@/lib/onboarding';

// ── Step row ────────────────────────────────────────────────────────────────

interface StepRowProps {
  step: OnboardingStep;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}

function StepRow({ step, index, isOpen, onToggle }: StepRowProps) {
  const { isDone, isServerDone, isManuallyDone, isMarkable, toggleDone } = useOnboarding();

  const done = isDone(step.id);
  const manuallyDone = isManuallyDone(step.id);
  // Offer the self-attest toggle only while there's no real server signal —
  // once a delivery actually lands, the step is genuinely done and un-marking
  // it would be a confusing no-op.
  const markable = isMarkable(step.id) && !isServerDone(step.id);

  // A step is expandable when it has content to reveal. Completed steps stay
  // expandable (collapsed by default) so their instructions and tokens remain
  // reachable — only steps with no content (e.g. "server is live") are inert.
  const expandable = step.content != null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.06, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={[
        'rounded-xl border transition-all duration-200',
        isOpen && expandable
          ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)]'
          : done
            ? 'border-[var(--color-border-subtle)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-raised)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      {/* Row header */}
      <button
        onClick={onToggle}
        disabled={!expandable}
        aria-expanded={expandable ? isOpen : undefined}
        className="flex w-full items-center gap-3 p-4 text-left disabled:cursor-default"
      >
        {/* Check / icon */}
        <div
          className={[
            'flex size-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-300',
            done
              ? 'border-[var(--color-success)] bg-[var(--color-success)]'
              : isOpen
                ? 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]',
          ].join(' ')}
          aria-hidden
        >
          {done ? (
            <Check className="size-4 text-[#000]" strokeWidth={3} />
          ) : (
            step.icon
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={[
              'text-sm font-medium',
              done
                ? 'text-[var(--color-content-tertiary)] line-through'
                : 'text-[var(--color-content-primary)]',
            ].join(' ')}
          >
            {step.title}
          </p>
          {!done && (
            <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">
              {step.subtitle}
            </p>
          )}
        </div>

        {expandable && (
          <ChevronRight
            className={[
              'size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200',
              isOpen ? 'rotate-90' : '',
            ].join(' ')}
            aria-hidden
          />
        )}
      </button>

      {/* Expandable content */}
      <AnimatePresence initial={false}>
        {isOpen && expandable && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3">
              {step.content}

              {/* Self-attest completion for steps with no reliable server signal. */}
              {markable && (
                <div className="mt-5 flex items-center gap-3 border-t border-[var(--color-border-subtle)] pt-4">
                  <button
                    onClick={() => toggleDone(step.id)}
                    className={[
                      'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors duration-150',
                      manuallyDone
                        ? 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:text-[var(--color-content-primary)]'
                        : 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[#000] hover:opacity-90',
                    ].join(' ')}
                  >
                    {manuallyDone ? (
                      <><RotateCcw className="size-4" aria-hidden /> Mark as not done</>
                    ) : (
                      <><Check className="size-4" aria-hidden /> I&apos;ve set up the webhook</>
                    )}
                  </button>
                  <p className="text-xs text-[var(--color-content-tertiary)]">
                    {manuallyDone
                      ? 'Marked complete. Memories will appear here once a delivery arrives.'
                      : 'Already added it on GitHub? Mark this step complete.'}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── "All set" state (dedicated page only) ─────────────────────────────────────

function AllSetPanel({ onReview }: { onReview: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-6 py-10 text-center"
    >
      <div className="flex size-11 items-center justify-center rounded-full border border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-success)]">
        <PartyPopper className="size-5" aria-hidden />
      </div>
      <p className="text-base font-semibold text-[var(--color-content-primary)]">
        You&apos;re all set
      </p>
      <p className="max-w-sm text-sm text-[var(--color-content-secondary)]">
        Every setup step is complete. Your agents can read and write lore, and PR
        review comments flow in automatically. You can revisit this page any time.
      </p>
      <button
        onClick={onReview}
        className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        <ListChecks className="size-4" aria-hidden />
        Review the steps
      </button>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface OnboardingChecklistProps {
  steps: OnboardingStep[];
  /**
   * `inline` (Overview): a dismissible first-run card that hides once complete
   * or dismissed. `page` (dedicated /onboarding): always shown, with a celebratory
   * state when everything is done. Both share the same provider-backed progress.
   */
  variant?: 'inline' | 'page';
}

export function OnboardingChecklist({ steps, variant = 'inline' }: OnboardingChecklistProps) {
  const { isDone, completedCount, total, allDone, dismissed, dismiss } = useOnboarding();

  // Auto-open the first incomplete step; on the dedicated page, keep the whole
  // panel expanded by default.
  const firstIncompleteIndex = steps.findIndex((s) => !isDone(s.id));
  const [openIndex, setOpenIndex] = useState<number>(
    firstIncompleteIndex === -1 ? 0 : firstIncompleteIndex,
  );
  const [headerExpanded, setHeaderExpanded] = useState(true);
  // On the dedicated page, "Review the steps" swaps the celebratory panel for
  // the full checklist so completed users can re-open every step on demand.
  const [reviewing, setReviewing] = useState(false);

  // Inline card retreats to the sidebar once complete or dismissed — the
  // persistent "Getting started" entry is the way back.
  if (variant === 'inline' && (allDone || dismissed)) return null;

  if (variant === 'page' && allDone && !reviewing) {
    return <AllSetPanel onReview={() => setReviewing(true)} />;
  }

  const progress = completedCount / total;
  const remaining = total - completedCount;

  function handleToggle(i: number) {
    setOpenIndex(openIndex === i ? -1 : i);
  }

  return (
    <div className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]">
      {/* Header */}
      <button
        onClick={() => setHeaderExpanded((v) => !v)}
        aria-expanded={headerExpanded}
        className={[
          'flex w-full items-center gap-3 p-4 text-left',
          variant === 'inline' ? 'pr-14' : '',
        ].join(' ')}
      >
        {/* Progress ring */}
        <div className="relative size-9 shrink-0" aria-hidden>
          <svg className="size-9 -rotate-90" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3"
              className="stroke-[var(--color-border)]" />
            <motion.circle
              cx="18" cy="18" r="15" fill="none" strokeWidth="3"
              strokeLinecap="round"
              className="stroke-[var(--color-accent)]"
              strokeDasharray={`${2 * Math.PI * 15}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 15 }}
              animate={{ strokeDashoffset: (1 - progress) * 2 * Math.PI * 15 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[var(--color-content-primary)]">
            {completedCount}/{total}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            {allDone ? 'Setup complete' : 'Finish setting up LoreKit'}
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            {allDone
              ? `All ${total} steps done`
              : `${remaining} step${remaining === 1 ? '' : 's'} left`}
          </p>
        </div>

        <ChevronDown
          className={[
            'size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200',
            headerExpanded ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden
        />
      </button>

      {/* Dismiss button — inline card only, kept outside the toggle button */}
      {variant === 'inline' && (
        <div className="absolute right-4 top-4 flex items-center gap-1">
          <button
            onClick={dismiss}
            aria-label="Hide onboarding checklist"
            title="Hide — reopen from Getting started in the sidebar"
            className="flex size-7 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* Step list */}
      <AnimatePresence initial={false}>
        {headerExpanded && (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-4">
              {steps.map((step, i) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={i}
                  isOpen={openIndex === i}
                  onToggle={() => handleToggle(i)}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
