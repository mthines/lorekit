'use client';

import { memo } from 'react';
import { motion } from 'motion/react';
import { Clock, Bot, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { ScopePrefix } from '@lorekit/core';

export interface LessonEntry {
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
  source_agent?: string | null;
  trigger?: string | null;
  scope: string;
  scope_type: ScopePrefix;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface LessonCardProps {
  lesson: LessonEntry;
  selected: boolean;
  onClick: () => void;
  index: number;
}

export const LessonCard = memo(function LessonCard({
  lesson,
  selected,
  onClick,
  index,
}: LessonCardProps) {
  const preview = lesson.value.slice(0, 160).replace(/\n/g, ' ');
  const truncated = lesson.value.length > 160;

  return (
    <motion.button
      onClick={onClick}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={[
        'group w-full rounded-xl border p-4 text-left transition-all duration-150',
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]'
          : 'border-[var(--color-border)] bg-[var(--color-bg-raised)] hover:border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
      aria-pressed={selected}
    >
      {/* Key */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <code
          className={[
            'truncate font-mono text-xs font-medium',
            selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-content-primary)]',
          ].join(' ')}
        >
          {lesson.key}
        </code>
        <Badge variant={lesson.scope_type}>{lesson.scope_type}</Badge>
      </div>

      {/* Value preview */}
      <p className="mb-3 line-clamp-2 text-xs text-[var(--color-content-secondary)]">
        {preview}
        {truncated && '…'}
      </p>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-2">
        {lesson.source_agent && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
            <Bot className="size-3" aria-hidden />
            {lesson.source_agent}
          </span>
        )}
        {lesson.trigger && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
            <Zap className="size-3" aria-hidden />
            {lesson.trigger}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
          <Clock className="size-3" aria-hidden />
          {relativeTime(lesson.updated_at)}
        </span>
      </div>

      {/* Tags */}
      {lesson.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {lesson.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-content-tertiary)]"
            >
              {tag}
            </span>
          ))}
          {lesson.tags.length > 4 && (
            <span className="rounded-md px-1.5 py-0.5 text-xs text-[var(--color-content-tertiary)]">
              +{lesson.tags.length - 4}
            </span>
          )}
        </div>
      )}
    </motion.button>
  );
});
