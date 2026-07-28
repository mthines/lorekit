'use client';

/**
 * DateRangePicker
 *
 * A self-contained calendar range picker matching the LoreKit design system
 * (no external date library). All values are UTC day strings ("YYYY-MM-DD") so
 * they line up exactly with the contribution heatmap cells and the day-bucketed
 * event aggregation — the whole activity feature operates in one date space.
 *
 * Interaction (see /animations interaction catalog — "popover / dropdown"):
 *   trigger → popover fades + scales from the top-right anchor; reversible;
 *   click-outside and Escape close it; reduced-motion collapses to a fade.
 *
 * Selection: first day click sets the anchor, second completes the range
 * (auto-ordered). Presets and a clear action cover the common cases.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface DateRange {
  /** Inclusive start, "YYYY-MM-DD" (UTC day). */
  from: string;
  /** Inclusive end, "YYYY-MM-DD" (UTC day). */
  to: string;
}

interface DateRangePickerProps {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  className?: string;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/** UTC day key for a Date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today as a UTC day string. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Shift a UTC day string by ±n days. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

/** "2026-07-24" → "Jul 24". */
function fmtShort(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** 42-cell (6-week) Monday-first grid of UTC dates for the given month view. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay() === 0 ? 6 : first.getUTCDay() - 1; // Mon=0…Sun=6
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - firstDow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d;
  });
}

export function DateRangePicker({ value, onChange, className = '' }: DateRangePickerProps) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Month currently shown in the calendar (defaults to the range end or today).
  const initialView = value?.to ?? todayKey();
  const [view, setView] = useState(() => {
    const d = new Date(`${initialView}T00:00:00Z`);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
  });

  // Close on click-outside.
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
      setAnchor(null);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setAnchor(null);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const grid = useMemo(() => monthGrid(view.year, view.month), [view]);

  function selectDay(day: string) {
    if (anchor === null) {
      setAnchor(day);
    } else {
      const [from, to] = anchor <= day ? [anchor, day] : [day, anchor];
      onChange({ from, to });
      setAnchor(null);
      setOpen(false);
    }
  }

  function applyPreset(days: number) {
    const to = todayKey();
    onChange({ from: addDays(to, -(days - 1)), to });
    setAnchor(null);
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setAnchor(null);
    setOpen(false);
  }

  const label = value ? `${fmtShort(value.from)} – ${fmtShort(value.to)}` : 'All time';
  const today = todayKey();

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={[
          // min-h-9 + rounded-lg + px-2.5/py-1.5 keeps this control the same
          // height and shape as the sibling "Archived" toggle in the Lore
          // Explorer filter row (LoreExplorer.tsx) so they read as one set.
          'flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors duration-150',
          value
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
        ].join(' ')}
      >
        <Calendar className="size-3.5 shrink-0" aria-hidden />
        {label}
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date range"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                clear();
              }
            }}
            className="-mr-1 ml-0.5 flex size-4 items-center justify-center rounded-full hover:bg-[var(--color-bg-elevated)]"
          >
            <X className="size-3" aria-hidden />
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Select date range"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-full z-40 mt-1.5 w-72 origin-top-right overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 shadow-lg"
          >
            {/* Presets */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[
                { label: '7d', days: 7 },
                { label: '30d', days: 30 },
                { label: '90d', days: 90 },
              ].map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => applyPreset(p.days)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-content-secondary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
                >
                  Last {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={clear}
                className="rounded-md px-2 py-0.5 text-[11px] text-[var(--color-content-tertiary)] transition-colors hover:text-[var(--color-content-primary)]"
              >
                All time
              </button>
            </div>

            {/* Month nav */}
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() =>
                  setView((v) =>
                    v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 },
                  )
                }
                className="flex size-6 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <span className="text-xs font-medium text-[var(--color-content-primary)]">
                {MONTHS[view.month]} {view.year}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() =>
                  setView((v) =>
                    v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 },
                  )
                }
                className="flex size-6 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]"
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </div>

            {/* Weekday header */}
            <div className="mb-1 grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((w) => (
                <span
                  key={w}
                  className="flex h-6 items-center justify-center text-[10px] font-medium text-[var(--color-content-tertiary)]"
                >
                  {w}
                </span>
              ))}
            </div>

            {/* Day grid */}
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((d) => {
                const key = dayKey(d);
                const inMonth = d.getUTCMonth() === view.month;
                const isToday = key === today;
                const rangeFrom = anchor ?? value?.from;
                const rangeTo = anchor ?? value?.to;
                const inRange =
                  !!rangeFrom && !!rangeTo && key >= (rangeFrom < rangeTo ? rangeFrom : rangeTo) && key <= (rangeFrom < rangeTo ? rangeTo : rangeFrom);
                const isEndpoint = key === value?.from || key === value?.to || key === anchor;

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => selectDay(key)}
                    aria-label={key}
                    aria-pressed={isEndpoint}
                    className={[
                      'flex h-7 items-center justify-center rounded-md text-[11px] tabular-nums transition-colors duration-100',
                      !inMonth ? 'text-[var(--color-content-tertiary)] opacity-40' : '',
                      isEndpoint
                        ? 'bg-[var(--color-accent)] font-semibold text-[#000]'
                        : inRange
                          ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                          : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                      isToday && !isEndpoint ? 'ring-1 ring-inset ring-[var(--color-border)]' : '',
                    ].join(' ')}
                  >
                    {d.getUTCDate()}
                  </button>
                );
              })}
            </div>

            {anchor && (
              <p className="mt-2 text-center text-[10px] text-[var(--color-content-tertiary)]">
                Pick the end date…
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
