'use client';

/**
 * FilterPill
 *
 * One committed condition in the Lore Explorer's filter bar, rendered as four
 * independently-actionable segments:
 *
 *   [icon + Label] [includes all] [perf, ci +2] [×]
 *
 * ## Why segments and not one button
 * The three questions a user asks of an applied filter are different questions:
 * "what is this filtering by" (read the type), "am I including or excluding"
 * (change the operator), "which values" (change the set). A single button can
 * only answer one of them, so it answers the least useful one and sends the
 * user back to the menu for the rest.
 *
 * The **type segment is deliberately inert** — no hover, no cursor change, no
 * menu. Changing a filter's type would invalidate every value it holds, so the
 * honest affordance is "remove it and add the other one", and pretending
 * otherwise costs a click and a surprise. This mirrors Linear, which documents
 * exactly this: clicking the type "will do nothing".
 *
 * ## Motion
 * Pills enter with a short fade + scale from 0.96 and leave the same way, so a
 * filter appearing under the bar reads as a consequence of the click that made
 * it. Reduced motion collapses both to a fade. The operator menu is a plain
 * conditional render — it is a five-row list opened dozens of times a session,
 * and animating it would only add latency to a decision the user has already
 * made.
 */

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, X } from 'lucide-react';
import {
  filterPhrase,
  operatorLabel,
  requireField,
  valueSummary,
  type Filter,
  type FilterOperator,
} from '@/lib/filters';
import { FIELD_ICONS } from './FilterMenu';

interface FilterPillProps {
  filter: Filter;
  onOperatorChange: (operator: FilterOperator) => void;
  /** Reopens the menu at this filter's value list. */
  onEditValues: () => void;
  onRemove: () => void;
}

export function FilterPill({
  filter,
  onOperatorChange,
  onEditValues,
  onRemove,
}: FilterPillProps) {
  const reduceMotion = useReducedMotion();
  const descriptor = requireField(filter.field);
  const Icon = FIELD_ICONS[filter.field];
  const [operatorOpen, setOperatorOpen] = useState(false);
  const operatorRef = useRef<HTMLDivElement>(null);
  const operatorTriggerRef = useRef<HTMLButtonElement>(null);
  const operatorListRef = useRef<HTMLDivElement>(null);

  const currentOperator = operatorLabel(filter.field, filter.operator, filter.values.length);
  const phrase = filterPhrase(filter);

  useEffect(() => {
    if (!operatorOpen) return;
    function onDown(e: MouseEvent) {
      if (operatorRef.current && !operatorRef.current.contains(e.target as Node)) {
        setOperatorOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [operatorOpen]);

  /** Close the operator list and put focus back where it was opened from. */
  function dismissOperator() {
    setOperatorOpen(false);
    operatorTriggerRef.current?.focus();
  }

  /**
   * Move focus by `delta` through the option buttons, wrapping. Roving DOM
   * focus rather than `FilterMenu`'s virtual `aria-activedescendant`: there is
   * no text input to hold focus here, and the list is two or three rows.
   */
  function moveOperatorFocus(delta: number) {
    const options = Array.from(
      operatorListRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current === -1
        ? delta > 0
          ? 0
          : options.length - 1
        : (current + delta + options.length) % options.length;
    options[next]?.focus();
  }

  /**
   * Keyboard for the operator list, handled on its wrapper so it covers both
   * the trigger (focus stays there after a click or Enter) and the options.
   *
   * Escape `stopPropagation`s for the same reason `FilterMenu` does: without
   * it the SAME Escape reaches `LessonDetailSheet`'s document listener and
   * closes an open lesson behind the filter bar. It also restores focus to the
   * trigger — dismissing a menu must not drop the user on `<body>`.
   */
  function handleOperatorKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!operatorOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismissOperator();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveOperatorFocus(e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  const segment =
    'flex min-h-7 items-center px-2 text-[11px] transition-colors duration-100';

  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      // `group` is not used for hover: each segment owns its own hover state,
      // because they are separate targets and a shared one would suggest the
      // whole pill is a single button.
      className="flex items-stretch overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      aria-label={phrase}
    >
      {/* Type — inert by design. A <span>, not a disabled button: a disabled
          button is still announced as a control the user cannot use, which is
          a worse answer than "this is a label". */}
      <span
        className={`${segment} gap-1.5 border-r border-[var(--color-border)] font-medium text-[var(--color-content-secondary)]`}
      >
        <Icon className="size-3 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        {descriptor.label}
      </span>

      {/* Operator */}
      <div ref={operatorRef} onKeyDown={handleOperatorKeyDown} className="relative flex">
        <button
          ref={operatorTriggerRef}
          type="button"
          onClick={() => setOperatorOpen((v) => !v)}
          aria-expanded={operatorOpen}
          aria-haspopup="listbox"
          aria-label={`${descriptor.label} ${currentOperator} — change operator`}
          className={`${segment} border-r border-[var(--color-border)] text-[var(--color-content-tertiary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]`}
        >
          {currentOperator}
        </button>

        {operatorOpen && (
          <div
            ref={operatorListRef}
            role="listbox"
            aria-label={`${descriptor.label} operator`}
            className="absolute left-0 top-full z-40 mt-1 min-w-36 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-1 shadow-lg"
          >
            {descriptor.operators.map((op) => {
              const selected = op === filter.operator;
              return (
                <button
                  key={op}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onOperatorChange(op);
                    dismissOperator();
                  }}
                  className={[
                    'flex w-full min-h-8 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-[var(--color-bg-elevated)]',
                    selected
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-content-secondary)]',
                  ].join(' ')}
                >
                  <Check className={selected ? 'size-3 shrink-0' : 'size-3 shrink-0 opacity-0'} aria-hidden />
                  {operatorLabel(filter.field, op, filter.values.length)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Values — the summary truncates, the accessible name never does: a
          screen-reader user has no `+2` to hover. */}
      <button
        type="button"
        onClick={onEditValues}
        aria-label={`${phrase} — change values`}
        title={filter.values.map(descriptor.format).join(', ')}
        className={`${segment} max-w-48 truncate font-medium text-[var(--color-content-primary)] hover:bg-[var(--color-bg-elevated)]`}
      >
        <span className="truncate">{valueSummary(filter.field, filter.values)}</span>
      </button>

      {/* Remove — 28px tall and 24px wide, clearing WCAG 2.5.8's minimum. */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${phrase}`}
        className="flex min-h-7 w-6 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-content-tertiary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
      >
        <X className="size-3" aria-hidden />
      </button>
    </motion.div>
  );
}
