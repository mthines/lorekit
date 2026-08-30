import type { ReactNode } from 'react';

/**
 * Typographic shell for rendered MDX blog posts. Editorial cousin of
 * {@link DocsProse}: a larger, more comfortable reading measure (16px body,
 * relaxed leading) than the reference-dense docs, while sharing the same
 * code/table/blockquote treatment so the two surfaces feel like one product.
 *
 * `scroll-mt-28` on the headings keeps an anchored heading clear of the sticky
 * header + reading-progress bar when the TOC (or a deep link) jumps to it.
 *
 * Headings are wrapped in self-links by `rehype-autolink-headings`; those anchors
 * inherit the heading colour and carry no underline, so a heading never reads as
 * a body link — only body `a`s get the amber accent treatment.
 */
export function BlogProse({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        'text-base leading-relaxed text-[var(--color-content-secondary)]',
        // Headings
        '[&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[var(--color-content-primary)] [&_h2]:scroll-mt-28',
        '[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[var(--color-content-primary)] [&_h3]:scroll-mt-28',
        // Heading self-links (autolink wrap) — inherit, no underline, subtle hover.
        '[&_h2_a]:text-inherit [&_h2_a]:no-underline [&_h3_a]:text-inherit [&_h3_a]:no-underline',
        '[&_h2_a:hover]:text-[var(--color-accent)] [&_h3_a:hover]:text-[var(--color-accent)] [&_h2_a]:transition-colors [&_h3_a]:transition-colors',
        // Body
        '[&_p]:my-4 [&_p]:leading-relaxed',
        '[&_strong]:font-semibold [&_strong]:text-[var(--color-content-primary)]',
        // Body links
        '[&_p_a]:text-[var(--color-accent)] [&_p_a]:underline [&_p_a]:underline-offset-2 [&_li_a]:text-[var(--color-accent)] [&_li_a]:underline [&_li_a]:underline-offset-2',
        // Lists
        '[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ul>li]:my-2',
        '[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol>li]:my-2',
        // Inline code + fenced blocks (mirrors DocsProse)
        '[&_code]:rounded [&_code]:bg-[var(--color-bg-elevated)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
        '[&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--color-border)] [&_pre]:bg-[var(--color-bg-elevated)] [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-relaxed',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs',
        // Blockquotes
        '[&_blockquote]:my-5 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--color-accent)] [&_blockquote]:pl-4 [&_blockquote]:text-[var(--color-content-secondary)] [&_blockquote]:italic',
        // GFM tables
        '[&_table]:my-5 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
        '[&_th]:border [&_th]:border-[var(--color-border)] [&_th]:bg-[var(--color-bg-elevated)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left',
        '[&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
        // Horizontal rule
        '[&_hr]:my-10 [&_hr]:border-[var(--color-border)]',
        // Figures + images (e.g. embedded SVG diagrams)
        '[&_figure]:my-7',
        '[&_img]:mx-auto [&_img]:block [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-[var(--color-border)]',
        '[&_figcaption]:mt-2.5 [&_figcaption]:text-center [&_figcaption]:text-sm [&_figcaption]:italic [&_figcaption]:text-[var(--color-content-secondary)]',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
