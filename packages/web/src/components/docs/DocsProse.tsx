import type { ReactNode } from 'react';

/**
 * Typographic shell for rendered MDX docs. Styles the standard markdown
 * elements (headings, paragraphs, lists, code, pre, tables, links, blockquotes)
 * via Tailwind child selectors so the MDX component map only has to supply the
 * bespoke components (TutorialStep, TutorialCallout, GettingStartedContent).
 *
 * The `code`/`pre` treatment matches TutorialStep's exactly, so a step's inline
 * code and a top-level fenced block look identical.
 */
export function DocsProse({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        'text-sm text-[var(--color-content-secondary)]',
        // Headings
        '[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-[var(--color-content-primary)] [&_h2]:scroll-mt-24',
        '[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-[var(--color-content-primary)] [&_h3]:scroll-mt-24',
        // Body
        '[&_p]:my-3 [&_p]:leading-relaxed',
        '[&_strong]:font-semibold [&_strong]:text-[var(--color-content-primary)]',
        // Links
        '[&_a]:text-[var(--color-accent)] [&_a]:underline [&_a]:underline-offset-2',
        // Lists
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul>li]:my-1',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol>li]:my-1',
        // Inline code + fenced blocks (mirrors TutorialStep)
        '[&_code]:rounded [&_code]:bg-[var(--color-bg-elevated)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
        '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-elevated)] [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs',
        // A fenced block's inner <code> should not double-decorate.
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        // Blockquotes
        '[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-4 [&_blockquote]:italic',
        // GFM tables
        '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:border-[var(--color-border)] [&_th]:bg-[var(--color-bg-elevated)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left',
        '[&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
        // Horizontal rule
        '[&_hr]:my-8 [&_hr]:border-[var(--color-border)]',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
