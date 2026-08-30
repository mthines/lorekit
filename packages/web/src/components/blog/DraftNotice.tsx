import { Clock } from 'lucide-react';
import { formatPostDate } from '@/lib/blog/format';

/**
 * A subtle "not yet live" banner shown at the top of a future-dated post. It
 * only ever renders on preview/dev — in production drafts are filtered out and
 * 404 (see `getAllPosts` / `draftsVisible`), so this never reaches a real
 * reader. Names the scheduled release date so a reviewer knows when it goes live.
 */
export function DraftNotice({ date }: { date: string }) {
  return (
    <div
      role="status"
      className="mb-6 flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 font-mono text-xs text-[var(--color-accent)]"
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span>
        Preview — not yet live.{date && <> Scheduled for {formatPostDate(date)}.</>}
      </span>
    </div>
  );
}
