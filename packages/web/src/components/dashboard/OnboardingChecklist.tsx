'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Check, ChevronDown, ChevronRight, Copy, CheckCheck,
  ExternalLink, Terminal, Webhook, Zap
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CodeSnippetProps {
  code: string;
  language?: string;
}

function CodeSnippet({ code, language = 'bash' }: CodeSnippetProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="group relative mt-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <span className="font-mono text-[10px] text-[var(--color-content-tertiary)]">{language}</span>
        <button
          onClick={handleCopy}
          aria-label="Copy to clipboard"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-accent)]"
        >
          {copied ? (
            <><CheckCheck className="size-3" aria-hidden /> Copied</>
          ) : (
            <><Copy className="size-3" aria-hidden /> Copy</>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre">
        {code}
      </pre>
    </div>
  );
}

// ── Step content ──────────────────────────────────────────────────────────────

export interface OnboardingStep {
  id: string;
  title: string;
  subtitle: string;
  done: boolean;
  icon: React.ReactNode;
  content: React.ReactNode;
}

interface StepRowProps {
  step: OnboardingStep;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}

function StepRow({ step, index, isOpen, onToggle }: StepRowProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.06, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={[
        'rounded-xl border transition-all duration-200',
        step.done
          ? 'border-[var(--color-border-subtle)] bg-[var(--color-bg)]'
          : isOpen
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)]',
      ].join(' ')}
    >
      {/* Row header */}
      <button
        onClick={onToggle}
        disabled={step.done}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-3 p-4 text-left disabled:cursor-default"
      >
        {/* Check / icon */}
        <div
          className={[
            'flex size-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-300',
            step.done
              ? 'border-[var(--color-success)] bg-[var(--color-success)]'
              : isOpen
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-tertiary)]',
          ].join(' ')}
          aria-hidden
        >
          {step.done ? (
            <Check className="size-4 text-[#000]" strokeWidth={3} />
          ) : (
            step.icon
          )}
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
              {step.subtitle}
            </p>
          )}
        </div>

        {!step.done && (
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
        {isOpen && !step.done && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--color-accent)] border-opacity-30 px-4 pb-4 pt-3">
              {step.content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface OnboardingChecklistProps {
  steps: OnboardingStep[];
}

export function OnboardingChecklist({ steps }: OnboardingChecklistProps) {
  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;
  const progress = completedCount / steps.length;

  // Find the first incomplete step to auto-open it
  const firstIncompleteIndex = steps.findIndex((s) => !s.done);
  const [openIndex, setOpenIndex] = useState<number>(firstIncompleteIndex);
  const [headerExpanded, setHeaderExpanded] = useState(true);

  if (allDone) return null;

  function handleToggle(i: number) {
    setOpenIndex(openIndex === i ? -1 : i);
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]">
      {/* Header */}
      <button
        onClick={() => setHeaderExpanded((v) => !v)}
        aria-expanded={headerExpanded}
        className="flex w-full items-center gap-3 p-4 text-left"
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
            {completedCount}/{steps.length}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            Finish setting up LoreKit
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            {steps.length - completedCount} step{steps.length - completedCount > 1 ? 's' : ''} left
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
