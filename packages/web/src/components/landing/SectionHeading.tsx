import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * The heading block every home-page section opens with: a mono eyebrow, the
 * section title, and an optional one-line lede.
 *
 * The eyebrow is the page's ornamental signature — `01 / the problem` in Fira
 * Code amber, the same voice as the scope strings and tool calls the product
 * itself prints — so the sections read as one document with a table of
 * contents rather than a stack of unrelated cards. Numbering is passed in, not
 * derived, because the page decides the reading order and a section must not
 * renumber itself when it is reused elsewhere.
 *
 * The title runs at 30–36px against 16px body copy (≥ 2× contrast). The
 * sections used to open with 20px headings over 14px text, which made every
 * section look like a sidebar card rather than a chapter.
 */
export function SectionHeading({
  id,
  eyebrow,
  title,
  lede,
  align = 'center',
}: {
  /** Target of the section's `aria-labelledby`. */
  id: string;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  align?: 'center' | 'left';
}) {
  const centered = align === 'center';

  return (
    <div className={cn('mb-10 flex flex-col gap-3', centered ? 'items-center text-center' : 'items-start')}>
      <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
        {eyebrow}
      </p>
      <h2
        id={id}
        className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-[var(--color-content-primary)] sm:text-4xl"
      >
        {title}
      </h2>
      {lede && (
        <p className="max-w-xl text-pretty text-base leading-relaxed text-[var(--color-content-secondary)]">
          {lede}
        </p>
      )}
    </div>
  );
}
