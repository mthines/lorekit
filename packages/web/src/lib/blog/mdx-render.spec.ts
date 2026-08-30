import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { serialize } from 'next-mdx-remote/serialize';
import { blogMdxOptions } from './mdx-render-options';
import { extractToc } from './toc';
import { BLOG_SLUGS } from './sections';

/**
 * End-to-end guard for the blog's TOC invariant: the ids the scroll-spy sidebar
 * links to (from {@link extractToc}) must be exactly the ids the rendered
 * headings carry. The sidebar and the render derive ids from the SAME `slugify`
 * (via the in-house `rehypeHeadingIds` plugin), so this proves they can't drift —
 * and, by rendering the real post, that the whole MDX pipeline compiles.
 */

const POST = fileURLToPath(new URL('../../content/blog/self-healing-agents.mdx', import.meta.url));
const body = matter(readFileSync(POST, 'utf8')).content;

describe('blog MDX render (heading ids ↔ TOC)', () => {
  it('stamps every TOC id onto the rendered headings', async () => {
    const out = await serialize(body, blogMdxOptions);
    const ids = extractToc(body).map((t) => t.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      expect(out.compiledSource, `rendered output missing heading id "${id}"`).toContain(id);
    }
    // Generous timeout: the first serialize warms Shiki's highlighter + grammars
    // (a few seconds, once); warm calls are fast.
  }, 30_000);

  it('adds no heading ids without the plugin — the guard is not vacuous', async () => {
    // Default options run no id plugin, so the slugs must be absent. Uses a
    // distinctive heading so the assertion can't pass by coincidence.
    const out = await serialize('## A Very Distinctive Heading Here\n\nBody.\n');
    expect(out.compiledSource).not.toContain('a-very-distinctive-heading-here');
  });
});

const BLOG_DIR = fileURLToPath(new URL('../../content/blog', import.meta.url));

/**
 * Every registered post must compile through the real pipeline — not just
 * `self-healing-agents`. This is what catches a post that embeds raw JSX
 * (`<figure>`/`<img>`) or a malformed fence before it ships, since those only
 * fail at serialize time.
 */
describe('every blog post compiles through the MDX pipeline', () => {
  it.each([...BLOG_SLUGS])(
    'serializes %s (including any JSX figures) without throwing',
    async (slug) => {
      const raw = matter(readFileSync(`${BLOG_DIR}/${slug}.mdx`, 'utf8')).content;
      await expect(serialize(raw, blogMdxOptions)).resolves.toBeTruthy();
    },
    30_000,
  );
});
