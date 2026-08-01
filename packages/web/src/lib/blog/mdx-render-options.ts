import type { MDXRemoteProps } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { rehypeShiki, rehypeShikiOptions } from '@/lib/mdx/rehype-shiki';
import { slugify } from './toc';

/**
 * Shared `next-mdx-remote` options for rendering blog posts — the single place
 * the `/blog/[slug]` page and its regression test read, so they can't drift.
 *
 * Heading ids come from a tiny in-house rehype plugin ({@link rehypeHeadingIds})
 * rather than `rehype-slug`, because the scroll-spy sidebar generates its own ids
 * with {@link slugify} and the two MUST agree. Using the same function on both
 * sides removes the drift by construction — `rehype-slug`'s `github-slugger`
 * leaves arrows/em-dashes in ids and produces double hyphens the sidebar would
 * never guess. `rehype-autolink-headings` then wraps each (now id-bearing)
 * heading in a self-link, matching the docs' anchor behaviour.
 *
 * `blockJS: false` mirrors the docs options: next-mdx-remote defaults it to
 * `true`, which strips JSX attribute *expressions* (e.g. `variant={…}`). Blog
 * MDX is authored in-repo (trusted), so we disable that strip; `blockDangerousJS`
 * stays at its default `true`.
 */

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  value?: string;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Stamp `##`/`###` headings with `slugify()`'d ids, dedup-aware in exactly the
 * way {@link extractToc} is (`-1`, `-2`, … on repeats), so every sidebar link
 * resolves to a real anchor.
 */
function rehypeHeadingIds() {
  return (tree: unknown) => {
    const seen = new Map<string, number>();
    const walk = (node: HastNode) => {
      if (node.type === 'element' && (node.tagName === 'h2' || node.tagName === 'h3')) {
        const base = slugify(textOf(node)) || 'section';
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        node.properties = { ...(node.properties ?? {}), id };
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree as HastNode);
  };
}

export const blogMdxOptions: NonNullable<MDXRemoteProps['options']> = {
  blockJS: false,
  mdxOptions: {
    remarkPlugins: [remarkGfm],
    // Order: stamp heading ids → highlight code (Shiki) → wrap headings in
    // self-links. Shiki is independent of the heading plugins (it only touches
    // `pre > code`), but must run before serialization completes.
    rehypePlugins: [
      rehypeHeadingIds,
      [rehypeShiki, rehypeShikiOptions],
      [rehypeAutolinkHeadings, { behavior: 'wrap' }],
    ],
  },
};
