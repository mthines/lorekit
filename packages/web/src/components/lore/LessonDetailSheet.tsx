'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Bot, Zap, Tag, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { LessonEntry } from './LessonCard';

interface LessonDetailSheetProps {
  lesson: LessonEntry | null;
  onClose: () => void;
}

export function LessonDetailSheet({ lesson, onClose }: LessonDetailSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus close button on open; restore on close
  useEffect(() => {
    if (lesson) {
      const timer = setTimeout(() => closeRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [lesson]);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && lesson) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lesson, onClose]);

  return (
    <AnimatePresence>
      {lesson && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Panel — slides in from right */}
          <motion.aside
            key="panel"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-raised)] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Lesson detail"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] p-5">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant={lesson.scope_type}>{lesson.scope_type}</Badge>
                  <code className="text-xs text-[var(--color-content-tertiary)]">
                    {lesson.scope}
                  </code>
                </div>
                <code className="font-mono text-sm font-medium text-[var(--color-content-primary)]">
                  {lesson.key}
                </code>
              </div>
              <button
                ref={closeRef}
                onClick={onClose}
                aria-label="Close detail panel"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-all duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>

            {/* Body */}
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
              {/* Value */}
              <section aria-label="Lesson content">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                  Content
                </h2>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre-wrap">
                  {lesson.value}
                </div>
              </section>

              {/* Metadata */}
              <section aria-label="Metadata">
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                  Metadata
                </h2>
                <dl className="flex flex-col gap-2">
                  {lesson.source_agent && (
                    <div className="flex items-center gap-2 text-xs">
                      <Bot className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                      <dt className="text-[var(--color-content-tertiary)]">Source agent</dt>
                      <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                        {lesson.source_agent}
                      </dd>
                    </div>
                  )}
                  {lesson.trigger && (
                    <div className="flex items-center gap-2 text-xs">
                      <Zap className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                      <dt className="text-[var(--color-content-tertiary)]">Trigger</dt>
                      <dd className="ml-auto font-mono text-[var(--color-content-secondary)]">
                        {lesson.trigger}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs">
                    <Clock className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                    <dt className="text-[var(--color-content-tertiary)]">Last updated</dt>
                    <dd className="ml-auto text-[var(--color-content-secondary)]">
                      {new Date(lesson.updated_at).toLocaleString()}
                    </dd>
                  </div>
                </dl>
              </section>

              {/* Tags */}
              {lesson.tags.length > 0 && (
                <section aria-label="Tags">
                  <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
                    <Tag className="size-3" aria-hidden />
                    Tags
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {lesson.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--color-content-secondary)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
