import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cache } from 'react';
import matter from 'gray-matter';
import { BLOG_SLUGS } from './sections';
import { extractToc, type TocItem } from './toc';

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
      body: content,
      toc: extractToc(content),
    };
  } catch {
    return null;
  }
});

export const getAllPosts = cache((): Post[] =>
  BLOG_SLUGS.map((slug) => getPost(slug))
    .filter((p): p is Post => p !== null)
    .sort((a, b) => a.order - b.order),
);
