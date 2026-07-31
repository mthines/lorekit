import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { DOCS_SECTIONS, DOCS_SLUGS, DOCS_NAV_ITEMS } from './sections';

/**
 * Drift guard for the public docs "registered everywhere" invariant: the single
 * DOCS_SECTIONS table, the MDX content files, and the nav rail must all agree.
 * A page that exists in one but not the others is unreachable or dead — this
 * catches that at test time rather than as a 404.
 */

const DOCS_DIR = fileURLToPath(new URL('../../content/docs', import.meta.url));
const mdxFiles = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.mdx'));

function frontmatter(slug: string) {
  return matter(readFileSync(`${DOCS_DIR}/${slug}.mdx`, 'utf8')).data as Record<string, unknown>;
}

describe('docs sections ↔ content files', () => {
  it('every section slug has a matching MDX file', () => {
    for (const slug of DOCS_SLUGS) {
      expect(mdxFiles, `missing src/content/docs/${slug}.mdx`).toContain(`${slug}.mdx`);
    }
  });

  it('has no orphan MDX file without a section entry', () => {
    for (const file of mdxFiles) {
      const slug = file.replace(/\.mdx$/, '');
      expect(DOCS_SLUGS, `orphan content file ${file}`).toContain(slug);
    }
  });

  it('every file has non-empty title + description frontmatter', () => {
    for (const slug of DOCS_SLUGS) {
      const fm = frontmatter(slug);
      expect(typeof fm['title'], `${slug}: title`).toBe('string');
      expect(String(fm['title']).length).toBeGreaterThan(0);
      expect(typeof fm['description'], `${slug}: description`).toBe('string');
      expect(String(fm['description']).length).toBeGreaterThan(0);
    }
  });

  it('frontmatter order agrees with the section reading order', () => {
    const byOrder = DOCS_SLUGS
      .map((slug) => ({ slug, order: Number(frontmatter(slug)['order']) }));
    for (const { slug, order } of byOrder) {
      expect(Number.isInteger(order), `${slug}: order must be an integer`).toBe(true);
    }
    const sorted = [...byOrder].sort((a, b) => a.order - b.order).map((x) => x.slug);
    expect(sorted).toEqual([...DOCS_SLUGS]);
  });
});

describe('docs nav items', () => {
  it('links every section to /docs/<slug>', () => {
    for (const section of DOCS_SECTIONS) {
      const item = DOCS_NAV_ITEMS.find((i) => i.id === section.id);
      expect(item, `nav item for ${section.id}`).toBeDefined();
      expect(item?.href).toBe(`/docs/${section.id}`);
      expect(item?.external).toBeFalsy();
    }
  });

  it('pins exactly one external API reference to /api-docs', () => {
    const external = DOCS_NAV_ITEMS.filter((i) => i.external);
    expect(external).toHaveLength(1);
    expect(external[0]?.href).toBe('/api-docs');
  });
});
