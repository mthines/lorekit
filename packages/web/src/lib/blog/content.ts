import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cache } from 'react';
import matter from 'gray-matter';
import { BLOG_SLUGS } from './sections';
import { extractToc, type TocItem } from './toc';
import { isPublished, draftsVisibleIn } from './publish';
import { resolveDeploymentEnvironment } from '../otel-deployment-env';

/**
 * Whether future-dated drafts are listed and reachable in THIS deployment.
 * True on preview / development / local, false in production — so a draft is
 * previewable on Vercel but never leaks to prod (where it also 404s, since
 * `generateStaticParams` derives from {@link getAllPosts}). Resolved through the
 * shared `resolveDeploymentEnvironment` per the "VERCEL_ENV never decides alone"
 * rule.
 */
export const draftsVisible = (): boolean =>
  draftsVisibleIn(
    resolveDeploymentEnvironment(process.env.VERCEL_ENV, process.env.NODE_ENV).name,
  );

/**
 * Server-only blog content layer. Reads the MDX files under
 * `src/content/blog/*.mdx` (frontmatter + body) and derives the table of
 * contents from the same source, so the sidebar and the rendered headings can
 * never drift (see {@link extractToc} + `toc.ts`).
 *
 * Everything is read at build time — `/blog/[slug]` is statically generated (see
 * its `generateStaticParams`) — so there is no runtime filesystem access on the
 * hot path. Mirrors `lib/docs/content.ts`.
 */

const BLOG_DIR = join(process.cwd(), 'src/content/blog');

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  /** ISO date string (YYYY-MM-DD) from frontmatter. */
  date: string;
  author: string;
  /** Estimated reading time in minutes. */
  readingMinutes: number;
  tags: string[];
  /** Listing order — must agree with the `BLOG_SECTIONS` index. */
  order: number;
  keywords: string[];
  /**
   * A future-dated post not yet published. In production these are filtered out
   * entirely; on preview/dev they render with a "not yet live" notice.
   */
  isDraft: boolean;
}

export interface Post extends PostMeta {
  /** Raw MDX body (frontmatter stripped). */
  body: string;
  /** Extracted `##`/`###` headings for the scroll-spy sidebar. */
  toc: TocItem[];
}

export const getPost = cache((slug: string): Post | null => {
  if (!BLOG_SLUGS.includes(slug)) return null;
  try {
    const raw = readFileSync(join(BLOG_DIR, `${slug}.mdx`), 'utf8');
    const { data, content } = matter(raw);
    return {
      slug,
      title: String(data['title'] ?? slug),
      description: String(data['description'] ?? ''),
      date: String(data['date'] ?? ''),
      author: String(data['author'] ?? ''),
      readingMinutes: Number(data['readingMinutes'] ?? 0),
      tags: Array.isArray(data['tags']) ? data['tags'].map(String) : [],
      order: Number(data['order'] ?? 999),
      keywords: Array.isArray(data['keywords']) ? data['keywords'].map(String) : [],
      isDraft: !isPublished(String(data['date'] ?? '')),
      body: content,
      toc: extractToc(content),
    };
  } catch {
    return null;
  }
});

/**
 * Every VISIBLE post, **newest first by `date`** (ISO strings sort
 * chronologically; ties fall back to the registry `order`). In production,
 * future-dated drafts are omitted — which also removes them from
 * `generateStaticParams`, so with `dynamicParams = false` their URL 404s until
 * the date lands. On preview/dev, drafts are kept (listed with a badge and
 * reachable) so they can be reviewed before going live. This is the single seam
 * that gates draft visibility; the detail route relies on it rather than
 * re-checking, so the rule lives here.
 */
export const getAllPosts = cache((): Post[] => {
  const showDrafts = draftsVisible();
  return BLOG_SLUGS.map((slug) => getPost(slug))
    .filter((p): p is Post => p !== null)
    .filter((p) => showDrafts || !p.isDraft)
    .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
});
