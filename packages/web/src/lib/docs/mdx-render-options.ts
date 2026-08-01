import type { MDXRemoteProps } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { rehypeShiki, rehypeShikiOptions } from '@/lib/mdx/rehype-shiki';

/**
 * Shared `next-mdx-remote` options for rendering docs pages — the single place
 * both the `/docs/[slug]` page and its regression test read, so they can't drift.
 *
 * `blockJS: false` is load-bearing: next-mdx-remote 6 defaults it to `true`,
 * which strips JSX attribute *expressions* (e.g. `number={1}` on `TutorialStep`)
 * while leaving string attributes (`title="…"`) intact — so numbered-step badges
 * would render empty. Our MDX is authored in-repo (trusted), so we disable that
 * strip and keep `blockDangerousJS` at its default `true` (it only removes call
 * expressions, never the `{1}` literals we rely on). See `mdx-render.spec.ts`.
 */
export const docsMdxOptions: NonNullable<MDXRemoteProps['options']> = {
  blockJS: false,
  mdxOptions: {
    remarkPlugins: [remarkGfm],
    // Slug headings → highlight code (shared Shiki config with the blog) → wrap
    // headings in self-links.
    rehypePlugins: [
      rehypeSlug,
      [rehypeShiki, rehypeShikiOptions],
      [rehypeAutolinkHeadings, { behavior: 'wrap' }],
    ],
  },
};
