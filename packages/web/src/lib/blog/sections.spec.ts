import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { BLOG_SECTIONS, BLOG_SLUGS } from './sections';

/**
 * Drift guard for the blog's "registered everywhere" invariant (mirrors the docs
 * `sections.spec.ts`): the single BLOG_SECTIONS table and the MDX content files
 * must agree. A post that exists in one but not the other is unreachable or dead —
 * caught here at test time rather than as a 404.
 */

const BLOG_DIR = fileURLToPath(new URL('../../content/blog', import.meta.url));
const mdxFiles = readdirSync(BLOG_DIR).filter((f) => f.endsWith('.mdx'));

function frontmatter(slug: string) {
  return matter(readFileSync(`${BLOG_DIR}/${slug}.mdx`, 'utf8')).data as Record<string, unknown>;
}

describe('blog sections ↔ content files', () => {
  it('every section slug has a matching MDX file', () => {
    for (const slug of BLOG_SLUGS) {
      expect(mdxFiles, `missing src/content/blog/${slug}.mdx`).toContain(`${slug}.mdx`);
    }
  });

  it('has no orphan MDX file without a section entry', () => {
    for (const file of mdxFiles) {
      const slug = file.replace(/\.mdx$/, '');
      expect(BLOG_SLUGS, `orphan content file ${file}`).toContain(slug);
    }
  });

  it('every file has non-empty title + description + date + author frontmatter', () => {
    for (const slug of BLOG_SLUGS) {
      const fm = frontmatter(slug);
      for (const field of ['title', 'description', 'date', 'author'] as const) {
        expect(typeof fm[field], `${slug}: ${field}`).toBe('string');
        expect(String(fm[field]).length, `${slug}: ${field} empty`).toBeGreaterThan(0);
      }
      // ISO date shape so `formatPostDate` and <time dateTime> behave.
      expect(String(fm['date']), `${slug}: date must be YYYY-MM-DD`).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('section label + summary match the MDX title + description', () => {
    for (const section of BLOG_SECTIONS) {
      const fm = frontmatter(section.id);
      expect(fm['title'], `${section.id}: title must match section label`).toBe(section.label);
      expect(fm['description'], `${section.id}: description must match section summary`).toBe(
        section.summary,
      );
    }
  });

  it('frontmatter order agrees with the section listing order', () => {
    const byOrder = BLOG_SLUGS.map((slug) => ({ slug, order: Number(frontmatter(slug)['order']) }));
    for (const { slug, order } of byOrder) {
      expect(Number.isInteger(order), `${slug}: order must be an integer`).toBe(true);
    }
    const sorted = [...byOrder].sort((a, b) => a.order - b.order).map((x) => x.slug);
    expect(sorted).toEqual([...BLOG_SLUGS]);
  });
});
