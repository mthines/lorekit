'use client';

import Link from 'next/link';
import { ArrowRight, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { scopeType } from '@/lib/scope';

interface RecentLesson {
  scope: string;
  key: string;
  created_at: string;
}

interface RecentLessonsProps {
  lessons: RecentLesson[];
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

export function RecentLessons({ lessons }: RecentLessonsProps) {
  if (lessons.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
          Recently written
        </p>
        <Link
          href="/lore"
          className="flex items-center gap-1 text-[10px] text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-accent)]"
        >
          View all
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>

      <div className="flex flex-col gap-1.5">
        {lessons.map((lesson) => {
          const type = scopeType(lesson.scope);
          return (
            <Link
              key={`${lesson.scope}::${lesson.key}`}
              href={`/lore?scope=${encodeURIComponent(lesson.scope)}`}
              className="group flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2.5 transition-all duration-150 hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-bg-elevated)]"
            >
              <Badge variant={type}>{type}</Badge>

              <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-content-primary)]">
                {lesson.key}
              </code>

              <span className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-content-tertiary)]">
                <Clock className="size-3" aria-hidden />
                {relativeTime(lesson.created_at)}
              </span>

              <ArrowRight
                className="size-3.5 shrink-0 text-[var(--color-content-tertiary)] opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100"
                aria-hidden
              />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
