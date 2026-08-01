import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { PostMeta } from '@/lib/blog/content';
import { formatPostDate, readingLabel } from '@/lib/blog/format';

/**
 * A single post row on the `/blog` index. Title-led hierarchy (the focal point),
 * a three-line description (`line-clamp-3`), and a monospace meta line (date ·
 * reading time) for the developer-tool feel. The whole card is the link; on hover
 * the accent border and the trailing arrow give a single, coherent "go here"
 * affordance.
 */
export function BlogPostCard({ post }: { post: PostMeta }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group block rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]/40 p-5 transition-colors duration-200 hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] sm:p-6"
    >
      <div className="flex items-center gap-2 font-mono text-xs text-[var(--color-content-tertiary)]">
        <time dateTime={post.date}>{formatPostDate(post.date)}</time>
        <span aria-hidden>·</span>
        <span>{readingLabel(post.readingMinutes)}</span>
      </div>

      <h2 className="mt-2 text-lg font-semibold tracking-tight text-[var(--color-content-primary)] group-hover:text-[var(--color-accent)]">
        {post.title}
      </h2>

      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--color-content-secondary)]">
        {post.description}
      </p>

      <div className="mt-4 flex items-center justify-between gap-3">
        {post.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
            {post.tags.slice(0, 3).map((tag) => (
              <li
                key={tag}
                className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-content-tertiary)]"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-[var(--color-content-tertiary)] transition-colors group-hover:text-[var(--color-accent)]">
          Read
          <ArrowRight
            className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </div>
    </Link>
  );
}
