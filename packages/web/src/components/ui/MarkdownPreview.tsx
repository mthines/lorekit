'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

/**
 * MarkdownPreview
 *
 * Renders untrusted, user/agent-authored markdown as **safe**, GitHub-flavored
 * output for read-only preview.
 *
 * ## Security (hard requirement — the value is untrusted free text)
 * Two independent layers keep it XSS-safe:
 *   1. `react-markdown` renders React ELEMENTS, not injected HTML — there is no
 *      `dangerouslySetInnerHTML` here. It also does NOT pass raw HTML embedded
 *      in the markdown through to the DOM unless `rehype-raw` is added (it is
 *      deliberately absent), so a literal `<script>` / `<img onerror>` in the
 *      value is shown as text, never executed.
 *   2. `rehype-sanitize` runs GitHub's own default schema over the produced
 *      HAST as defense-in-depth: it drops disallowed elements/attributes and
 *      unsafe URL protocols (e.g. `javascript:` in an `href`).
 *
 * ## Style
 * GitHub-flavored markdown via `remark-gfm` (tables, task lists, strikethrough,
 * autolinks), styled with the app's dark-only design tokens — never raw hex
 * (see packages/web/CLAUDE.md) — mirroring `DocsProse` so a rendered README / PR
 * comment reads the same across the product.
 */

// Token-based prose. Mirrors `DocsProse`'s vocabulary, tuned tighter for the
// narrow detail panel. The `pre`/`code` treatment matches `DocsProse` exactly so
// a fenced block looks identical to the docs.
const PROSE = [
  'text-sm leading-relaxed text-[var(--color-content-secondary)] break-words',
  // Reset the first child's top margin so the panel padding sets the top edge.
  '[&>*:first-child]:mt-0',
  // Headings
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-[var(--color-content-primary)]',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-[var(--color-content-primary)]',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-[var(--color-content-primary)]',
  '[&_h4]:mt-4 [&_h4]:mb-1.5 [&_h4]:text-xs [&_h4]:font-semibold [&_h4]:uppercase [&_h4]:tracking-wide [&_h4]:text-[var(--color-content-primary)]',
  // Body
  '[&_p]:my-2.5',
  '[&_strong]:font-semibold [&_strong]:text-[var(--color-content-primary)]',
  '[&_del]:text-[var(--color-content-tertiary)]',
  // Links
  '[&_a]:text-[var(--color-accent)] [&_a]:underline [&_a]:underline-offset-2 [&_a]:break-words',
  // Lists
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul>li]:my-1',
  '[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol>li]:my-1',
  // Inline code + fenced blocks (mirrors DocsProse)
  '[&_code]:rounded [&_code]:bg-[var(--color-bg-elevated)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-bg-elevated)] [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  // Blockquotes
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-content-tertiary)]',
  // GFM tables — scroll horizontally on the narrow panel rather than overflow.
  '[&_table]:my-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs',
  '[&_th]:border [&_th]:border-[var(--color-border)] [&_th]:bg-[var(--color-bg-elevated)] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-[var(--color-content-primary)]',
  '[&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top',
  // Images + horizontal rule
  '[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg',
  '[&_hr]:my-5 [&_hr]:border-[var(--color-border)]',
].join(' ');

const COMPONENTS: Components = {
  // Open links in a new tab. `href` has already been sanitized by
  // `rehype-sanitize`, so an unsafe protocol never reaches this point.
  a({ node, ...props }) {
    void node;
    return <a {...props} target="_blank" rel="noopener noreferrer" />;
  },
};

export interface MarkdownPreviewProps {
  /** Raw markdown source (untrusted). */
  value: string;
  /** Extra class applied to the prose wrapper. */
  className?: string;
}

export function MarkdownPreview({ value, className = '' }: MarkdownPreviewProps) {
  if (!value.trim()) {
    return (
      <p className="text-xs italic text-[var(--color-content-tertiary)]">Nothing to preview</p>
    );
  }

  return (
    <div className={['markdown-body', PROSE, className].join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={COMPONENTS}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
