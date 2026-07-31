import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cache } from 'react';
import matter from 'gray-matter';
import { DOCS_SLUGS } from './sections';

/**
 * Server-only docs content layer. Reads the MDX files under
 * `src/content/docs/*.mdx` (frontmatter + body), and derives the client
 * search index from the same source so the two can never drift.
 *
 * Everything is read at build time — `/docs/[slug]` is statically generated
 * (see its `generateStaticParams`) and the search index is embedded into the
 * static docs layout — so there is no runtime filesystem access on the hot path.
 */

const DOCS_DIR = join(process.cwd(), 'src/content/docs');

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  order: number;
  keywords: string[];
}

export interface Doc extends DocMeta {
  /** Raw MDX body (frontmatter stripped). */
  body: string;
}

/** One searchable record per doc page. */
export interface DocSearchRecord {
  id: string;
  slug: string;
  title: string;
  description: string;
  keywords: string;
  /** Flattened plain-text of the page body (JSX/markdown stripped, code kept). */
  text: string;
}

export const getDoc = cache((slug: string): Doc | null => {
  if (!DOCS_SLUGS.includes(slug)) return null;
  try {
    const raw = readFileSync(join(DOCS_DIR, `${slug}.mdx`), 'utf8');
    const { data, content } = matter(raw);
    return {
      slug,
      title: String(data['title'] ?? slug),
      description: String(data['description'] ?? ''),
      order: Number(data['order'] ?? 999),
      keywords: Array.isArray(data['keywords']) ? data['keywords'].map(String) : [],
      body: content,
    };
  } catch {
    return null;
  }
});

export const getAllDocs = cache((): Doc[] =>
  DOCS_SLUGS.map((slug) => getDoc(slug))
    .filter((d): d is Doc => d !== null)
    .sort((a, b) => a.order - b.order),
);

/**
 * Reduce an MDX body to searchable plain text: keep prose, code, list items,
 * and component `title="…"` attributes (the numbered-step / callout headings);
 * drop JSX tags, fence markers, and markdown punctuation. Deliberately literal
 * (no MDX compile) so it stays cheap and dependency-light.
 */
function toSearchText(body: string): string {
  return body
    // Surface `title="Step name"` attributes (TutorialStep/TutorialCallout headings).
    .replace(/\btitle="([^"]*)"/g, ' $1 ')
    // Strip fenced-code fence lines but keep the code content on its own lines.
    .replace(/```[a-zA-Z]*\n?/g, ' ')
    // Remove remaining JSX/HTML tags, keeping their text children.
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    // Markdown links → link text only.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Drop residual markdown punctuation.
    .replace(/[#*`_>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const getDocsSearchIndex = cache((): DocSearchRecord[] =>
  getAllDocs().map((doc) => ({
    id: doc.slug,
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    keywords: doc.keywords.join(' '),
    text: toSearchText(doc.body),
  })),
);
